const mqtt = require('mqtt');
const config = require('../config');
const fs = require('fs');
const path = require('path');

// 1. DEFINICIONES Y CONFIGURACIÓN (CRÍTICO: Hoisting)
const parsedClockDriftRate = Number.parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
const CLOCK_DRIFT_RATE_MS_PER_SECOND = Number.isFinite(parsedClockDriftRate) ? parsedClockDriftRate : 0;
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');

// Archivos de Log y WAL
const WAL_FILE = path.join(__dirname, `wal_${DEVICE_ID}.log`);
const LOG_FILE = path.join(__dirname, `log_${DEVICE_ID}.log`);

// --- Configuración de Elección (Bully + Titán) ---
const MY_PRIORITY = parseInt(process.env.PROCESS_PRIORITY || '0');
const TOTAL_NODES = config.topology.getTotalNodes();
const QUORUM_SIZE = Math.floor(TOTAL_NODES / 2) + 1;

const LEASE_DURATION = 5000;
const LEASE_RENEWAL = 2000;
const ELECTION_COOLDOWN_MS = 3000;
const QUORUM_WAIT_MS = 1000;
const LEASE_CLOCK_SKEW_GRACE_MS = 250;
const MAX_VOTED_TERMS = 100;
let lastLeaseSeen = Date.now();
let leaseInterval = null;
let quorumVotes = new Set();
let currentElectionId = null;
let currentTerm = 0;
let localLeaseUntil = 0;
let lastKnownLeaderId = null;
let lastKnownLeaseUntil = 0;
let electionCooldownUntil = 0;
let votedTerms = new Set();

const LEADER_ROLES = Object.freeze({
  FOLLOWER: 'FOLLOWER',
  CANDIDATE: 'CANDIDATE',
  LEADER: 'LEADER',
});

let currentLeaderPriority = 100;
let leaderRole = LEADER_ROLES.FOLLOWER;
let isCoordinator = false;
let electionInProgress = false;
let lastHeartbeatTime = Date.now();
const HEARTBEAT_INTERVAL = 2000;
const LEADER_TIMEOUT = 5000;
const ELECTION_TIMEOUT = 3000;
const TELEMETRY_INTERVAL_MS = 5000;
const CLOCK_SYNC_INTERVAL_MS = 30000;
const CALIBRATION_START_DELAY_MS = 5000;
const LEADER_CHECK_INTERVAL_MS = 1000;
const TIME_SYNC_MAX_RTT_MS = 500;

// --- Estado Mutex (Cliente) ---
let sensorState = 'IDLE';
const CALIBRATION_INTERVAL_MS = 20000 + (Math.random() * 5000);
const CALIBRATION_DURATION_MS = 5000;
const CALIBRATION_RELEASE_GRACE_MS = 2000;

// --- Estado Mutex (Servidor/Coordinador) ---
let coord_isLockAvailable = true;
let coord_lockHolder = null;
let coord_waitingQueue = [];

// --- Sincronización Reloj ---
let lastRealTime = Date.now();
let lastSimulatedTime = Date.now();
let clockOffset = 0;
let lamportClock = 0;
const VECTOR_PROCESS_COUNT = TOTAL_NODES;
const VECTOR_INDEX = config.topology.getVectorIndex(DEVICE_ID);
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);

if (VECTOR_INDEX === -1) {
  console.warn(`[VECTOR] ${DEVICE_ID} no esta declarado en ELECTION_PARTICIPANTS. El reloj vectorial no puede publicarse de forma auditable.`);
}

// --- ESTADO DE CAOS (Interruptor de Muerte) ---
let isSimulatingFailure = false;

// --- Conexión MQTT ---
const statusTopic = config.topics.status(DEVICE_ID);
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, {
  clientId: `pub_${DEVICE_ID}_${Math.random().toString(16).slice(2, 5)}`,
  will: { topic: statusTopic, payload: JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), qos: 1, retain: true }
});

