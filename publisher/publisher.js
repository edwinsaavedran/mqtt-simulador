// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config');

const fs = require('fs');
const path = require('path');
// Definimos el archivo de log local. 
// En un entorno real usaríamos un volumen compartido, 
// pero para este lab, persistencia local basta para sobrevivir al reinicio.

// --- Configuración Básica ---
const CLOCK_DRIFT_RATE = parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');

const WAL_FILE = path.join(__dirname, `wal_${DEVICE_ID}.log`);
const LOG_FILE = path.join(__dirname, `log_${DEVICE_ID}.log`);

// --- Configuración de Elección (Bully) ---
const MY_PRIORITY = parseInt(process.env.PROCESS_PRIORITY || '0');
const ELECTION_PARTICIPANTS = (process.env.ELECTION_PARTICIPANTS || '').split(',');
const TOTAL_NODES = ELECTION_PARTICIPANTS.length || 5; // Por defecto 5 si no se configura
const QUORUM_SIZE = Math.floor(TOTAL_NODES / 2) + 1; // Mayoría simple (3 de 5)

const LEASE_DURATION = 5000; // 5 segundos de vida
const LEASE_RENEWAL = 2000;  // Renovar cada 2 segundos
let lastLeaseSeen = Date.now();
let leaseInterval = null;
let quorumResponses = 0; // Contador de votos para Quórum

let currentLeaderPriority = 100; // Asumimos que hay alguien superior al inicio
let isCoordinator = false;
let electionInProgress = false;
let lastHeartbeatTime = Date.now();
const HEARTBEAT_INTERVAL = 2000; // Enviar PING cada 2s
const LEADER_TIMEOUT = 5000;     // Líder muerto si no responde en 5s
const ELECTION_TIMEOUT = 3000;   // Tiempo espera respuestas ALIVE

// --- Estado Mutex (Cliente) ---
let sensorState = 'IDLE';
const CALIBRATION_INTERVAL_MS = 20000 + (Math.random() * 5000);
const CALIBRATION_DURATION_MS = 5000;

// --- Estado Mutex (Servidor/Coordinador) - SOLO SE USA SI isCoordinator = true ---
let coord_isLockAvailable = true;
let coord_lockHolder = null;
let coord_waitingQueue = [];

// --- Sincronización Reloj (Cristian, Lamport, Vector) ---
// ... (Variables reducidas para brevedad, la lógica se mantiene)
let lastRealTime = Date.now();
let lastSimulatedTime = Date.now();
let clockOffset = 0;
let lamportClock = 0;
const VECTOR_PROCESS_COUNT = 3;
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);

// --- Conexión MQTT ---
const statusTopic = config.topics.status(DEVICE_ID);
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, {
  clientId: `pub_${DEVICE_ID}_${Math.random().toString(16).slice(2, 5)}`,
  will: { topic: statusTopic, payload: JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), qos: 1, retain: true }
});

// ============================================================================
//                            LÓGICA DEL CICLO DE VIDA
// ============================================================================

client.on('connect', () => {
  console.log(`[INFO] ${DEVICE_ID} (Prio: ${MY_PRIORITY}) conectado.`);

  // 1. Suscripciones Básicas
  client.subscribe(config.topics.time_response(DEVICE_ID));
  client.subscribe(config.topics.mutex_grant(DEVICE_ID));

  // 2. Suscripciones de Elección
  client.subscribe(config.topics.election.heartbeat); // Escuchar PONG
  client.subscribe(config.topics.election.messages);  // Escuchar ELECTION, ALIVE
  client.subscribe(config.topics.election.coordinator); // Escuchar VICTORY

  client.subscribe('election/lease');// topic de arrendamiento

  client.subscribe('election/quorum_check'); // Escuchar CHECK

  client.subscribe('election/quorum_ack'); // Escuchar ACK

  // 3. Iniciar Ciclos
  // A. Telemetría
  setInterval(publishTelemetry, 5000);
  // B. Sincronización Reloj (Cristian)
  setInterval(syncClock, 30000);
  // C. Intentos de Calibración (Cliente Mutex)
  setTimeout(() => { setInterval(requestCalibration, CALIBRATION_INTERVAL_MS); }, 5000);

  // D. Monitoreo del Líder (Heartbeat Check)
  setInterval(checkLeaderStatus, 1000);

  // E. Enviar Heartbeats (PING)
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // Publicar estado online
  client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });
});

