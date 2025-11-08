// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config');

// --- NUEVO: Configuración de la deriva de reloj ---
// Lee la tasa de deriva (ms por segundo) desde el entorno.
// Ej: 500 = gana 500ms (medio segundo) por cada segundo real.
// Ej: -500 = pierde 500ms por cada segundo real.
const CLOCK_DRIFT_RATE = parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
// Guardamos el momento real en que el proceso inició
const realStartTime = Date.now();
let lastRealTime = realStartTime;
let lastSimulatedTime = realStartTime;

// El Device ID sigue viniendo del entorno
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';

// --- Configuración Reloj Vectorial ---
/** El número total de procesos en nuestro sistema lógico */
const VECTOR_PROCESS_COUNT = 3;
/** El ID de este proceso (leído del entorno) */
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');
/** Nuestro reloj vectorial local. Inicializado con ceros. */
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);

// --- NUEVO: Reloj Lógico de Lamport ---
let lamportClock = 0;

// variables para la sincronización de tiempo - Algoritmo de Cristian
/** Almacena la diferencia (en ms) entre el reloj del servidor y nuestro reloj simulado. */
let clockOffset = 0;
/** Almacena el T1 (tiempo de envío) de nuestra solicitud de tiempo para calcular el RTT. */
let t1_request_time = 0;

const SYNC_INTERVAL_MS = 30000; // Sincronizar cada 30 segundos

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
 * --- NUEVO: Función para obtener el tiempo simulado ---
 * Esta función calcula el tiempo actual con la deriva aplicada.
 */
function getSimulatedTime() {
  const now = Date.now();
  // Cuántos ms reales han pasado desde el último cálculo
  const realElapsed = now - lastRealTime;
  
  // Cuánto debería haber avanzado nuestro reloj simulado (con deriva)
  // (realElapsed / 1000) = segundos reales pasados
  // (realElapsed / 1000) * CLOCK_DRIFT_RATE = deriva total en este intervalo
  const simulatedElapsed = realElapsed + (realElapsed * CLOCK_DRIFT_RATE / 1000);
  
  // Calculamos el nuevo tiempo simulado
  const newSimulatedTime = lastSimulatedTime + simulatedElapsed;

  // Actualizamos los valores para el próximo cálculo
  lastRealTime = now;
  lastSimulatedTime = newSimulatedTime;
  
  // Devolvemos el tiempo simulado como un objeto Date
  return new Date(Math.floor(newSimulatedTime));
}

// --- NUEVO: Función para sincronizar el reloj con el servidor de tiempo ---
function syncClock() {
  console.log(`[SYNC] ${DEVICE_ID} - Solicitando hora al servidor...`);
  
  // 1. Guardamos el tiempo T1 (usando el reloj REAL para medir RTT)
  t1_request_time = Date.now();
  
  // 2. Publicamos la solicitud en el tópico de request
  const requestPayload = JSON.stringify({ deviceId: DEVICE_ID });
  client.publish(config.topics.time_request, requestPayload, { qos: 0 });
}

