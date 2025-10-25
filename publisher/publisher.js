// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config');

// --- CAMBIO: Leer DEVICE_ID desde variable de entorno ---
// Si la variable de entorno DEVICE_ID no está definida, usará 'sensor-default'
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';

// Definimos el mensaje y tópico para el LWT *usando el DEVICE_ID dinámico*
const statusTopic = config.topics.status(DEVICE_ID);
const lastWillMessage = JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' });

const options = {
  will: {
    topic: statusTopic,
    payload: lastWillMessage,
    qos: 1,
    retain: true,
  },
  // --- OPCIONAL pero RECOMENDADO: Añadir un clientId único ---
  // Esto ayuda al broker a distinguir las conexiones
  clientId: `publisher_${DEVICE_ID}_${Math.random().toString(16).slice(2, 8)}`
};

const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, options);

client.on('connect', () => {
  // --- Usamos `` para incluir el DEVICE_ID en los logs ---
  console.log(`[INFO] Publisher ${DEVICE_ID} conectado al broker en ${brokerUrl}`);
  
  // Publicamos nuestro estado 'online' *usando el DEVICE_ID dinámico*
  const onlineMessage = JSON.stringify({ deviceId: DEVICE_ID, status: 'online' });
  client.publish(statusTopic, onlineMessage, { qos: 1, retain: true }, (error) => {
    if (error) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al publicar estado "online":`, error);
    } else {
      console.log(`[INFO] ${DEVICE_ID} - Estado 'online' publicado en [${statusTopic}]`);
    }
  });

  console.log(`[INFO] ${DEVICE_ID} - Iniciando simulación...`);
  setInterval(publishTelemetry, 5000 + Math.random() * 1000); // Añadimos un pequeño delay aleatorio
});

client.on('error', (error) => {
  console.error(`[ERROR] ${DEVICE_ID} - Error de conexión:`, error);
  client.end();
});

function publishTelemetry() {
  const telemetryData = {
    deviceId: DEVICE_ID, // Ya usa el DEVICE_ID dinámico
    temperatura: parseFloat((Math.random() * 15 + 10).toFixed(2)), // Rango ligeramente diferente
    humedad: parseFloat((Math.random() * 30 + 35).toFixed(2)),     // Rango ligeramente diferente
    timestamp: new Date().toISOString(),
  };

  const message = JSON.stringify(telemetryData);
  // El tópico ya se genera dinámicamente con config.topics.telemetry(DEVICE_ID)
  const topic = config.topics.telemetry(DEVICE_ID);

  client.publish(topic, message, { qos: 1, retain: false }, (error) => {
    if (error) {
      console.error(`[ERROR] ${DEVICE_ID} - Error al publicar (QoS 1):`, error);
    } else {
      console.log(`[PUB] ${DEVICE_ID} - Mensaje publicado en [${topic}] (QoS 1):`, message);
    }
  });
}