client.on('message', (topic, message) => {
  const payload = JSON.parse(message.toString());

  // --- 1. MANEJO DE ELECCIÓN (Bully) ---
  if (topic.startsWith('utp/sistemas_distribuidos/grupo1/election')) {
    handleElectionMessages(topic, payload);
    return;
  }

  // --- 2. SI SOY COORDINADOR: MANEJAR SOLICITUDES MUTEX ---
  if (isCoordinator) {
    if (topic === config.topics.mutex_request) {
      handleCoordRequest(payload.deviceId);
      return;
    }
    if (topic === config.topics.mutex_release) {
      handleCoordRelease(payload.deviceId);
      return;
    }
  }

  // --- 3. SI SOY CLIENTE: MANEJAR RESPUESTAS ---
  if (topic === config.topics.mutex_grant(DEVICE_ID)) {
    if (sensorState === 'REQUESTING') {
      console.log(`[MUTEX-CLIENT] Permiso recibido.`);
      sensorState = 'CALIBRATING';
      enterCriticalSection();
    }
  }

  // --- 4. SINCRONIZACIÓN DE RELOJ (CRISTIAN) ---
  if (topic === config.topics.time_response(DEVICE_ID)) {
    const t4 = Date.now();
    const t1 = payload.t1 || t4;
    const rtt = t4 - t1;

    // UMBRAL DE SEGURIDAD: 500ms
    if (rtt > 500) {
      console.warn(`[CRISTIAN] Sincronización rechazada. RTT alto: ${rtt}ms. Manteniendo offset anterior.`);
      // No actualizamos clockOffset, usamos el último conocido (Degradación Elegante)
      return;
    }

    const serverTime = payload.serverTime;
    const correctTime = serverTime + (rtt / 2);
    clockOffset = correctTime - getSimulatedTime().getTime();
    console.log(`[CRISTIAN] Sincronizado. RTT: ${rtt}ms, Offset: ${clockOffset}ms`);
  }

  // --- GESTIÓN DE LEASE (TITÁN) ---
  if (topic === 'election/lease') {
    const leaseData = JSON.parse(message.toString());
    // Si recibimos un lease válido de alguien con mayor o igual prioridad, respetamos su autoridad
    if (leaseData.priority >= MY_PRIORITY) {
      lastLeaseSeen = Date.now();
      currentLeaderPriority = leaseData.priority;
      if (isCoordinator && leaseData.coordinatorId !== DEVICE_ID) {
        console.warn('[UTP-CONSENSUS] Detectado otro líder con Lease válido. Renunciando...');
        stepDown(); // Función que crearemos abajo
      }
    }
    return;
  }

  if (topic === 'election/quorum_check') {
    // Respondemos que estamos vivos
    client.publish('election/quorum_ack', JSON.stringify({ from: DEVICE_ID }));
  }
  if (topic === 'election/quorum_ack') {
    if (electionInProgress) quorumResponses++; // Solo contamos si estamos intentando ganar
  }

});

// ============================================================================
//                          ALGORITMO DE ELECCIÓN (BULLY)
// ============================================================================

function sendHeartbeat() {
  // Solo enviamos PING si NO somos el coordinador
  if (!isCoordinator) {
    client.publish(config.topics.election.heartbeat, JSON.stringify({ type: 'PING', fromPriority: MY_PRIORITY }));
  }
}

function checkLeaderStatus() {
  if (isCoordinator) return; // Si soy líder, no monitoreo a nadie

  // Si pasó mucho tiempo desde el último PONG o mensaje del líder
  // if (Date.now() - lastHeartbeatTime > LEADER_TIMEOUT) {
  //   console.warn(`[BULLY] ¡Líder caído! (Timeout). Iniciando elección.`);
  //   startElection();
  // }

  // Regla de Lease: Si pasaron 5s sin renovación, el líder está muerto.
  if (Date.now() - lastLeaseSeen > LEASE_DURATION) {
    console.warn(`[UTP-CONSENSUS] Lease del líder expiró hace ${Date.now() - lastLeaseSeen}ms. Iniciando elección.`);
    startElection();
  }
}

