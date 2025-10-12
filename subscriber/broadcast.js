/*const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  client.subscribe("sistema/broadcast/#", { qos: 1 }); // # acepta todos los subtopics
  console.log("Nodo global esperando broadcast...");
});

client.on("message", (topic, message) => {
  console.log(`[BROADCAST] Mensaje en ${topic}: ${message.toString()}`);
});
*/

// /subscriber/broadcast.js

const mqtt = require('mqtt');
const config = require('../config'); // 1. Importamos la configuración

const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;

const client = mqtt.connect(brokerUrl);

// 2. Definimos el tópico BROADCAST.
// El comodín '#' matchea cualquier tópico que comience con la ruta base.
// Escuchará: utp/sistemas_distribuidos/grupo1/sensor-001/telemetry
//            utp/sistemas_distribuidos/grupo1/sensor-001/status
//            y cualquier otro que se cree en el futuro.
const topic = `${config.topics.base}/#`;

client.on('connect', () => {
  console.log(`[INFO] Suscriptor BROADCAST conectado al broker en ${brokerUrl}`);
  
  client.subscribe(topic, { qos: 1 }, (err) => {
    if (!err) {
      console.log(`[INFO] Suscrito exitosamente al tópico universal: ${topic}`);
    } else {
      console.error(`[ERROR] Error al suscribirse:`, err);
    }
  });
});

client.on('message', (receivedTopic, message) => {
  console.log(`\n Mensaje recibido en el tópico [${receivedTopic}]`);

  // 3. Lógica para diferenciar el tipo de mensaje.
  // Como este suscriptor recibe TODO, debemos verificar qué tipo de mensaje es.
  try {
    const data = JSON.parse(message.toString());

    if (receivedTopic.endsWith('/status')) {
      // Es un mensaje de estado
      const status = data.status ? data.status.toUpperCase() : 'DESCONOCIDO';
      console.log(` Notificación de Estado: El dispositivo ${data.deviceId} está ${status}`);
    } else if (receivedTopic.endsWith('/telemetry')) {
      // Es un mensaje de telemetría
      console.log(' Datos de Telemetría:');
      console.log(`   - Dispositivo: ${data.deviceId}`);
      console.log(`   - Temperatura: ${data.temperatura} C`);
    } else {
      // Es otro tipo de mensaje que no reconocemos, pero lo mostramos
      console.log(' Datos (tipo no reconocido):', data);
    }
  } catch (error) {
    console.error('[ERROR] Mensaje no es un JSON válido:', message.toString());
  }
});

client.on('error', (error) => {
  console.error('[ERROR] Error de conexión:', error);
  client.end();
});