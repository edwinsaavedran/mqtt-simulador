// /subscriber/persistence-subscriber.js

const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const config = require('../config'); // Nuestra config MQTT

// --- Configuración InfluxDB (leída desde variables de entorno) ---
const influxUrl = process.env.INFLUXDB_URL || 'http://localhost:8086';
const influxToken = process.env.INFLUXDB_TOKEN || 'change-me-local-token';
const influxOrg = process.env.INFLUXDB_ORG || 'utp';
const influxBucket = process.env.INFLUXDB_BUCKET || 'sensors';

// --- Configuración MQTT ---
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const topic = config.topics.telemetry('+'); // Escucha telemetría de todos los dispositivos
const clientId = `persistence_sub_${Math.random().toString(16).slice(2, 8)}`;

// --- Configuración Reloj Vectorial ---
const VECTOR_PROCESS_COUNT = config.topology.getTotalNodes();
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);
const MAX_SKEW_ALLOWED_MS = 2000;

// --- Reloj Lógico de Lamport para el suscriptor ---
let lamportClock = 0;

// --- Inicialización Clientes ---
console.log('[INFO] Iniciando Suscriptor de Persistencia...');

// Cliente InfluxDB
const influxDB = new InfluxDB({ url: influxUrl, token: influxToken });
const writeApi = influxDB.getWriteApi(influxOrg, influxBucket, 'ns'); // Precisión en nanosegundos
console.log(`[INFO] Conectado a InfluxDB: ${influxUrl}, Org: ${influxOrg}, Bucket: ${influxBucket}`);

// Cliente MQTT
const mqttClient = mqtt.connect(brokerUrl, { clientId });

mqttClient.on('connect', () => {
  console.log(`[INFO] Conectado al broker MQTT en ${brokerUrl}`);
  mqttClient.subscribe(topic, { qos: 1 }, (err) => {
    if (!err) {
      console.log(`[INFO] Suscrito a telemetría en: ${topic}`);
    } else {
      console.error('[ERROR] Error al suscribirse a MQTT:', err);
    }
  });
});

mqttClient.on('error', (error) => {
  console.error('[ERROR] Error de conexión MQTT:', error);
});