function startElection() {
  if (electionInProgress) return;
  electionInProgress = true;
  lastHeartbeatTime = Date.now(); // Reset timer para no spammear

  console.log(`[BULLY] Convocando elección... Buscando nodos con prioridad > ${MY_PRIORITY}`);

  // 1. Enviar mensaje ELECTION a todos los nodos con prioridad superior
  client.publish(config.topics.election.messages, JSON.stringify({
    type: 'ELECTION',
    fromPriority: MY_PRIORITY
  }));

  // 2. Esperar respuesta (ALIVE)
  setTimeout(() => {
    if (electionInProgress) {
      // Si llegamos aquí y electionInProgress sigue true, es que NADIE respondió ALIVE.
      // ¡Significa que somos el nodo vivo con mayor prioridad!
      declareVictory();
    }
  }, ELECTION_TIMEOUT);
}

function handleElectionMessages(topic, payload) {
  // A. HEARTBEATS
  if (topic === config.topics.election.heartbeat) {
    if (payload.type === 'PONG' && payload.fromPriority > MY_PRIORITY) {
      // El líder respondió, todo está bien.
      lastHeartbeatTime = Date.now();
    }
    return;
  }

  // B. MENSAJES DE ELECCIÓN
  if (topic === config.topics.election.messages) {
    // Si alguien con MENOR prioridad inicia elección, le decimos que estamos vivos
    if (payload.type === 'ELECTION' && payload.fromPriority < MY_PRIORITY) {
      console.log(`[BULLY] Recibida elección de inferior (${payload.fromPriority}). Enviando ALIVE.`);
      client.publish(config.topics.election.messages, JSON.stringify({
        type: 'ALIVE', toPriority: payload.fromPriority, fromPriority: MY_PRIORITY
      }));
      // E iniciamos nuestra propia elección por si acaso el líder real murió
      startElection();
    }
    // Si recibimos ALIVE de alguien SUPERIOR, nos callamos y esperamos
    else if (payload.type === 'ALIVE' && payload.fromPriority > MY_PRIORITY) {
      console.log(`[BULLY] Recibido ALIVE de superior (${payload.fromPriority}). Me retiro.`);
      electionInProgress = false; // Dejamos de intentar ser líderes
    }
    return;
  }

  // C. ANUNCIO DE COORDINADOR (VICTORY)
  if (topic === config.topics.election.coordinator) {
    console.log(`[BULLY] Nuevo Coordinador electo: ${payload.coordinatorId} (Prio: ${payload.priority})`);
    currentLeaderPriority = payload.priority;
    lastHeartbeatTime = Date.now(); // El líder está vivo
    electionInProgress = false;

    // Chequear si soy yo (por si acaso)
    if (payload.priority === MY_PRIORITY) {
      becomeCoordinator();
    } else {
      isCoordinator = false;
      // Dejar de escuchar peticiones de mutex si antes era coordinador
      client.unsubscribe(config.topics.mutex_request);
      client.unsubscribe(config.topics.mutex_release);
    }
  }
}

// function declareVictory() {
//   console.log(`[BULLY] ¡Nadie superior respondió! ME DECLARO COORDINADOR.`);
//   const msg = JSON.stringify({ type: 'VICTORY', coordinatorId: DEVICE_ID, priority: MY_PRIORITY });
//   client.publish(config.topics.election.coordinator, msg, { retain: true });
//   becomeCoordinator();
// }

