// /subscriber/persistence-subscriber.js

const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const config = require('../config'); // Nuestra config MQTT

// --- Configuración InfluxDB (leída desde variables de entorno) ---
const influxUrl = process.env.INFLUXDB_URL || 'http://localhost:8086';
const influxToken = process.env.INFLUXDB_TOKEN || 'mySuperSecretToken123!';
const influxOrg = process.env.INFLUXDB_ORG || 'utp';
const influxBucket = process.env.INFLUXDB_BUCKET || 'sensors';

// --- Configuración MQTT ---
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const topic = config.topics.telemetry('+'); // Escucha telemetría de todos los dispositivos
const clientId = `persistence_sub_${Math.random().toString(16).slice(2, 8)}`;

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

    if (!deviceId || data.temperatura === undefined || data.humedad === undefined) {
      console.warn('[WARN] Mensaje incompleto recibido, ignorando:', data);
      return;
    }

    // Crear un punto de datos para InfluxDB
    const point = new Point('sensor_data') // Nombre de la "measurement" (tabla)
      .tag('device_id', deviceId) // Las etiquetas (tags) son indexadas, buenas para filtros (WHERE)
      .floatField('temperature', data.temperatura) // Los campos (fields) son los valores medidos
      .floatField('humidity', data.humedad)
      // Opcional: Usar el timestamp del mensaje si existe y es válido, sino InfluxDB usa el actual
      .timestamp(new Date(data.timestamp || Date.now())); 

    console.log(`[DB] Preparando punto para InfluxDB: ${point.toString()}`);

    // Escribir el punto en InfluxDB
    writeApi.writePoint(point);

    // Es recomendable hacer flush periódicamente o al recibir varios puntos
    // Para este ejemplo simple, haremos flush inmediato (menos eficiente pero más fácil de ver)
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