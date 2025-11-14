// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config');

// --- Configuración de Deriva ---
const CLOCK_DRIFT_RATE = parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
const realStartTime = Date.now();
let lastRealTime = realStartTime;
let lastSimulatedTime = realStartTime;

// --- Configuración del Dispositivo ---
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');

// --- Relojes Lógicos ---
const VECTOR_PROCESS_COUNT = 3; 
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);
let lamportClock = 0;

// --- Sincronización Cristian ---
let clockOffset = 0;
let t1_request_time = 0;
const SYNC_INTERVAL_MS = 30000; 

// --- Exclusión Mutua ---
let sensorState = 'IDLE'; // 'IDLE', 'REQUESTING', 'CALIBRATING'
const CALIBRATION_INTERVAL_MS = 45000 + (Math.random() * 10000);
const CALIBRATION_DURATION_MS = 5000; 

// --- Tópicos y Opciones ---
const statusTopic = config.topics.status(DEVICE_ID);
const lastWillMessage = JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' });
const options = {
  will: {
    topic: statusTopic,
    payload: lastWillMessage,
    qos: 1,
    retain: true,
  },
  clientId: `publisher_${DEVICE_ID}_${Math.random().toString(16).slice(2, 8)}`
};

const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, options);

/**
 * Obtiene el tiempo simulado con deriva.
 */
function getSimulatedTime() {
  const now = Date.now();
  const realElapsed = now - lastRealTime;
  const simulatedElapsed = realElapsed + (realElapsed * CLOCK_DRIFT_RATE / 1000);
  const newSimulatedTime = lastSimulatedTime + simulatedElapsed;
  lastRealTime = now;
  lastSimulatedTime = newSimulatedTime;
  return new Date(Math.floor(newSimulatedTime));
}

/**
 * (Cristian) Solicita la sincronización de hora.
 */
function syncClock() {
  console.log(`[SYNC] ${DEVICE_ID} - Solicitando hora al servidor...`);
  t1_request_time = Date.now();
  const requestPayload = JSON.stringify({ deviceId: DEVICE_ID });
  client.publish(config.topics.time_request, requestPayload, { qos: 0 });
}

/**
 * (Mutex) 1. Intenta solicitar el recurso de calibración
 */
function requestCalibration() {
  if (sensorState === 'IDLE') {
    console.log(`[MUTEX] ${DEVICE_ID} - Solicitando acceso a la Estación de Calibración...`);
    sensorState = 'REQUESTING';
    const payload = JSON.stringify({ deviceId: DEVICE_ID });
    client.publish(config.topics.mutex_request, payload, { qos: 1 });
  } else {
    console.log(`[MUTEX] ${DEVICE_ID} - Ya está en estado '${sensorState}', no se solicita.`);
  }
}

/**
 * (Mutex) 3. Entra en la Sección Crítica (simulada)
 */
function enterCriticalSection() {
  console.log(`[MUTEX] ${DEVICE_ID} - <<< ENTRANDO A SECCIÓN CRÍTICA (Calibrando...) >>>`);
  
  setTimeout(() => {
    console.log(`[MUTEX] ${DEVICE_ID} - <<< SALIENDO DE SECCIÓN CRÍTICA (Calibración terminada) >>>`);
    // 4. Liberar el recurso
    releaseLock();
  }, CALIBRATION_DURATION_MS);
}

/**
 * (Mutex) 5. Libera el recurso
 */
function releaseLock() {
  console.log(`[MUTEX] ${DEVICE_ID} - Liberando el recurso...`);
  sensorState = 'IDLE';
  const payload = JSON.stringify({ deviceId: DEVICE_ID });
  client.publish(config.topics.mutex_release, payload, { qos: 1 });
}

