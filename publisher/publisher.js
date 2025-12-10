const mqtt = require('mqtt');
const config = require('../config');
const fs = require('fs');
const path = require('path');

// 1. DEFINICIONES Y CONFIGURACIÓN (CRÍTICO: Hoisting)
const CLOCK_DRIFT_RATE = parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');

// Archivos de Log y WAL
const WAL_FILE = path.join(__dirname, `wal_${DEVICE_ID}.log`);
const LOG_FILE = path.join(__dirname, `log_${DEVICE_ID}.log`);

// --- Configuración de Elección (Bully + Titán) ---
const MY_PRIORITY = parseInt(process.env.PROCESS_PRIORITY || '0');
const ELECTION_PARTICIPANTS = (process.env.ELECTION_PARTICIPANTS || '').split(',');
const TOTAL_NODES = ELECTION_PARTICIPANTS.length || 5;
const QUORUM_SIZE = Math.floor(TOTAL_NODES / 2) + 1;

const LEASE_DURATION = 5000;
const LEASE_RENEWAL = 2000;
let lastLeaseSeen = Date.now();
let leaseInterval = null;
let quorumResponses = 0;

let currentLeaderPriority = 100;
let isCoordinator = false;
let electionInProgress = false;
let lastHeartbeatTime = Date.now();
const HEARTBEAT_INTERVAL = 2000;
const LEADER_TIMEOUT = 5000;
const ELECTION_TIMEOUT = 3000;

// --- Estado Mutex (Cliente) ---
let sensorState = 'IDLE';
const CALIBRATION_INTERVAL_MS = 20000 + (Math.random() * 5000);
const CALIBRATION_DURATION_MS = 5000;

// --- Estado Mutex (Servidor/Coordinador) ---
let coord_isLockAvailable = true;
let coord_lockHolder = null;
let coord_waitingQueue = [];

// --- Sincronización Reloj ---
let lastRealTime = Date.now();
let lastSimulatedTime = Date.now();
let clockOffset = 0;
let lamportClock = 0;
const VECTOR_PROCESS_COUNT = 3; // Ajustable según topología
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);

// --- ESTADO DE CAOS (Interruptor de Muerte) ---
let isSimulatingFailure = false;

// --- Conexión MQTT ---
const statusTopic = config.topics.status(DEVICE_ID);
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, {
  clientId: `pub_${DEVICE_ID}_${Math.random().toString(16).slice(2, 5)}`,
  will: { topic: statusTopic, payload: JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), qos: 1, retain: true }
});

// ============================================================================
//                            CICLO DE VIDA
// ============================================================================

client.on('connect', () => {
  console.log(`[INFO] ${DEVICE_ID} (Prio: ${MY_PRIORITY}) conectado.`);

  // Suscripciones
  client.subscribe(config.topics.time_response(DEVICE_ID));
  client.subscribe(config.topics.mutex_grant(DEVICE_ID));
  client.subscribe(config.topics.election.heartbeat);
  client.subscribe(config.topics.election.messages);
  client.subscribe(config.topics.election.coordinator);
  client.subscribe('election/lease');
  client.subscribe('election/quorum_check');
  client.subscribe('election/quorum_ack');

  // Suscripción a Canal de Caos
  client.subscribe('utp/sistemas_distribuidos/grupo1/chaos/control');

  // Iniciar Loops
  setInterval(publishTelemetry, 5000);
  setInterval(syncClock, 30000);
  setTimeout(() => { setInterval(requestCalibration, CALIBRATION_INTERVAL_MS); }, 5000);
  setInterval(checkLeaderStatus, 1000);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });
});

