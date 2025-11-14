// /lock-coordinator/lock-coordinator.js

const mqtt = require('mqtt');
const config = require('../config');

// --- Estado del Recurso Compartido ---
let isLockAvailable = true;
let lockHolder = null;
const waitingQueue = [];

const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, { clientId: 'lock_coordinator_01' });

client.on('connect', () => {
  console.log(`[INFO] Coordinador de Bloqueo conectado a ${brokerUrl}`);
  
  client.subscribe(config.topics.mutex_request, { qos: 1 }, (err) => {
    if (!err) console.log(`[INFO] Escuchando solicitudes en [${config.topics.mutex_request}]`);
  });
  
  client.subscribe(config.topics.mutex_release, { qos: 1 }, (err) => {
    if (!err) console.log(`[INFO] Escuchando liberaciones en [${config.topics.mutex_release}]`);
  });

  publishStatus();
});

client.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.deviceId;

    if (!deviceId) return;

    if (topic === config.topics.mutex_request) {
      handleRequest(deviceId);
    } else if (topic === config.topics.mutex_release) {
      handleRelease(deviceId);
    }
  } catch (e) {
    console.error('[ERROR] Mensaje JSON inválido:', e.message);
  }
});

function handleRequest(deviceId) {
  console.log(`[REQUEST] Solicitud recibida de: ${deviceId}`);
  
  if (isLockAvailable) {
    grantLock(deviceId);
  } else {
    if (!waitingQueue.includes(deviceId) && lockHolder !== deviceId) {
      console.log(`[QUEUE] ${deviceId} añadido a la cola de espera.`);
      waitingQueue.push(deviceId);
    }
  }
  publishStatus();
}

function handleRelease(deviceId) {
  if (lockHolder === deviceId) {
    console.log(`[RELEASE] Recurso liberado por: ${deviceId}`);
    lockHolder = null;
    isLockAvailable = true;
    
    if (waitingQueue.length > 0) {
      const nextDeviceId = waitingQueue.shift();
      console.log(`[GRANT] Otorgando recurso al siguiente en la cola: ${nextDeviceId}`);
      grantLock(nextDeviceId);
    }
  } else {
    console.warn(`[WARN] ${deviceId} intentó liberar un recurso que no posee.`);
  }
  publishStatus();
}

function grantLock(deviceId) {
  isLockAvailable = false;
  lockHolder = deviceId;
  
  const grantTopic = config.topics.mutex_grant(deviceId);
  console.log(`[GRANT] Otorgando recurso a ${deviceId} en [${grantTopic}]`);
  
  client.publish(grantTopic, JSON.stringify({ status: 'granted' }), { qos: 1 });
}

function publishStatus() {
  const statusPayload = JSON.stringify({
    isAvailable: isLockAvailable,
    holder: lockHolder,
    queue: waitingQueue
  });
  
  console.log('[STATUS] Publicando estado:', statusPayload);
  client.publish(config.topics.mutex_status, statusPayload, { qos: 0, retain: true });
}

client.on('error', (error) => {
  console.error('[ERROR] Error de conexión MQTT:', error);
});