// ============================================================================
//                            CICLO DE VIDA
// ============================================================================

client.on('connect', () => {
  console.log(`[INFO] ${DEVICE_ID} (Prio: ${MY_PRIORITY}) conectado. Drift=${CLOCK_DRIFT_RATE_MS_PER_SECOND}ms/s.`);

  // Suscripciones
  client.subscribe(config.topics.time_response(DEVICE_ID));
  client.subscribe(config.topics.mutex_grant(DEVICE_ID));
  client.subscribe(config.topics.election.heartbeat);
  client.subscribe(config.topics.election.messages);
  client.subscribe(config.topics.election.coordinator);
  client.subscribe(config.topics.election.lease);
  client.subscribe(config.topics.election.quorum_check);
  client.subscribe(config.topics.election.quorum_ack);

  // Suscripción a Canal de Caos
  client.subscribe(config.topics.chaos_control);

  // Iniciar Loops
  setInterval(publishTelemetry, TELEMETRY_INTERVAL_MS);
  setInterval(syncClock, CLOCK_SYNC_INTERVAL_MS);
  setTimeout(() => { setInterval(requestCalibration, CALIBRATION_INTERVAL_MS); }, CALIBRATION_START_DELAY_MS);
  setInterval(checkLeaderStatus, LEADER_CHECK_INTERVAL_MS);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });
});

client.on('message', (topic, message) => {
  // 1. INTERCEPTOR DE CAOS
  if (topic === config.topics.chaos_control) {
    try {
      const command = JSON.parse(message.toString());
      if (command.targetId === DEVICE_ID) {
        if (command.action === 'KILL') {
          console.warn(`[CHAOS] COMANDO KILL RECIBIDO. Apagando funciones vitales.`);
          isSimulatingFailure = true;
          client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), { retain: true });
        } else if (command.action === 'REVIVE') {
          console.log(`[CHAOS] COMANDO REVIVE RECIBIDO. Restaurando sistema.`);
          isSimulatingFailure = false;
          stepDown('revive requires lease validation');
          lastLeaseSeen = 0;
          recoverFromWal();  // Restaurar memoria
          client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });
        }
      }
    } catch (e) { console.error("Error parseando caos:", e); }
    return;
  }

  // Si está "muerto", no procesa nada más
  if (isSimulatingFailure) return;

  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (error) {
    console.error(`[ERROR] Payload MQTT inválido en ${topic}: ${error.message}`);
    return;
  }

  if (topic === config.topics.mutex_request) {
    if (!canGrantMutex()) {
      console.warn(`[MUTEX] grant rejected: no valid leadership node=${DEVICE_ID} requester=${payload.deviceId}`);
      return;
    }
    handleCoordRequest(payload.deviceId);
    return;
  }

  if (topic === config.topics.mutex_release) {
    if (!canGrantMutex()) {
      console.warn(`[MUTEX] release ignored: no valid leadership node=${DEVICE_ID} requester=${payload.deviceId}`);
      return;
    }
    handleCoordRelease(payload.deviceId);
    return;
  }

  if (topic === config.topics.mutex_grant(DEVICE_ID)) {
    if (sensorState === 'REQUESTING') {
      sensorState = 'CALIBRATING';
      enterCriticalSection();
    }
  }

  // Algoritmo Cristian Mejorado
  if (topic === config.topics.time_response(DEVICE_ID)) {
    const t4 = Date.now();
    if (payload.deviceId !== DEVICE_ID) {
      console.warn(`[TIME] Sincronización rechazada: respuesta para deviceId inválido (${payload.deviceId}).`);
      return;
    }

    const t1 = Number(payload.t1);
    const serverTime = Number(payload.serverTime);
    if (!Number.isFinite(t1) || !Number.isFinite(serverTime)) {
      console.warn(`[TIME] Sincronización rechazada: payload incompleto o no numérico.`);
      return;
    }

    const rtt = t4 - t1;
    if (rtt < 0 || rtt > TIME_SYNC_MAX_RTT_MS) {
      console.warn(`[TIME] Sincronización rechazada: RTT=${rtt}ms supera umbral de ${TIME_SYNC_MAX_RTT_MS}ms.`);
      return;
    }

    const correctTime = serverTime + (rtt / 2);
    clockOffset = correctTime - getSimulatedTime().getTime();
    console.log(`[TIME] Sincronización aceptada: RTT=${rtt}ms, offset=${Math.round(clockOffset)}ms.`);
  }

  if (topic === config.topics.election.quorum_check) {
    handleQuorumCheck(payload);
  }

  if (topic === config.topics.election.quorum_ack) {
    handleQuorumAck(payload);
  }

  // 2. LÓGICA DE ELECCIÓN GENERAL
  if (topic.startsWith(`${config.topics.base}/election`)) {
    handleElectionMessages(topic, payload);
  }

});