// --- Evento de Conexión ---
client.on('connect', () => {
  console.log(`[INFO] Publisher ${DEVICE_ID} conectado a ${brokerUrl}`);
  console.log(`[INFO] ${DEVICE_ID} - Tasa de deriva: ${CLOCK_DRIFT_RATE} ms/s`);

  // Suscribirse a respuesta de tiempo (Cristian)
  const timeResponseTopic = config.topics.time_response(DEVICE_ID);
  client.subscribe(timeResponseTopic, { qos: 0 }, (err) => {
    if (!err) console.log(`[INFO] ${DEVICE_ID} - Suscrito a respuestas de tiempo en [${timeResponseTopic}]`);
  });

  // Suscribirse a 'grant' de MUTEX
  const grantTopic = config.topics.mutex_grant(DEVICE_ID);
  client.subscribe(grantTopic, { qos: 1 }, (err) => {
    if (!err) {
      console.log(`[INFO] ${DEVICE_ID} - Suscrito a 'grant' de MUTEX en [${grantTopic}]`);
    }
  });

  // Publicar estado online
  const onlineMessage = JSON.stringify({ deviceId: DEVICE_ID, status: 'online' });
  client.publish(statusTopic, onlineMessage, { qos: 1, retain: true }, (err) => {
    if(!err) console.log(`[INFO] ${DEVICE_ID} - Estado 'online' publicado.`);
  });
  
  // Iniciar simulación de telemetría
  console.log(`[INFO] ${DEVICE_ID} - Iniciando simulación de telemetría...`);
  setInterval(publishTelemetry, 5000 + Math.random() * 1000);

  // Iniciar ciclo de sincronización de reloj
  syncClock();
  setInterval(syncClock, SYNC_INTERVAL_MS);

  // Iniciar el ciclo de solicitud de calibración
  setTimeout(() => {
    requestCalibration();
    setInterval(requestCalibration, CALIBRATION_INTERVAL_MS);
  }, 10000 + Math.random() * 10000); 
});

// --- Evento de Recepción de Mensaje ---
client.on('message', (topic, message) => {
  // --- Lógica de Sincronización de Reloj (Cristian) ---
  if (topic === config.topics.time_response(DEVICE_ID)) {
    const t2_response_time = Date.now();
    try {
      const data = JSON.parse(message.toString());
      const serverTime = data.serverTime;
      const rtt = t2_response_time - t1_request_time;
      const correctTime = serverTime + (rtt / 2);
      const simulatedTime = getSimulatedTime().getTime();
      clockOffset = correctTime - simulatedTime;

      console.log(`[SYNC] ${DEVICE_ID} - Sincronización recibida:`);
      console.log(`         RTT: ${rtt} ms, Offset: ${clockOffset.toFixed(0)} ms`);
    } catch (e) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al procesar respuesta de tiempo:`, e.message);
    }
    return; // Salir
  }

  // --- Lógica de Exclusión Mutua (Recepción de Permiso) ---
  if (topic === config.topics.mutex_grant(DEVICE_ID)) {
    if (sensorState === 'REQUESTING') {
      console.log(`[MUTEX] ${DEVICE_ID} - Permiso (GRANT) recibido.`);
      sensorState = 'CALIBRATING';
      enterCriticalSection();
    } else {
      console.warn(`[WARN] ${DEVICE_ID} - Recibió un 'GRANT' pero no estaba en estado 'REQUESTING' (estado actual: ${sensorState})`);
    }
    return; // Salir
  }
});

// --- Evento de Error ---
client.on('error', (error) => {
  console.error(`[ERROR] ${DEVICE_ID} - Error de conexión:`, error);
  client.end();
});

// --- Función de Publicación de Telemetría ---
function publishTelemetry() {
  // Lógica de Relojes (Lamport y Vectorial)
  lamportClock++;
  vectorClock[PROCESS_ID]++;

  // Lógica de Relojes (Cristian)
  const simulatedTime = getSimulatedTime();
  const correctedTime = new Date(simulatedTime.getTime() + clockOffset);

  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: parseFloat((Math.random() * 15 + 10).toFixed(2)),
    humedad: parseFloat((Math.random() * 30 + 35).toFixed(2)),
    
    // Timestamps Físicos
    timestamp: correctedTime.toISOString(),
    timestamp_simulado: simulatedTime.toISOString(),
    clock_offset: clockOffset.toFixed(0),

    // Timestamps Lógicos
    lamport_ts: lamportClock,
    vector_clock: [...vectorClock],

    // Estado de Mutex
    sensor_state: sensorState 
  };

  const message = JSON.stringify(telemetryData);
  const topic = config.topics.telemetry(DEVICE_ID);

  client.publish(topic, message, { qos: 1, retain: false }, (error) => {
    if (error) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al publicar (QoS 1):`, error);
    } else {
      // Log reducido
      // console.log(`[PUB] ${DEVICE_ID} - (Lamport: ${lamportClock}) (Vector: [${vectorClock.join(',')}])`);
    }
  });
}