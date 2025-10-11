/*const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  console.log("Conectado al broker MQTT");

  // UNICAST
  client.publish("sistema/unicast/usuarioA", "Mensaje privado a Usuario A", {
    qos: 1,
    retain: true,
  });

  // MULTICAST
  client.publish(
    "sistema/multicast/zonaNorte",
    "Actualización para Zona Norte",
    {
      qos: 1,
      retain: true,
    },
  );

  // BROADCAST
  client.publish("sistema/broadcast/general", "ALARMA GLOBAL: Servicio caído", {
    qos: 1,
    retain: true,
  });

  console.log("Mensajes enviados con QoS 1 y retención activada");
});
*/

// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config'); // Importamos nuestra configuración

// Identificador único de nuestro dispositivo simulado
const DEVICE_ID = 'sensor-001';

// Opciones de conexión (si son necesarias, como usuario y contraseña)
const options = {
  // username: 'user',
  // password: 'password',
};

// Construimos la URL del broker a partir de la configuración
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;

const client = mqtt.connect(brokerUrl, options);

// Evento que se dispara cuando el cliente se conecta exitosamente
client.on('connect', () => {
  console.log(` Conectado al broker MQTT en ${brokerUrl}`);
  console.log(`Iniciando simulación para el dispositivo: ${DEVICE_ID}`);

  // Empezamos a publicar datos cada 5 segundos
  setInterval(publishTelemetry, 5000);
});

// Evento que se dispara si hay un error
client.on('error', (error) => {
  console.error(' Error de conexión:', error);
  client.end(); // Cerramos la conexión en caso de error
});

/**
 * Función que genera y publica datos de telemetría.
 */
function publishTelemetry() {
  // Generamos datos simulados
  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: parseFloat((Math.random() * 10 + 15).toFixed(2)), // Temp. entre 15.00 y 25.00
    humedad: parseFloat((Math.random() * 20 + 40).toFixed(2)),     // Humedad entre 40.00 y 60.00
    timestamp: new Date().toISOString(),
  };

  // Convertimos el objeto a una cadena JSON
  const message = JSON.stringify(telemetryData);

  // Definimos el tópico usando nuestra función de configuración
  const topic = config.topics.telemetry(DEVICE_ID);

  // Publicamos el mensaje
  client.publish(topic, message, { qos: 0, retain: false }, (error) => {
    if (error) {
      console.error(' Error al publicar:', error);
    } else {
      console.log(`✔️ Mensaje publicado en el tópico [${topic}]:`, message);
    }
  });
}