// ============================================================================
//                          ALGORITMOS DISTRIBUIDOS
// ============================================================================

function sendHeartbeat() {
  if (isSimulatingFailure) return;
  if (!isCoordinator) {
    client.publish(config.topics.election.heartbeat, JSON.stringify({ type: 'PING', fromPriority: MY_PRIORITY }));
  }
}

function checkLeaderStatus() {
  if (isSimulatingFailure) return;
  if (Date.now() < electionCooldownUntil) return;
  if (leaderRole === LEADER_ROLES.LEADER && !hasValidLocalLease()) {
    stepDown('local lease expired');
    return;
  }
  if (leaderRole !== LEADER_ROLES.LEADER && !electionInProgress && Date.now() - lastLeaseSeen > LEADER_TIMEOUT) {
    console.warn(`[ELECTION] election started: reason=lease_expired node=${DEVICE_ID}`);
    startElection();
  }
}

function startElection() {
  if (electionInProgress) return;
  if (leaderRole === LEADER_ROLES.LEADER) {
    console.log(`[ELECTION] election ignored: node=${DEVICE_ID} already leader`);
    return;
  }
  if (Date.now() < electionCooldownUntil) {
    console.log(`[ELECTION] election delayed by cooldown: node=${DEVICE_ID} cooldownUntil=${electionCooldownUntil}`);
    return;
  }

  electionInProgress = true;
  setLeaderRole(LEADER_ROLES.CANDIDATE, 'election started');

  currentTerm = Math.max(currentTerm + 1, Date.now());
  currentElectionId = `${DEVICE_ID}-${currentTerm}`;
  quorumVotes = new Set([DEVICE_ID]);

  const electionPayload = {
    type: 'ELECTION',
    term: currentTerm,
    electionId: currentElectionId,
    candidateId: DEVICE_ID,
    candidatePriority: MY_PRIORITY,
    fromPriority: MY_PRIORITY,
  };

  client.publish(config.topics.election.messages, JSON.stringify(electionPayload));

  setTimeout(() => {
    if (electionInProgress && currentElectionId === electionPayload.electionId) declareVictory(electionPayload.electionId);
  }, ELECTION_TIMEOUT);
}

function handleElectionMessages(topic, payload) {
  if (topic === config.topics.election.messages) {
    if (payload.type === 'ELECTION' && payload.fromPriority < MY_PRIORITY) {
      client.publish(config.topics.election.messages, JSON.stringify({
        type: 'ALIVE',
        toPriority: payload.fromPriority,
        fromPriority: MY_PRIORITY,
      }));
      startElection();
    }
    else if (payload.type === 'ALIVE' && payload.fromPriority > MY_PRIORITY) {
      electionInProgress = false;
      setLeaderRole(LEADER_ROLES.FOLLOWER, 'higher priority node is alive');
      applyElectionCooldown('higher priority node is alive');
    }
  }

  if (topic === config.topics.election.coordinator) {
    lastHeartbeatTime = Date.now();
    lastLeaseSeen = Date.now();
    electionInProgress = false;
    currentLeaderPriority = Number(payload.priority) || currentLeaderPriority;
    if (payload.coordinatorId !== DEVICE_ID && isCoordinator) {
      stepDown('coordinator announcement from another node');
    }
  }

  if (topic === config.topics.election.lease) {
    handleLease(payload);
  }
}