client.on('message', (topic, message) => {
  // 1. INTERCEPTOR DE CAOS
  if (topic.includes('chaos/control')) {
    try {
      const command = JSON.parse(message.toString());
      if (command.targetId === DEVICE_ID) {
        if (command.action === 'KILL') {
          console.warn(`[CHAOS] COMANDO KILL RECIBIDO. Apagando funciones vitales.`);
          isSimulatingFailure = true;
          client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), { retain: true });
        } else if (command.action === 'REVIVE') {
          console.log(`[CHAOS] COMANDO REVIVE RECIBIDO. Restaurando sistema.`);
          isSimulatingFailure = false;
          lastLeaseSeen = 0; // Forzar resincronización
          recoverFromWal();  // Restaurar memoria
          client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });
        }
      }
    } catch (e) { console.error("Error parseando caos:", e); }
    return;
  }

  // Si está "muerto", no procesa nada más
  if (isSimulatingFailure) return;

  const payload = JSON.parse(message.toString());

  // 2. LÓGICA DE NEGOCIO (Solo si está vivo)
  if (topic.startsWith('utp/sistemas_distribuidos/grupo1/election')) {
    handleElectionMessages(topic, payload);
    return;
  }

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

  if (topic === config.topics.mutex_grant(DEVICE_ID)) {
    if (sensorState === 'REQUESTING') {
      sensorState = 'CALIBRATING';
      enterCriticalSection();
    }
  }

  // Algoritmo Cristian Mejorado
  if (topic === config.topics.time_response(DEVICE_ID)) {
    const t4 = Date.now();
    const t1 = payload.t1 || t4;
    const rtt = t4 - t1;
    if (rtt > 500) return; // Rechazar si latencia es alta
    const serverTime = payload.serverTime;
    const correctTime = serverTime + (rtt / 2);
    clockOffset = correctTime - getSimulatedTime().getTime();
  }

  // Lease y Quórum
  if (topic === 'election/lease') {
    const leaseData = payload; // Ya parseado arriba
    if (leaseData.priority >= MY_PRIORITY) {
      lastLeaseSeen = Date.now();
      currentLeaderPriority = leaseData.priority;
      if (isCoordinator && leaseData.coordinatorId !== DEVICE_ID) {
        stepDown();
      }
    }
  }
  if (topic === 'election/quorum_check') {
    client.publish('election/quorum_ack', JSON.stringify({ from: DEVICE_ID }));
  }
  if (topic === 'election/quorum_ack') {
    if (electionInProgress) quorumResponses++;
  }
});

// ============================================================================
//                          ALGORITMOS DISTRIBUIDOS
// ============================================================================

function sendHeartbeat() {
  if (isSimulatingFailure) return;
  if (!isCoordinator) {
    client.publish(config.topics.election.heartbeat, JSON.stringify({ type: 'PING', fromPriority: MY_PRIORITY }));
  }
}

function checkLeaderStatus() {
  if (isSimulatingFailure || isCoordinator) return;
  // Detección de Falla por Expiración de Lease (Heartbeat estricto)
  if (Date.now() - lastLeaseSeen > LEASE_DURATION) {
    console.warn(`[UTP] Lease expirado. Iniciando elección.`);
    startElection();
  }
}

function startElection() {
  if (electionInProgress) return;
  electionInProgress = true;
  lastHeartbeatTime = Date.now();
  client.publish(config.topics.election.messages, JSON.stringify({ type: 'ELECTION', fromPriority: MY_PRIORITY }));

  setTimeout(() => {
    if (electionInProgress) declareVictory();
  }, ELECTION_TIMEOUT);
}

function handleElectionMessages(topic, payload) {
  if (topic === config.topics.election.messages) {
    if (payload.type === 'ELECTION' && payload.fromPriority < MY_PRIORITY) {
      client.publish(config.topics.election.messages, JSON.stringify({ type: 'ALIVE', toPriority: payload.fromPriority, fromPriority: MY_PRIORITY }));
      startElection();
    }
    else if (payload.type === 'ALIVE' && payload.fromPriority > MY_PRIORITY) {
      electionInProgress = false;
    }
  }
  if (topic === config.topics.election.coordinator) {
    currentLeaderPriority = payload.priority;
    lastHeartbeatTime = Date.now();
    electionInProgress = false;
    if (payload.priority === MY_PRIORITY) becomeCoordinator();
    else if (isCoordinator) stepDown();
  }
}

function declareVictory() {
  // Lógica de Quórum
  quorumResponses = 1;
  client.publish('election/quorum_check', JSON.stringify({ candidateId: DEVICE_ID }));
  setTimeout(() => {
    if (quorumResponses >= QUORUM_SIZE) performVictory();
    else stepDown();
  }, 1500);
}

function performVictory() {
  const msg = JSON.stringify({ type: 'VICTORY', coordinatorId: DEVICE_ID, priority: MY_PRIORITY });
  client.publish(config.topics.election.coordinator, msg, { qos: 1, retain: true });
  becomeCoordinator();

  if (leaseInterval) clearInterval(leaseInterval);
  leaseInterval = setInterval(() => {
    if (!isSimulatingFailure) {
      client.publish('election/lease', JSON.stringify({ coordinatorId: DEVICE_ID, priority: MY_PRIORITY, timestamp: Date.now() }));
    }
  }, LEASE_RENEWAL);
}

function becomeCoordinator() {
  if (isCoordinator) return;
  isCoordinator = true;
  electionInProgress = false;

  coord_isLockAvailable = true;
  coord_lockHolder = null;
  coord_waitingQueue = [];

  client.subscribe(config.topics.mutex_request, { qos: 1 });
  client.subscribe(config.topics.mutex_release, { qos: 1 });

  recoverFromWal(); // Persistencia
  publishCoordStatus();
}

function stepDown() {
  isCoordinator = false;
  if (leaseInterval) clearInterval(leaseInterval);
  client.unsubscribe(config.topics.mutex_request);
  client.unsubscribe(config.topics.mutex_release);
}

// --- SERVIDOR MUTEX CON WAL ---