// --- Manejo de la conexión MQTT ---
client.on('connect', () => {
  console.log(`[INFO] Publisher ${DEVICE_ID} conectado al broker en ${brokerUrl}`);
  // Mostramos la deriva configurada
  console.log(`[INFO] ${DEVICE_ID} - Tasa de deriva: ${CLOCK_DRIFT_RATE} ms/s`);

  // Iniciamos la sincronización periódica del reloj
  const timeResponseTopic = config.topics.time_response(DEVICE_ID);
  client.subscribe(timeResponseTopic, { qos: 0 }, (err) => {
    if (!err) {
      console.log(`[INFO] ${DEVICE_ID} - Suscrito a respuestas de tiempo en [${timeResponseTopic}]`);
    }
  });

  // Publicamos el estado "online" al conectarnos
  const onlineMessage = JSON.stringify({ deviceId: DEVICE_ID, status: 'online' });
  client.publish(statusTopic, onlineMessage, { qos: 1, retain: true }, (error) => {
    if (error) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al publicar estado "online":`, error);
    } else {
      console.log(`[INFO] ${DEVICE_ID} - Estado 'online' publicado en [${statusTopic}]`);
    }
  });

  console.log(`[INFO] ${DEVICE_ID} - Iniciando simulación...`);
  setInterval(publishTelemetry, 5000 + Math.random() * 1000);

  // Sincronizar una vez al inicio y luego cada SYNC_INTERVAL_MS
  syncClock();
  setInterval(syncClock, SYNC_INTERVAL_MS);
});

// --- Manejo de mensajes entrantes (respuestas de tiempo) ---
client.on('message', (topic, message) => {
  // Verificamos si es un mensaje de respuesta de tiempo
  if (topic === config.topics.time_response(DEVICE_ID)) {
    // 3. Registramos T2 (tiempo de recepción)
    const t2_response_time = Date.now();
    
    try {
      const data = JSON.parse(message.toString());
      const serverTime = data.serverTime; // $T_s$

      // 4. Calculamos RTT
      const rtt = t2_response_time - t1_request_time;
      
      // 5. Calculamos el tiempo correcto (Algoritmo de Cristian)
      // T_correcto = T_servidor + (RTT / 2)
      const correctTime = serverTime + (rtt / 2);

      // 6. Obtenemos nuestro reloj simulado "falso"
      const simulatedTime = getSimulatedTime().getTime();

      // 7. Calculamos y guardamos el offset
      // Offset = T_correcto - T_simulado
      clockOffset = correctTime - simulatedTime;

      console.log(`[SYNC] ${DEVICE_ID} - Sincronización recibida:`);
      console.log(`         RTT: ${rtt} ms`);
      console.log(`         T_Correcto: ${new Date(correctTime).toISOString()}`);
      console.log(`         T_Simulado: ${new Date(simulatedTime).toISOString()}`);
      console.log(`         ==> Offset: ${clockOffset.toFixed(0)} ms`);

    } catch (e) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al procesar respuesta de tiempo:`, e.message);
    }
  }
});

// Manejo de errores
client.on('error', (error) => {
  console.error(`[ERROR] ${DEVICE_ID} - Error de conexión:`, error);
  client.end();
});

function publishTelemetry() {

  // --- REGLA 1 (LAMPORT): Evento interno ---
  // Incrementamos nuestro reloj lógico ANTES de cualquier otra cosa.
  lamportClock++;

  // --- REGLA 1 (VECTORIAL): Evento interno ---
  // Incrementamos nuestra propia posición en el vector.
  vectorClock[PROCESS_ID]++;

  // SIMULACION - LOGICA DE CRISTIAN
  const simulatedTime = getSimulatedTime();
  // Aplicamos el offset calculado para obtener el tiempo corregido
  const correctedTime = new Date(simulatedTime.getTime() + clockOffset);

  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: parseFloat((Math.random() * 15 + 10).toFixed(2)),
    humedad: parseFloat((Math.random() * 30 + 35).toFixed(2)),

    // Timestamps Físicos (de Cristian)
    timestamp: correctedTime.toISOString(),
    timestamp_simulado: simulatedTime.toISOString(),
    clock_offset: clockOffset.toFixed(0),

    // Timestamp Lógico (Lamport)
    lamport_ts: lamportClock,

    // --- REGLA 2 (VECTORIAL): Enviar reloj ---
    // Enviamos una COPIA de nuestro reloj vectorial actual
    vector_clock: [...vectorClock]
  };

  const message = JSON.stringify(telemetryData);
  const topic = config.topics.telemetry(DEVICE_ID);

  client.publish(topic, message, { qos: 1, retain: false }, (error) => {
    if (error) {
      //console.error(`[ERROR] ${DEVICE_ID} - Error al publicar (QoS 1):`, error);
      console.error(`[ERROR] ${DEVICE_ID} - Error al publicar (QoS 1):`, error);
    } else {
      //console.log(`[PUB] ${DEVICE_ID} - Mensaje publicado en [${topic}] (QoS 1):`, message);
      //console.log(`[PUB] ${DEVICE_ID} - T_Corregido: ${correctedTime.toISOString()}`);
      //console.log(`[PUB] ${DEVICE_ID} - T_Corregido: ${correctedTime.toISOString()} (Lamport: ${lamportClock})`);
      //console.log(`[PUB] ${DEVICE_ID} - T_Corregido: ${correctedTime.toISOString()} (Lamport: ${lamportClock}) (Vector: [${vectorClock.join(',')}])`);
      console.log(`[PUB] ${DEVICE_ID} - (Lamport: ${lamportClock}) (Vector: [${vectorClock.join(',')}])`);
    }
  });
}