function declareVictory(electionId) {
  if (leaderRole !== LEADER_ROLES.CANDIDATE || electionId !== currentElectionId) return;

  client.publish(config.topics.election.quorum_check, JSON.stringify({
    term: currentTerm,
    electionId: currentElectionId,
    candidateId: DEVICE_ID,
    candidatePriority: MY_PRIORITY,
  }));

  setTimeout(() => {
    if (leaderRole !== LEADER_ROLES.CANDIDATE || electionId !== currentElectionId) return;

    if (quorumVotes.size >= QUORUM_SIZE) {
      performVictory(electionId);
      return;
    }

    console.warn(`[ELECTION] quorum not reached: node=${DEVICE_ID} electionId=${electionId} votes=${quorumVotes.size}/${TOTAL_NODES} required=${QUORUM_SIZE}`);
    stepDown('quorum not reached');
  }, QUORUM_WAIT_MS);
}

function performVictory(electionId) {
  if (electionId !== currentElectionId || quorumVotes.size < QUORUM_SIZE) return;

  electionInProgress = false;
  currentLeaderPriority = MY_PRIORITY;
  setLeaderRole(LEADER_ROLES.LEADER, 'quorum reached');
  console.log(`[ELECTION] won election with ${quorumVotes.size} votes: node=${DEVICE_ID} electionId=${electionId} required=${QUORUM_SIZE}`);

  client.publish(config.topics.election.coordinator, JSON.stringify({
    type: 'VICTORY',
    term: currentTerm,
    electionId,
    coordinatorId: DEVICE_ID,
    priority: MY_PRIORITY,
  }), { qos: 1, retain: true });

  renewLease();
  becomeCoordinator();

  if (leaseInterval) clearInterval(leaseInterval);
  leaseInterval = setInterval(renewLease, LEASE_RENEWAL);
}

function renewLease() {
  if (isSimulatingFailure || leaderRole !== LEADER_ROLES.LEADER) return;
  if (localLeaseUntil > 0 && localLeaseUntil <= Date.now()) {
    stepDown('lease expired before renewal');
    return;
  }

  const issuedAt = Date.now();
  localLeaseUntil = issuedAt + LEASE_DURATION;

  client.publish(config.topics.election.lease, JSON.stringify({
    term: currentTerm,
    electionId: currentElectionId,
    leaderId: DEVICE_ID,
    coordinatorId: DEVICE_ID,
    priority: MY_PRIORITY,
    issuedAt,
    leaseUntil: localLeaseUntil,
  }), { qos: 1, retain: true });
  console.log(`[ELECTION] lease renewed: leader=${DEVICE_ID} term=${currentTerm} leaseUntil=${localLeaseUntil}`);
}