function declareVictory() {
  console.log(`[UTP-CONSENSUS] Candidato único detectado. Verificando QUÓRUM (${QUORUM_SIZE} nodos requeridos)...`);

  // Iniciamos conteo
  quorumResponses = 1; // Me cuento a mí mismo

  // Enviamos solicitud de presencia
  client.publish('election/quorum_check', JSON.stringify({ candidateId: DEVICE_ID }));

  // Esperamos 1.5 segundos a ver quién responde
  setTimeout(() => {
    if (quorumResponses >= QUORUM_SIZE) {
      console.log(`[UTP-CONSENSUS] Quórum alcanzado (${quorumResponses}/${TOTAL_NODES}). Asumiendo Liderazgo.`);
      performVictory(); // La vieja lógica de becomeCoordinator va aquí
    } else {
      console.error(`[UTP-CONSENSUS] FALLO DE QUÓRUM. Solo ${quorumResponses} nodos visibles. No puedo ser líder.`);
      // No hacemos nada, esperamos o reintentamos luego
      stepDown();
    }
  }, 1500);
}

function becomeCoordinator() {
  if (isCoordinator) return;
  isCoordinator = true;
  electionInProgress = false;
  console.log(`[ROLE] *** ASCENDIDO A COORDINADOR DE BLOQUEO ***`);

  // Reiniciar estado del mutex (para evitar bloqueos heredados)
  coord_isLockAvailable = true;
  coord_lockHolder = null;
  coord_waitingQueue = [];

  // Suscribirse a los tópicos que debe escuchar el líder
  client.subscribe(config.topics.mutex_request, { qos: 1 });
  client.subscribe(config.topics.mutex_release, { qos: 1 });

  recoverFromWal();

  // Publicar estado inicial
  publishCoordStatus();
}

// ============================================================================
//                  LÓGICA DE SERVIDOR MUTEX (Solo si isCoordinator)
// ============================================================================
// (Esta lógica es idéntica a la de lock-coordinator.js, ahora embebida aquí)

function handleCoordRequest(requesterId) {
  console.log(`[COORD] Procesando solicitud de: ${requesterId}`);
  if (coord_isLockAvailable) {
    // [TITÁN] LOG GRANT
    appendToWal('GRANT', { id: requesterId });
    grantCoordLock(requesterId);
  } else {
    if (!coord_waitingQueue.includes(requesterId) && coord_lockHolder !== requesterId) {
      // [TITÁN] LOG QUEUE
      appendToWal('QUEUE', { id: requesterId });
      coord_waitingQueue.push(requesterId);
    }
  }
  publishCoordStatus();
}

function handleCoordRelease(requesterId) {
  if (coord_lockHolder === requesterId) {
    // [TITÁN] LOG RELEASE
    appendToWal('RELEASE', { id: requesterId });

    coord_lockHolder = null;
    coord_isLockAvailable = true;

    if (coord_waitingQueue.length > 0) {
      const nextId = coord_waitingQueue.shift();
      // [TITÁN] LOG GRANT (al siguiente)
      appendToWal('GRANT', { id: nextId });
      grantCoordLock(nextId);
    }
  }
  publishCoordStatus();
}

function grantCoordLock(requesterId) {
  coord_isLockAvailable = false;
  coord_lockHolder = requesterId;
  client.publish(config.topics.mutex_grant(requesterId), JSON.stringify({ status: 'granted' }), { qos: 1 });
}

function publishCoordStatus() {
  client.publish(config.topics.mutex_status, JSON.stringify({
    isAvailable: coord_isLockAvailable,
    holder: coord_lockHolder,
    queue: coord_waitingQueue
  }), { retain: true });
}

// ============================================================================
//                            FUNCIONES AUXILIARES
// ============================================================================

function getSimulatedTime() {
  const now = Date.now();
  const realElapsed = now - lastRealTime;
  const simulatedElapsed = realElapsed + (realElapsed * CLOCK_DRIFT_RATE / 1000);
  lastSimulatedTime = lastSimulatedTime + simulatedElapsed;
  lastRealTime = now;
  return new Date(Math.floor(lastSimulatedTime));
}

function syncClock() {
  const payload = JSON.stringify({ deviceId: DEVICE_ID, t1: Date.now() });
  client.publish(config.topics.time_request, payload, { qos: 0 });
}

