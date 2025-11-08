// /config/index.js

/**
 * Archivo central de configuración para la aplicación MQTT.
 * Aquí se definen las direcciones del broker y la estructura de los tópicos.
 */
module.exports = {
  // Configuración del Broker MQTT
  broker: {
    //address: 'broker.hivemq.com',
    address: 'mqtt-broker',
    port: 1883,
  },

  // Definición de los Tópicos
  topics: {
    // Tópico base para todos los mensajes del proyecto
    base: 'utp/sistemas_distribuidos/grupo1',

    // Tópico para datos de telemetría de un dispositivo específico
    telemetry: (deviceId) => `utp/sistemas_distribuidos/grupo1/${deviceId}/telemetry`,

    // Tópico para el estado de un dispositivo (online/offline)
    status: (deviceId) => `utp/sistemas_distribuidos/grupo1/${deviceId}/status`,

    /** Tópico general donde los clientes solicitan la hora */
    time_request: 'utp/sistemas_distribuidos/grupo1/time/request',

    // Tópico específico donde el servidor responde con la hora solicitada
    time_response: (deviceId) => `utp/sistemas_distribuidos/grupo1/time/response/${deviceId}`,
    
    // Tópicos de ejemplo para los patrones de comunicación
    unicast: 'utp/SistemasDistribuidos/saavedra',
    multicast: 'utp/SistemasDistribuidos/+',
    multicast_telemetry: 'utp/sistemas_distribuidos/grupo1/+/telemetry',
    broadcast: 'utp/SistemasDistribuidos/#',
  },
};