function handleLease(leaseData) {
  if (!isValidLease(leaseData)) return;

  const leaderId = leaseData.leaderId || leaseData.coordinatorId;
  const leasePriority = Number(leaseData.priority);
  const leaseTerm = Number(leaseData.term);
  const leaseUntil = Number(leaseData.leaseUntil);

  lastLeaseSeen = Date.now();
  lastKnownLeaderId = leaderId;
  lastKnownLeaseUntil = leaseUntil;
  currentLeaderPriority = leasePriority;
  currentTerm = Math.max(currentTerm, leaseTerm);

  if (leaderId === DEVICE_ID) {
    if (leaderRole === LEADER_ROLES.LEADER) {
      localLeaseUntil = Math.max(localLeaseUntil, leaseUntil);
    } else {
      localLeaseUntil = leaseUntil;
      currentElectionId = leaseData.electionId || currentElectionId;
      setLeaderRole(LEADER_ROLES.LEADER, 'valid retained local lease observed');
      becomeCoordinator();
      renewLease();

      if (leaseInterval) clearInterval(leaseInterval);
      leaseInterval = setInterval(renewLease, LEASE_RENEWAL);
    }
    return;
  }

  if (leaderRole === LEADER_ROLES.LEADER) {
    stepDown(`valid lease observed from ${leaderId}`);
    return;
  }

  if (leaderRole === LEADER_ROLES.CANDIDATE) {
    setLeaderRole(LEADER_ROLES.FOLLOWER, `valid lease observed from ${leaderId}`);
    electionInProgress = false;
    applyElectionCooldown(`valid lease observed from ${leaderId}`);
  }
}

function isValidLease(leaseData) {
  const leaderId = leaseData && (leaseData.leaderId || leaseData.coordinatorId);
  const priority = Number(leaseData && leaseData.priority);
  const term = Number(leaseData && leaseData.term);
  const issuedAt = Number(leaseData && leaseData.issuedAt);
  const leaseUntil = Number(leaseData && leaseData.leaseUntil);

  return Boolean(leaderId)
    && Number.isFinite(priority)
    && Number.isFinite(term)
    && Number.isFinite(issuedAt)
    && Number.isFinite(leaseUntil)
    && leaseUntil > Date.now()
    && leaseUntil - issuedAt <= LEASE_DURATION + LEASE_CLOCK_SKEW_GRACE_MS;
}

function handleQuorumCheck(payload) {
  const term = Number(payload && payload.term);
  const electionId = payload && payload.electionId;
  const candidateId = payload && payload.candidateId;
  const candidatePriority = Number(payload && payload.candidatePriority);

  if (!Number.isFinite(term) || !electionId || !candidateId || candidateId === DEVICE_ID) return;
  if (!Number.isFinite(candidatePriority)) return;
  if (votedTerms.has(term)) return;
  if (hasValidObservedLease() && candidateId !== lastKnownLeaderId) {
    console.warn(`[ELECTION] vote rejected: valid lease exists voter=${DEVICE_ID} candidate=${candidateId} leader=${lastKnownLeaderId}`);
    return;
  }

  votedTerms.add(term);
  pruneVotedTerms();
  currentTerm = Math.max(currentTerm, term);

  client.publish(config.topics.election.quorum_ack, JSON.stringify({
    term,
    electionId,
    candidateId,
    voterId: DEVICE_ID,
  }));
  console.log(`[ELECTION] vote granted: voter=${DEVICE_ID} candidate=${candidateId} term=${term} electionId=${electionId}`);
}

function handleQuorumAck(payload) {
  if (!electionInProgress || leaderRole !== LEADER_ROLES.CANDIDATE) return;
  if (payload.candidateId !== DEVICE_ID) return;
  if (payload.electionId !== currentElectionId) return;
  if (Number(payload.term) !== currentTerm) return;
  if (!payload.voterId || payload.voterId === DEVICE_ID) return;

  quorumVotes.add(payload.voterId);
}

function pruneVotedTerms() {
  while (votedTerms.size > MAX_VOTED_TERMS) {
    const oldestTerm = votedTerms.values().next().value;
    votedTerms.delete(oldestTerm);
  }
}

function becomeCoordinator() {
  if (isCoordinator) return;
  if (leaderRole !== LEADER_ROLES.LEADER || !hasValidLocalLease()) return;

  isCoordinator = true;
  electionInProgress = false;

  coord_isLockAvailable = true;
  coord_lockHolder = null;
  coord_waitingQueue = [];

  client.subscribe(config.topics.mutex_request, { qos: 1 });
  client.subscribe(config.topics.mutex_release, { qos: 1 });

  recoverFromWal();
  publishCoordStatus();
}