// --- Procesamiento de Mensajes ---
mqttClient.on('message', (receivedTopic, message) => {
  console.log(`\n[MSG] Mensaje recibido en [${receivedTopic}]`);
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.deviceId;
    const previousLamportClock = lamportClock;
    const senderVectorIndex = config.topology.getVectorIndex(deviceId);

    const receivedLamportTS = Number(data.lamport_ts || 0);
    if (!Number.isFinite(receivedLamportTS)) {
      console.warn('[WARN] Mensaje con lamport_ts inválido, ignorando:', data);
      return;
    }

    const receivedVectorClock = data.vector_clock;
    if (!isValidVectorClock(receivedVectorClock)) {
      console.warn('[WARN] Mensaje con vector_clock inválido, ignorando:', data);
      return;
    }

    if (senderVectorIndex === -1) {
      console.warn(`[WARN] Mensaje de ${deviceId} rechazado: deviceId sin indice vectorial auditable.`);
      return;
    }

    if (!isValidSenderVectorMetadata(data, senderVectorIndex)) {
      console.warn(`[WARN] Mensaje de ${deviceId} rechazado: metadata vectorial inconsistente.`);
      return;
    }

    if (!deviceId || data.temperatura === undefined || data.humedad === undefined) {
      console.warn('[WARN] Mensaje incompleto recibido, ignorando:', data);
      return;
    }

    // --- FILTRO : VALIDACIÓN TEMPORAL ---
    const now = Date.now();
    const msgTime = parseTimestamp(data.timestamp);
    if (msgTime === null) {
      console.warn(`[WARN] Mensaje con timestamp inválido de ${deviceId}, ignorando.`);
      return;
    }

    const skew = msgTime - now;
    const diff = Math.abs(skew);
    let acceptedTimestampMs = msgTime;

    // Caso 1: El mensaje viene del futuro o pasado lejano
    if (diff > MAX_SKEW_ALLOWED_MS) {
      const direction = skew > 0 ? 'future' : 'past';
      if (direction === 'future') {
        console.error(`Rejected future packet from ${deviceId}. Skew: ${diff}ms > ${MAX_SKEW_ALLOWED_MS}ms.`);
      } else {
        console.error(`[UTP-DEFENSE] Rejected past packet from ${deviceId}. Skew: ${diff}ms > ${MAX_SKEW_ALLOWED_MS}ms.`);
      }

      const canRescue = receivedLamportTS > previousLamportClock
        && isSenderVectorProgress(receivedVectorClock, senderVectorIndex);

      if (!canRescue) {
        console.warn(`[UTP-DEFENSE] Temporal rescue rejected for ${deviceId}: Lamport/vector conditions not satisfied.`);
        return; // NO GUARDA EN DB.
      }

      acceptedTimestampMs = now;
      console.warn(`[UTP-DEFENSE] Temporal rescue accepted for ${deviceId}: skew=${diff}ms, lamport=${receivedLamportTS}, vectorIndex=${senderVectorIndex}. Timestamp forced to local persistence time.`);
    }

    // --- REGLA LAMPORT: recepción ---
    lamportClock = Math.max(lamportClock, receivedLamportTS) + 1;
    console.log(`[LAMPORT] Reloj local actualizado a: ${lamportClock} (recibido: ${receivedLamportTS})`);

    // --- REGLA VECTORIAL: fusión observada de relojes de publishers ---
    for (let i = 0; i < VECTOR_PROCESS_COUNT; i++) {
      vectorClock[i] = Math.max(vectorClock[i], receivedVectorClock[i]);
    }

    console.log(`[VECTOR] Reloj local actualizado a: [${vectorClock.join(',')}] (recibido: [${receivedVectorClock.join(',')}])`);
    // --------------------------------------------

    // Crear un punto de datos para InfluxDB
    const point = new Point('sensor_data')
      .tag('device_id', deviceId)
      .floatField('temperature', data.temperatura)
      .floatField('humidity', data.humedad)

      // Relojes Lógicos (Lamport)
      .intField('lamport_ts_sensor', receivedLamportTS)
      .tag('lamport_ts_persistence', lamportClock.toString())
      .tag('vector_index_sensor', senderVectorIndex.toString())

      // InfluxDB no soporta arrays nativos, los guardamos como strings.
      .tag('vector_clock_sensor', JSON.stringify(receivedVectorClock))
      .tag('vector_clock_persistence', JSON.stringify(vectorClock))

      .timestamp(new Date(acceptedTimestampMs));

    console.log(`[DB] Preparando punto para InfluxDB: ${point.toString()}`);

    // Escribir el punto en InfluxDB
    writeApi.writePoint(point);

    // Forzar el envío inmediato de los datos
    writeApi.flush()
      .then(() => {
        console.log('[DB] Punto escrito exitosamente en InfluxDB.');
      })
      .catch(error => {
        console.error('[ERROR] Error al escribir en InfluxDB:', error);
        // En esta sección se podría implementar lógica de reintento o dead-letter queue
      });

  } catch (error) {
    console.error('[ERROR] Error al procesar mensaje MQTT o escribir en DB:', error);
  }
});

function parseTimestamp(timestamp) {
  try {
    const time = new Date(timestamp).getTime();
    return Number.isFinite(time) ? time : null;
  } catch (error) {
    return null;
  }
}

function isValidVectorClock(candidate) {
  return Array.isArray(candidate)
    && candidate.length === VECTOR_PROCESS_COUNT
    && candidate.every(value => Number.isInteger(value) && value >= 0);
}

function isValidSenderVectorMetadata(data, senderVectorIndex) {
  if (data.vectorIndex !== undefined && data.vectorIndex !== senderVectorIndex) return false;
  if (data.processId !== undefined && !Number.isInteger(data.processId)) return false;
  return data.vector_clock[senderVectorIndex] > 0;
}

function isSenderVectorProgress(receivedVectorClock, senderVectorIndex) {
  return receivedVectorClock[senderVectorIndex] > vectorClock[senderVectorIndex];
}

// --- Manejo de Cierre Limpio ---
process.on('SIGINT', async () => {
  console.log('\n[INFO] Cerrando conexiones...');
  mqttClient.end();
  try {
    await writeApi.close();
    console.log('[INFO] Conexión InfluxDB cerrada.');
  } catch (e) {
    console.error('[ERROR] Error cerrando InfluxDB:', e);
  }
  process.exit(0);
});
