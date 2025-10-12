// /subscriber/monitor.js

const mqtt = require('mqtt');
const config = require('../config');

const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl);

// Usamos un comodín (+) para suscribirnos al tópico de estado de TODOS los dispositivos
const monitorTopic = config.topics.status('+');

client.on('connect', () => {
  console.log(` Monitor conectado al broker en ${brokerUrl}`);
  
  client.subscribe(monitorTopic, { qos: 1 }, (err) => {
    if (!err) {
      console.log(` Monitor suscrito a los cambios de estado en [${monitorTopic}]`);
    } else {
      console.error(` Error al suscribirse:`, err);
    }
  });
});

client.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.deviceId || 'desconocido';
    const status = data.status.toUpperCase();

    // Usamos colores para una mejor visualización
    const color = status === 'ONLINE' ? '\x1b[32m' : '\x1b[31m'; // Verde para online, Rojo para offline
    const resetColor = '\x1b[0m';

    console.log(`\n Actualización de Estado:`);
    console.log(`   - Dispositivo: ${deviceId}`);
    console.log(`   - Estado: ${color}${status}${resetColor}`);

  } catch (error) {
    console.error(' Error al procesar el mensaje de estado:', message.toString());
  }
});

client.on('error', (error) => {
  console.error(' Error de conexión:', error);
  client.end();
});