function setLeaderRole(nextRole, reason) {
  if (!Object.values(LEADER_ROLES).includes(nextRole)) {
    console.warn(`[ELECTION] invalid role ignored: node=${DEVICE_ID} role=${nextRole}`);
    return;
  }

  if (leaderRole === nextRole) return;

  const previousRole = leaderRole;
  leaderRole = nextRole;
  if (nextRole !== LEADER_ROLES.LEADER) isCoordinator = false;
  console.log(`[ELECTION] role changed: node=${DEVICE_ID} ${previousRole}->${nextRole} reason=${reason}`);
}

function stepDown(reason = 'leadership revoked') {
  if (isCoordinator) {
    console.warn(`[ELECTION] stepping down: node=${DEVICE_ID} reason=${reason}`);
  }

  setLeaderRole(LEADER_ROLES.FOLLOWER, reason);
  electionInProgress = false;
  localLeaseUntil = 0;
  applyElectionCooldown(reason);
  if (leaseInterval) clearInterval(leaseInterval);
  leaseInterval = null;
  client.unsubscribe(config.topics.mutex_request);
  client.unsubscribe(config.topics.mutex_release);
}

function applyElectionCooldown(reason) {
  electionCooldownUntil = Date.now() + ELECTION_COOLDOWN_MS;
  console.log(`[ELECTION] cooldown applied: node=${DEVICE_ID} reason=${reason} cooldownUntil=${electionCooldownUntil}`);
}

function hasValidLocalLease() {
  return leaderRole === LEADER_ROLES.LEADER && localLeaseUntil > Date.now();
}

function hasValidObservedLease() {
  return Boolean(lastKnownLeaderId) && lastKnownLeaseUntil > Date.now();
}

function canGrantMutex() {
  return !isSimulatingFailure && isCoordinator && leaderRole === LEADER_ROLES.LEADER && hasValidLocalLease();
}

// --- SERVIDOR MUTEX CON WAL ---

function handleCoordRequest(requesterId) {
  if (!canGrantMutex()) return;
  if (coord_isLockAvailable) {
    appendToWal('GRANT', { id: requesterId });
    grantCoordLock(requesterId);
  } else {
    if (!coord_waitingQueue.includes(requesterId) && coord_lockHolder !== requesterId) {
      appendToWal('QUEUE', { id: requesterId });
      coord_waitingQueue.push(requesterId);
    }
  }
  publishCoordStatus();
}

function handleCoordRelease(requesterId) {
  if (!canGrantMutex()) return;
  if (coord_lockHolder === requesterId) {
    appendToWal('RELEASE', { id: requesterId });
    coord_lockHolder = null;
    coord_isLockAvailable = true;
    if (coord_waitingQueue.length > 0) {
      const nextId = coord_waitingQueue.shift();
      appendToWal('GRANT', { id: nextId });
      grantCoordLock(nextId);
    }
  }
  publishCoordStatus();
}

function grantCoordLock(requesterId) {
  if (!canGrantMutex()) return;
  coord_isLockAvailable = false;
  coord_lockHolder = requesterId;

  // --- Timeout de seguridad ---
  setTimeout(() => {
    if (coord_lockHolder === requesterId) {
      console.warn(`[WATCHDOG] El nodo ${requesterId} tardó demasiado. Revocando Lock.`);
      handleCoordRelease(requesterId); // Forzar liberación
    }
  }, CALIBRATION_DURATION_MS + CALIBRATION_RELEASE_GRACE_MS); // Dar un margen de seguridad

  client.publish(config.topics.mutex_grant(requesterId), JSON.stringify({ status: 'granted' }), { qos: 1 });
}

function publishCoordStatus() {
  if (isSimulatingFailure || (isCoordinator && !hasValidLocalLease())) return;
  client.publish(config.topics.mutex_status, JSON.stringify({ isAvailable: coord_isLockAvailable, holder: coord_lockHolder, queue: coord_waitingQueue }), { retain: true });
}

