const crypto = require('crypto');
const config = require('../config');

const SCHEMA_VERSION = 'observability-event/v1';
const VALID_SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'critical']);

function toKebabCase(value) {
  return String(value || 'event')
    .trim()
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function createEvent({
  type,
  eventType,
  algorithm,
  nodeId,
  processId,
  role,
  severity = 'info',
  message,
  summary,
  metadata,
  data,
  lamport,
  vector,
  scenarioId = null,
  correlationId,
  causationId,
}) {
  const normalizedType = toKebabCase(eventType || type);
  const normalizedAlgorithm = toKebabCase(algorithm || 'system');
  const normalizedSeverity = VALID_SEVERITIES.has(severity) ? severity : 'info';
  const payloadData = data || metadata || {};
  const emittedAt = new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    eventType: normalizedType,
    type: normalizedType,
    algorithm: normalizedAlgorithm,
    emittedAt,
    timestamp: emittedAt,
    nodeId: nodeId || 'system',
    processId,
    role,
    scenarioId,
    correlationId: correlationId || `${normalizedAlgorithm}-${nodeId || 'system'}-${Date.now()}`,
    causationId: causationId || null,
    severity: normalizedSeverity,
    summary: summary || message || normalizedType,
    message: message || summary || normalizedType,
    data: payloadData,
    metadata: payloadData,
    lamport: lamport ?? null,
    vector: Array.isArray(vector) ? vector : null,
  };
}

function publishEvent(client, eventInput) {
  try {
    if (!client || typeof client.publish !== 'function') return null;

    const event = createEvent(eventInput);
    const topic = config.topics.observability.events(event.algorithm, event.eventType);

    client.publish(topic, JSON.stringify(event), { qos: 0 }, error => {
      if (error) {
        console.warn(`[OBSERVABILITY] publish failed: ${error.message}`);
      }
    });

    return event;
  } catch (error) {
    console.warn(`[OBSERVABILITY] event ignored: ${error.message}`);
    return null;
  }
}

module.exports = {
  SCHEMA_VERSION,
  createEvent,
  publishEvent,
};