function handleCoordRequest(requesterId) {
  if (isSimulatingFailure) return;
  if (coord_isLockAvailable) {
    appendToWal('GRANT', { id: requesterId });
    grantCoordLock(requesterId);
  } else {
    if (!coord_waitingQueue.includes(requesterId) && coord_lockHolder !== requesterId) {
      appendToWal('QUEUE', { id: requesterId });
      coord_waitingQueue.push(requesterId);
    }
  }
  publishCoordStatus();
}

function handleCoordRelease(requesterId) {
  if (isSimulatingFailure) return;
  if (coord_lockHolder === requesterId) {
    appendToWal('RELEASE', { id: requesterId });
    coord_lockHolder = null;
    coord_isLockAvailable = true;
    if (coord_waitingQueue.length > 0) {
      const nextId = coord_waitingQueue.shift();
      appendToWal('GRANT', { id: nextId });
      grantCoordLock(nextId);
    }
  }
  publishCoordStatus();
}

function grantCoordLock(requesterId) {
  coord_isLockAvailable = false;
  coord_lockHolder = requesterId;

  // --- Timeout de seguridad ---
  setTimeout(() => {
    if (coord_lockHolder === requesterId) {
      console.warn(`[WATCHDOG] El nodo ${requesterId} tardó demasiado. Revocando Lock.`);
      handleCoordRelease(requesterId); // Forzar liberación
    }
  }, CALIBRATION_DURATION_MS + 2000); // Dar un margen de seguridad

  client.publish(config.topics.mutex_grant(requesterId), JSON.stringify({ status: 'granted' }), { qos: 1 });
}

function publishCoordStatus() {
  if (isSimulatingFailure) return;
  client.publish(config.topics.mutex_status, JSON.stringify({ isAvailable: coord_isLockAvailable, holder: coord_lockHolder, queue: coord_waitingQueue }), { retain: true });
}

// --- PERSISTENCIA (FILE SYSTEM) ---

function appendToWal(operation, data) {
  const entry = `${Date.now()}|${operation}|${JSON.stringify(data)}\n`;
  try { fs.appendFileSync(WAL_FILE, entry); } catch (e) { console.error(`[WAL] Error: ${e.message}`); }
}

function recoverFromWal() {
  if (!fs.existsSync(WAL_FILE)) return;
  const fileContent = fs.readFileSync(WAL_FILE, 'utf-8');
  const lines = fileContent.split('\n');

  // Reiniciar estado en memoria
  coord_waitingQueue = [];
  coord_lockHolder = null;
  coord_isLockAvailable = true;

  lines.forEach(line => {
    if (!line.trim()) return;
    const parts = line.split('|');
    const op = parts[1];
    const data = JSON.parse(parts[2]);

    if (op === 'QUEUE') {
      if (!coord_waitingQueue.includes(data.id) && coord_lockHolder !== data.id) coord_waitingQueue.push(data.id);
    } else if (op === 'GRANT') {
      coord_lockHolder = data.id;
      coord_isLockAvailable = false;
      coord_waitingQueue = coord_waitingQueue.filter(id => id !== data.id);
    } else if (op === 'RELEASE') {
      if (coord_lockHolder === data.id) {
        coord_lockHolder = null;
        coord_isLockAvailable = true;
      }
    }
  });
  console.log(`[WAL] Estado restaurado. Queue: ${coord_waitingQueue.length}`);
}

// --- TELEMETRÍA ---
function publishTelemetry() {
  if (isSimulatingFailure) return;
  lamportClock++;

  // Actualizar mi propia posición en el vector
  if (vectorClock[PROCESS_ID]) vectorClock[PROCESS_ID]++;
  else vectorClock[PROCESS_ID] = 1;

  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: (20 + Math.random() * 5).toFixed(2),
    humedad: (50 + Math.random() * 10).toFixed(2),
    timestamp: new Date().toISOString(),
    lamport_ts: lamportClock,
    vector_clock: vectorClock,
    sensor_state: isCoordinator ? 'COORDINATOR' : sensorState
  };
  client.publish(config.topics.telemetry(DEVICE_ID), JSON.stringify(telemetryData));
}

function getSimulatedTime() { return new Date(); } // Placeholder simple
function syncClock() { if (!isSimulatingFailure) client.publish(config.topics.time_request, JSON.stringify({ t1: Date.now() })); }
function requestCalibration() {
  if (!isSimulatingFailure && sensorState === 'IDLE' && !isCoordinator) {
    sensorState = 'REQUESTING';
    client.publish(config.topics.mutex_request, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
  }
}
function enterCriticalSection() {
  setTimeout(() => { if (!isSimulatingFailure) releaseLock(); }, CALIBRATION_DURATION_MS);
}
function releaseLock() {
  sensorState = 'IDLE';
  client.publish(config.topics.mutex_release, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
}