// --- PERSISTENCIA (FILE SYSTEM) ---

function appendToWal(operation, data) {
  const entry = `${Date.now()}|${operation}|${JSON.stringify(data)}\n`;
  try { fs.appendFileSync(WAL_FILE, entry); } catch (e) { console.error(`[WAL] Error: ${e.message}`); }
}

function recoverFromWal() {
  if (!fs.existsSync(WAL_FILE)) return;
  const fileContent = fs.readFileSync(WAL_FILE, 'utf-8');
  const lines = fileContent.split('\n');

  // Reiniciar estado en memoria
  coord_waitingQueue = [];
  coord_lockHolder = null;
  coord_isLockAvailable = true;

  lines.forEach(line => {
    if (!line.trim()) return;
    const parts = line.split('|');
    const op = parts[1];
    const data = JSON.parse(parts[2]);

    if (op === 'QUEUE') {
      if (!coord_waitingQueue.includes(data.id) && coord_lockHolder !== data.id) coord_waitingQueue.push(data.id);
    } else if (op === 'GRANT') {
      coord_lockHolder = data.id;
      coord_isLockAvailable = false;
      coord_waitingQueue = coord_waitingQueue.filter(id => id !== data.id);
    } else if (op === 'RELEASE') {
      if (coord_lockHolder === data.id) {
        coord_lockHolder = null;
        coord_isLockAvailable = true;
      }
    }
  });
  const restoredQueueIds = coord_waitingQueue
    .map(item => (item && typeof item === 'object' ? item.id || item.deviceId : item))
    .filter(id => id !== undefined && id !== null);

  console.log(`[WAL] Estado restaurado. Queue: ${coord_waitingQueue.length} ids=${JSON.stringify(restoredQueueIds)}`);
}

// --- TELEMETRÍA ---
function publishTelemetry() {
  if (isSimulatingFailure) return;
  lamportClock++;

  // Actualizar mi propia posición en el vector
  if (VECTOR_INDEX === -1) {
    console.warn(`[VECTOR] Telemetria omitida: no existe indice vectorial auditable para ${DEVICE_ID}.`);
    return;
  }
  vectorClock[VECTOR_INDEX]++;

  const telemetryData = {
    deviceId: DEVICE_ID,
    processId: PROCESS_ID,
    vectorIndex: VECTOR_INDEX,
    temperatura: (20 + Math.random() * 5).toFixed(2),
    humedad: (50 + Math.random() * 10).toFixed(2),
    timestamp: getSimulatedTime().toISOString(),
    lamport_ts: lamportClock,
    vector_clock: vectorClock,
    sensor_state: isCoordinator ? 'COORDINATOR' : sensorState
  };
  client.publish(config.topics.telemetry(DEVICE_ID), JSON.stringify(telemetryData));
}

function getSimulatedTime() {
  const elapsedRealMs = Date.now() - lastRealTime;
  const driftedElapsedMs = elapsedRealMs + ((elapsedRealMs / 1000) * CLOCK_DRIFT_RATE_MS_PER_SECOND);
  return new Date(lastSimulatedTime + driftedElapsedMs + clockOffset);
}

function syncClock() {
  if (isSimulatingFailure) return;
  const payload = {
    deviceId: DEVICE_ID,
    t1: Date.now()
  };
  client.publish(config.topics.time_request, JSON.stringify(payload));
}
function requestCalibration() {
  if (!isSimulatingFailure && sensorState === 'IDLE' && !isCoordinator) {
    sensorState = 'REQUESTING';
    client.publish(config.topics.mutex_request, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
  }
}
function enterCriticalSection() {
  setTimeout(() => { if (!isSimulatingFailure) releaseLock(); }, CALIBRATION_DURATION_MS);
}
function releaseLock() {
  sensorState = 'IDLE';
  client.publish(config.topics.mutex_release, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
}