function requestCalibration() {
  if (sensorState === 'IDLE' && !isCoordinator) { // El coordinador no se auto-solicita en este ejemplo simple
    console.log(`[MUTEX-CLIENT] Solicitando...`);
    sensorState = 'REQUESTING';
    client.publish(config.topics.mutex_request, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
  }
}

function enterCriticalSection() {
  setTimeout(() => {
    console.log(`[MUTEX-CLIENT] Fin calibración.`);
    releaseLock();
  }, CALIBRATION_DURATION_MS);
}

function releaseLock() {
  sensorState = 'IDLE';
  client.publish(config.topics.mutex_release, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
}

function publishTelemetry() {
  lamportClock++;
  vectorClock[PROCESS_ID]++;
  const correctedTime = new Date(getSimulatedTime().getTime() + clockOffset);

  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: (Math.random() * 30).toFixed(2),
    humedad: (Math.random() * 100).toFixed(2),
    timestamp: correctedTime.toISOString(),
    timestamp_simulado: getSimulatedTime().toISOString(),
    clock_offset: clockOffset.toFixed(0),
    lamport_ts: lamportClock,
    vector_clock: [...vectorClock],
    sensor_state: isCoordinator ? 'COORDINATOR' : sensorState // Mostrar rol especial si es líder
  };
  client.publish(config.topics.telemetry(DEVICE_ID), JSON.stringify(telemetryData));
}

function performVictory() {
  // Publicar Victoria (Retained)
  const msg = JSON.stringify({ type: 'VICTORY', coordinatorId: DEVICE_ID, priority: MY_PRIORITY });
  client.publish(config.topics.election.coordinator, msg, { qos: 1, retain: true });

  becomeCoordinator();

  // Iniciar renovación de Lease
  if (leaseInterval) clearInterval(leaseInterval);
  leaseInterval = setInterval(() => {
    client.publish('election/lease', JSON.stringify({
      coordinatorId: DEVICE_ID,
      priority: MY_PRIORITY,
      timestamp: Date.now()
    }));
  }, LEASE_RENEWAL);
}

function stepDown() {
  isCoordinator = false;
  if (leaseInterval) clearInterval(leaseInterval);
  console.log('[ROLE] Regresando a estado FOLLOWER.');
}

// --- PERSISTENCIA WAL ( FASE 3) ---

function appendToWal(operation, data) {
  const entry = `${Date.now()}|${operation}|${JSON.stringify(data)}\n`;
  try {
    // appendFileSync es bloqueante para garantizar Atomicidad (Write-Ahead)
    fs.appendFileSync(WAL_FILE, entry);
  } catch (e) {
    console.error(`[WAL] Error crítico escribiendo en disco: ${e.message}`);
  }
}

function recoverFromWal() {
  if (!fs.existsSync(WAL_FILE)) {
    console.log('[WAL] No existe log previo. Iniciando limpio.');
    return;
  }

  console.log(`[WAL] Encontrado log de recuperación: ${WAL_FILE}. Reconstruyendo estado...`);

  const fileContent = fs.readFileSync(WAL_FILE, 'utf-8');
  const lines = fileContent.split('\n');

  // Reiniciamos estado en memoria antes de procesar
  coord_waitingQueue = [];
  coord_lockHolder = null;
  coord_isLockAvailable = true;

  lines.forEach(line => {
    if (!line.trim()) return;
    const [ts, op, json] = line.split('|');
    const data = JSON.parse(json);

    if (op === 'QUEUE') {
      if (!coord_waitingQueue.includes(data.id) && coord_lockHolder !== data.id) {
        coord_waitingQueue.push(data.id);
      }
    } else if (op === 'GRANT') {
      coord_lockHolder = data.id;
      coord_isLockAvailable = false;
      // Si estaba en cola, lo sacamos
      coord_waitingQueue = coord_waitingQueue.filter(id => id !== data.id);
    } else if (op === 'RELEASE') {
      if (coord_lockHolder === data.id) {
        coord_lockHolder = null;
        coord_isLockAvailable = true;
      }
    }
  });

  console.log(`[WAL] Recuperación completada. Holder: ${coord_lockHolder}, Cola: [${coord_waitingQueue}]`);
}