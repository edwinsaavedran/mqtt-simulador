// /config/index.js

/**
 * Archivo central de configuración para la aplicación MQTT.
 * Aquí se definen las direcciones del broker, la estructura de los tópicos
 * y la topología auditable usada por relojes vectoriales.
 */

function parseElectionParticipants(rawParticipants) {
  return (rawParticipants || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [deviceId, priority] = entry.split(':');
      const parsedPriority = Number.parseInt(priority, 10);

      return {
        deviceId: (deviceId || '').trim(),
        priority: Number.isFinite(parsedPriority) ? parsedPriority : null,
      };
    })
    .filter(participant => participant.deviceId)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

function getElectionParticipants() {
  return parseElectionParticipants(process.env.ELECTION_PARTICIPANTS || '');
}

function getTotalNodes() {
  const participants = getElectionParticipants();
  const configuredTotal = Number.parseInt(process.env.TOTAL_NODES || '', 10);

  if (participants.length > 0) return participants.length;
  if (Number.isInteger(configuredTotal) && configuredTotal > 0) return configuredTotal;

  return 5;
}

function getVectorIndex(deviceId) {
  return getElectionParticipants().findIndex(participant => participant.deviceId === deviceId);
}

module.exports = {
  // Configuración del Broker MQTT
  broker: {
    address: 'mqtt-broker',
    port: 1883,
  },

  // Definición de los tópicos MQTT activos y conocidos.
  topics: {
    // Tópico base para todos los mensajes del proyecto
    base: 'utp/sistemas_distribuidos/grupo1',

    // Tópico para datos de telemetría de un dispositivo específico
    telemetry: (deviceId) => `utp/sistemas_distribuidos/grupo1/${deviceId}/telemetry`,

    // Tópico para el estado de un dispositivo (online/offline)
    status: (deviceId) => `utp/sistemas_distribuidos/grupo1/${deviceId}/status`,

    // Tópico catch-all para monitores de auditoría dentro del namespace del proyecto
    all: 'utp/sistemas_distribuidos/grupo1/#',

    // Tópico de control operativo para simular fallos de publishers
    chaos_control: 'utp/sistemas_distribuidos/grupo1/chaos/control',

    // --- Tópicos para Sincronización de Reloj (Cristian) ---
    /** Tópico general donde los clientes solicitan la hora */
    time_request: 'utp/sistemas_distribuidos/grupo1/time/request',

    /** Tópico base para las respuestas del servidor de tiempo. */
    time_response: (deviceId) => `utp/sistemas_distribuidos/grupo1/time/response/${deviceId}`,

    // --- Tópicos para exclusión mutua ---
    /** Tópico para solicitar el acceso al recurso (publisher -> coordinator) */
    mutex_request: 'utp/sistemas_distribuidos/grupo1/mutex/request',

    /** Tópico para liberar el recurso (publisher -> coordinator) */
    mutex_release: 'utp/sistemas_distribuidos/grupo1/mutex/release',

    /** Tópico para otorgar el permiso (coordinator -> publisher) */
    mutex_grant: (deviceId) => `utp/sistemas_distribuidos/grupo1/mutex/grant/${deviceId}`,

    /** Tópico para que el coordinador publique el estado actual del recurso (coordinator -> web-monitor) */
    mutex_status: 'utp/sistemas_distribuidos/grupo1/mutex/status',

    // --- Tópicos para elección de líder ---
    election: {
      /** Tópico para mensajes de heartbeat (PING/PONG) */
      heartbeat: 'utp/sistemas_distribuidos/grupo1/election/heartbeat',

      /** Tópico para mensajes del algoritmo de elección (ELECTION, ALIVE) */
      messages: 'utp/sistemas_distribuidos/grupo1/election/messages',

      /** Tópico para anunciar al nuevo coordinador (VICTORY). Es un mensaje retenido. */
      coordinator: 'utp/sistemas_distribuidos/grupo1/election/coordinator',

      /** Tópico retenido para el lease activo del líder. */
      lease: 'utp/sistemas_distribuidos/grupo1/election/lease',

      /** Tópico usado por el candidato para consultar quórum. */
      quorum_check: 'utp/sistemas_distribuidos/grupo1/election/quorum/check',

      /** Tópico usado por los nodos para responder consultas de quórum. */
      quorum_ack: 'utp/sistemas_distribuidos/grupo1/election/quorum/ack',
    }
  },

  topology: {
    parseElectionParticipants,
    getElectionParticipants,
    getTotalNodes,
    getVectorIndex,
  },
};
