// --- CONFIGURACIÓN ---
const MQTT_BROKER_URL = "ws://localhost:9001";
const CLIENT_ID = `utp_ops_${Math.random().toString(16).slice(2, 8)}`;
const MQTT_TOPIC_BASE = 'utp/sistemas_distribuidos/grupo1';
const MQTT_TOPICS = {
  all: `${MQTT_TOPIC_BASE}/#`,
  chaosControl: `${MQTT_TOPIC_BASE}/chaos/control`,
  electionCoordinator: `${MQTT_TOPIC_BASE}/election/coordinator`,
  labControl: `${MQTT_TOPIC_BASE}/observability/control/lab`,
  mutexStatus: `${MQTT_TOPIC_BASE}/mutex/status`,
  observabilityEvents: `${MQTT_TOPIC_BASE}/observability/events/`,
};

// --- ESTADO GLOBAL ---
let client;
let currentLeader = null;
const devices = {};
let network;
let nodesDataSet, edgesDataSet;
const packets = [];
const observableEvents = [];
const MAX_LOG_MESSAGES = 30;
const MAX_PACKETS = 80;
const MAX_OBSERVABLE_EVENTS = 80;
const DEFAULT_OBSERVABLE_LIMIT = 40;
const SENSOR_RENDER_INTERVAL_MS = 200;
const QUEUE_RENDER_INTERVAL_MS = 150;
const TIMELINE_RENDER_INTERVAL_MS = 120;
const GAUGE_RENDER_INTERVAL_MS = 250;
const LIVE_BADGE_RENDER_INTERVAL_MS = 500;
const NODE_FILTER_RENDER_INTERVAL_MS = 1000;
const MAX_QUEUE_NODES = 24;
const OBSERVABILITY_FILTERS = {
  algorithm: 'all',
  severity: 'all',
  node: 'all',
  limit: DEFAULT_OBSERVABLE_LIMIT,
};
const perfState = {
  pendingTelemetry: new Map(),
  sensorRenderScheduled: false,
  timelineRenderScheduled: false,
  queueRenderScheduled: false,
  gaugesRenderScheduled: false,
  networkRedrawScheduled: false,
  liveBadgeScheduled: false,
  lastSensorRenderAt: 0,
  lastQueueRenderAt: 0,
  lastTimelineRenderAt: 0,
  lastGaugeRenderAt: 0,
  lastLiveBadgeAt: 0,
  lastNodeFilterUpdateAt: 0,
  knownObservableNodes: new Set(),
  pendingQueueState: null,
};
const ALGORITHM_META = {
  'physical-clock': { label: 'Clock Sync', description: 'Cristian / reloj físico', icon: 'CLK', color: '#58a6ff' },
  lamport: { label: 'Lamport', description: 'Reloj lógico escalar', icon: 'LAM', color: '#79c0ff' },
  'vector-clock': { label: 'Vector Clocks', description: 'Causalidad distribuida', icon: 'VEC', color: '#bc8cff' },
  election: { label: 'Election', description: 'Coordinador y líder', icon: 'LEAD', color: '#d29922' },
  'lease-quorum': { label: 'Lease', description: 'Quorum y expiración', icon: 'LEASE', color: '#a371f7' },
  mutex: { label: 'Mutex', description: 'Sección crítica', icon: 'LOCK', color: '#f0883e' },
  'wal-recovery': { label: 'WAL / Recovery', description: 'Persistencia y reinicio', icon: 'WAL', color: '#3fb950' },
  recovery: { label: 'Recovery', description: 'Recuperación de nodo', icon: 'REC', color: '#3fb950' },
  system: { label: 'System', description: 'Infraestructura', icon: 'SYS', color: '#8b949e' },
};
const COCKPIT_ALGORITHMS = [
  {
    id: 'physical-clock',
    title: 'Cristian / physical clock',
    detail: 'Drift, RTT y aceptación/rechazo de sincronización.',
    focusAlgorithms: ['physical-clock'],
    dependencies: [],
    compatibleWith: ['lamport', 'vector-clock'],
    guidance: 'Ideal para observar cuánto se desvía cada nodo y cuándo Cristian acepta o rechaza una corrección.'
  },
  {
    id: 'lamport',
    title: 'Lamport / logical clock',
    detail: 'Orden lógico sin depender del reloj físico.',
    focusAlgorithms: ['lamport'],
    dependencies: [],
    compatibleWith: ['vector-clock', 'physical-clock'],
    guidance: 'Usalo para comparar progreso lógico entre publishers aunque el tiempo físico tenga drift.'
  },
  {
    id: 'vector-clock',
    title: 'Vector clocks / causality',
    detail: 'Relaciones causales y eventos concurrentes.',
    focusAlgorithms: ['vector-clock'],
    dependencies: ['Lamport helps compare ordering pressure.'],
    compatibleWith: ['lamport'],
    guidance: 'Resalta causalidad observable; si no llegan eventos específicos, el monitor sigue mostrando vectores en tarjetas de sensores.'
  },
  {
    id: 'election',
    title: 'Bully + quorum lease / election',
    detail: 'Líder, quorum, lease y fencing contra split-brain.',
    focusAlgorithms: ['election', 'lease-quorum'],
    dependencies: ['Quorum + lease are bundled with election focus.'],
    compatibleWith: ['mutex', 'wal-recovery'],
    guidance: 'Para split-brain/election se enfatiza quorum, lease y mutex fencing. No es consenso fuerte tipo Raft/Paxos.'
  },
  {
    id: 'mutex',
    title: 'Mutex / critical section',
    detail: 'Acceso exclusivo, grants, rejects y cola.',
    focusAlgorithms: ['mutex', 'election', 'lease-quorum'],
    dependencies: ['Election selects the coordinator.', 'Lease fences stale leaders.', 'WAL is optional recovery evidence.'],
    compatibleWith: ['election', 'wal-recovery'],
    guidance: 'Mutex se guía como bundle: Election + Lease activos visualmente; WAL queda recomendado para recuperación.'
  },
  {
    id: 'wal-recovery',
    title: 'WAL / recovery',
    detail: 'Replay local de cola/holder tras reinicio.',
    focusAlgorithms: ['wal-recovery', 'mutex'],
    dependencies: ['Mutex state must exist before WAL recovery is meaningful.', 'Same coordinator restart is required for local WAL evidence.'],
    compatibleWith: ['mutex', 'election'],
    guidance: 'WAL actual es local al coordinador; el cockpit no promete WAL replicado ni transferencia cross-leader.'
  }
];
const LOAD_PROFILES = {
  normal: {
    label: 'Normal',
    detail: 'Telemetría pedagógica, baja presión mutex, volumen legible.',
    telemetryRate: 'baseline',
    mutexPressure: 'low',
    eventVolume: 'low'
  },
  high: {
    label: 'High',
    detail: 'Más muestras y más contención para observar colas y leases.',
    telemetryRate: 'elevated',
    mutexPressure: 'medium',
    eventVolume: 'medium'
  },
  stress: {
    label: 'Stress',
    detail: 'Intención de prueba masiva: alto volumen y presión de sección crítica.',
    telemetryRate: 'burst',
    mutexPressure: 'high',
    eventVolume: 'high'
  }
};
const SCENARIOS = [
  {
    id: 'clock-drift-cristian-sync',
    title: 'Clock drift / Cristian sync',
    focus: 'physical-clock',
    detail: 'Observar drift, RTT y sync accepted/rejected.'
  },
  {
    id: 'leader-failover-bully-election',
    title: 'Leader failover / Bully election',
    focus: 'election',
    detail: 'Guiar failover con quorum + lease visible.'
  },
  {
    id: 'mutex-pressure',
    title: 'Mutex pressure',
    focus: 'mutex',
    detail: 'Elevar atención sobre grants, rejects, holder y cola.'
  },
  {
    id: 'wal-recovery',
    title: 'WAL recovery',
    focus: 'wal-recovery',
    detail: 'Emitir intención de replay local del mismo coordinador.'
  }
];
const cockpitState = {
  activeAlgorithm: 'physical-clock',
  activeLoadProfile: 'normal',
  activeScenario: null,
  lastIntent: 'Esperando acción del usuario.',
  eventTimestamps: [],
  latestClockSync: 'Waiting',
  mutexGranted: 0,
  mutexRejected: 0,
  walRestored: 0,
};
let selectedNodeId = null;

// ============================================================================
// 1. INICIALIZACIÓN DE LA INTERFAZ (VIS.JS)
// ============================================================================
function initNetworkGraph() {
  const container = document.getElementById('network-viz');
  if (!container) return;

  nodesDataSet = new vis.DataSet([
    { id: 'broker', label: 'MQTT\nBroker', shape: 'hexagon', color: '#fff', size: 40, font: { size: 16, color: 'black' } }
  ]);
  edgesDataSet = new vis.DataSet([]);

  const data = { nodes: nodesDataSet, edges: edgesDataSet };
  const options = {
    physics: {
      stabilization: false,
      barnesHut: { gravitationalConstant: -2000, springConstant: 0.04, springLength: 150 }
    },
    nodes: {
      font: { color: '#c9d1d9', face: 'JetBrains Mono' },
      borderWidth: 2,
      shadow: true
    },
    edges: {
      width: 2,
      color: { color: '#30363d' },
      smooth: { type: 'continuous' }
    },
    interaction: { hover: true }
  };

  network = new vis.Network(container, data, options);

  // EVENTO DE CLIC: Seleccionar Nodo
  network.on("click", function (params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      if (nodeId !== 'broker') {
        openControlPanel(nodeId);
      }
    } else {
      closeControlPanel();
    }
  });

  // MOTOR DE PARTÍCULAS (ANIMACIÓN)
  network.on("afterDrawing", (ctx) => {
    const now = Date.now();
    const packetNodes = new Set();
    packets.forEach(packet => {
      packetNodes.add(packet.from);
      packetNodes.add(packet.to);
    });
    const positions = network.getPositions(Array.from(packetNodes));

    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      const progress = (now - p.startTime) / p.duration;

      if (progress >= 1) {
        packets.splice(i, 1);
        continue;
      }

      const posFrom = positions[p.from];
      const posTo = positions[p.to];

      if (posFrom && posTo) {
        const x = posFrom.x + (posTo.x - posFrom.x) * progress;
        const y = posFrom.y + (posTo.y - posFrom.y) * progress;

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI, false);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (packets.length > 0) {
      requestNetworkRedraw();
    }
  });
}

// ============================================================================
// 2. LÓGICA MQTT
// ============================================================================
function connectToMqtt() {
  logEvent('SYSTEM', `Conectando al Satélite ${MQTT_BROKER_URL}...`);

  client = mqtt.connect(MQTT_BROKER_URL, {
    clientId: CLIENT_ID,
    clean: true,
    reconnectPeriod: 5000
  });

  client.on('connect', () => {
    updateStatus(true);
    logEvent('SYSTEM', 'Enlace MQTT Establecido');
    client.subscribe(MQTT_TOPICS.all);
  });

  client.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (topic.startsWith(MQTT_TOPICS.observabilityEvents)) {
        handleObservableEvent(payload);
        return;
      }

      const sensorId = payload.deviceId || payload.coordinatorId || payload.candidateId;

      // 1. Auto-Descubrimiento
      if (sensorId && sensorId !== 'broker' && !nodesDataSet.get(sensorId)) {
        spawnNode(sensorId, payload.priority);
      }

      // 2. Animación
      if (sensorId && sensorId !== 'broker') {
        let color = '#238636';
        if (topic.includes('election')) color = '#58a6ff';
        if (topic.includes('mutex')) color = '#d29922';
        spawnPacket(sensorId, 'broker', color);
      }

      // 3. Procesamiento de Datos
      if (topic.includes('/telemetry')) {
        handleTelemetry(payload);
      } else if (topic === MQTT_TOPICS.electionCoordinator) {
        handleLeaderChange(payload);
      } else if (topic === MQTT_TOPICS.mutexStatus) {
        scheduleVisualQueue(payload.queue, payload.holder);
      } else if (topic.includes('/status')) {
        if (payload.status === 'offline' && payload.deviceId) {
          handleNodeDeath(payload.deviceId);
        } else if (payload.status === 'online' && payload.deviceId) {
          handleNodeRevival(payload.deviceId);
        }
      }

    } catch (e) { }
  });

  client.on('offline', () => updateStatus(false));
  client.on('error', (err) => console.error('MQTT Error:', err));
}

// ============================================================================
// 3. FUNCIONES INTERACTIVAS (CONTROL PANEL)
// ============================================================================

function openControlPanel(nodeId) {
  selectedNodeId = nodeId;
  const panel = document.getElementById('node-control-panel');
  if (!panel) return;

  document.getElementById('cp-title').innerText = nodeId;
  document.getElementById('cp-role').innerText = (nodeId === currentLeader) ? '[*] LÍDER' : 'SEGUIDOR';

  const lastData = devices[nodeId];
  let isDead = true;
  if (lastData && (Date.now() - new Date(lastData.timestamp).getTime() < 6000)) {
    isDead = false;
  }
  if (lastData && lastData.status === 'offline') isDead = true;

  updatePanelButtons(isDead ? 'OFFLINE' : 'ONLINE');
  panel.classList.remove('hidden');
}

function closeControlPanel() {
  const panel = document.getElementById('node-control-panel');
  if (panel) panel.classList.add('hidden');
  selectedNodeId = null;
}

function updatePanelButtons(status) {
  const statusEl = document.getElementById('cp-status');
  const btnKill = document.getElementById('btn-kill');
  const btnRevive = document.getElementById('btn-revive');

  statusEl.innerText = status;
  statusEl.style.color = (status === 'ONLINE') ? '#238636' : '#da3633';

  btnKill.disabled = (status === 'OFFLINE');
  btnRevive.disabled = (status === 'ONLINE');

  btnKill.style.opacity = (status === 'OFFLINE') ? '0.5' : '1';
  btnRevive.style.opacity = (status === 'ONLINE') ? '0.5' : '1';
}

function sendChaos(action) {
  if (!selectedNodeId) return;

  const topic = MQTT_TOPICS.chaosControl;
  const payload = JSON.stringify({
    targetId: selectedNodeId,
    action: action
  });

  client.publish(topic, payload);
  logEvent('CHAOS', `Comando ${action} enviado a ${selectedNodeId}`);

  // Feedback Optimista
  if (action === 'KILL') {
    updatePanelButtons('OFFLINE');
    nodesDataSet.update({ id: selectedNodeId, color: '#333333' });
  } else {
    updatePanelButtons('ONLINE');
  }
}

// ============================================================================
// 4. FUNCIONES VISUALES BASE
// ============================================================================

function updateStatus(isOnline) {
  const el = document.getElementById('connection-status');
  if (el) {
    el.innerText = isOnline ? 'ONLINE' : 'OFFLINE';
    el.className = isOnline ? 'status-online' : 'status-offline';
  }
}

function spawnNode(id, priority) {
  if (nodesDataSet.get(id)) return;
  logEvent('DISCOVERY', `Nuevo nodo: ${id}`);
  nodesDataSet.add({
    id: id,
    label: `${id}\n(P:${priority || '?'})`,
    shape: 'dot',
    color: '#238636',
    size: 25
  });
  edgesDataSet.add({ from: id, to: 'broker' });
}

function spawnPacket(from, to, color) {
  packets.push({ from, to, startTime: Date.now(), duration: 400, color });
  if (packets.length > MAX_PACKETS) packets.splice(0, packets.length - MAX_PACKETS);
  requestNetworkRedraw();
}

function requestNetworkRedraw() {
  if (!network || perfState.networkRedrawScheduled) return;
  perfState.networkRedrawScheduled = true;
  requestAnimationFrame(() => {
    perfState.networkRedrawScheduled = false;
    network.redraw();
  });
}

function handleTelemetry(data) {
  const id = data.deviceId;
  devices[id] = data;
  perfState.pendingTelemetry.set(id, data);
  scheduleSensorRender();
}

function scheduleSensorRender() {
  if (perfState.sensorRenderScheduled) return;

  const elapsed = Date.now() - perfState.lastSensorRenderAt;
  const delay = Math.max(0, SENSOR_RENDER_INTERVAL_MS - elapsed);
  perfState.sensorRenderScheduled = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      perfState.sensorRenderScheduled = false;
      perfState.lastSensorRenderAt = Date.now();
      const pending = Array.from(perfState.pendingTelemetry.entries());
      perfState.pendingTelemetry.clear();
      pending.forEach(([id, data]) => updateSensorCard(id, data));
    });
  }, delay);
}

function handleNodeDeath(id) {
  if (nodesDataSet.get(id)) {
    nodesDataSet.update({ id: id, color: '#333333' });
    logEvent('ALERT', `Nodo ${id} reporta OFFLINE`);
  }
}

function handleNodeRevival(id) {
  if (nodesDataSet.get(id)) {
    nodesDataSet.update({ id: id, color: '#238636' });
    logEvent('INFO', `Nodo ${id} ha revivido`);
  }
}

function handleLeaderChange(payload) {
  const newLeader = payload.coordinatorId;
  if (currentLeader !== newLeader) {
    logEvent('ELECTION', `[*] Consenso: ${newLeader} es el LÍDER.`);
    currentLeader = newLeader;

    const allNodes = nodesDataSet.getIds();
    const updates = allNodes.map(nodeId => {
      if (nodeId === 'broker') return null;
      const isLeader = (nodeId === newLeader);
      return {
        id: nodeId,
        color: isLeader ? '#d29922' : '#238636',
        size: isLeader ? 40 : 25,
        borderWidth: isLeader ? 4 : 2
      };
    }).filter(n => n);
    nodesDataSet.update(updates);

    document.querySelectorAll('.sensor-card').forEach(c => c.classList.remove('leader'));
    const leaderCard = document.getElementById(`card-${newLeader}`);
    if (leaderCard) leaderCard.classList.add('leader');
  }
  updateCockpitGauges();
}

function updateSensorCard(id, data) {
  const grid = document.getElementById('sensor-grid');
  if (!grid) return;

  let card = document.getElementById(`card-${id}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `card-${id}`;
    card.className = 'sensor-card';
    card.onclick = () => openControlPanel(id);
    card.style.cursor = 'pointer';
    card.dataset.lastFlash = '0';

    const header = document.createElement('div');
    header.className = 'sensor-card-header';

    const title = document.createElement('strong');
    title.className = 'sensor-card-title';
    title.textContent = id;

    const role = document.createElement('small');
    role.className = 'sensor-card-role';

    const temperature = document.createElement('div');
    temperature.className = 'metric-row';
    const temperatureLabel = document.createElement('span');
    temperatureLabel.className = 'metric-label';
    temperatureLabel.textContent = 'Temp:';
    const temperatureValue = document.createElement('span');
    temperatureValue.className = 'metric-val sensor-temp';

    const lag = document.createElement('div');
    lag.className = 'metric-row';
    const lagLabel = document.createElement('span');
    lagLabel.className = 'metric-label';
    lagLabel.textContent = 'Lag:';
    const lagValue = document.createElement('span');
    lagValue.className = 'metric-val sensor-lag';

    const vector = document.createElement('div');
    vector.className = 'sensor-vector';

    header.append(title, role);
    temperature.append(temperatureLabel, document.createTextNode(' '), temperatureValue);
    lag.append(lagLabel, document.createTextNode(' '), lagValue);
    card.append(header, temperature, lag, vector);
    grid.appendChild(card);
  }

  const isLeader = (id === currentLeader);
  card.classList.toggle('leader', isLeader);

  const delta = (Date.now() - new Date(data.timestamp).getTime()) / 1000;
  const deltaColor = Math.abs(delta) > 2 ? '#da3633' : '#8b949e';
  const role = card.querySelector('.sensor-card-role');
  const temperatureValue = card.querySelector('.sensor-temp');
  const lagValue = card.querySelector('.sensor-lag');
  const vector = card.querySelector('.sensor-vector');

  role.style.color = isLeader ? '#d29922' : '#8b949e';
  role.textContent = isLeader ? '[*] LÍDER' : 'SEGUIDOR';
  temperatureValue.textContent = `${Number(data.temperatura).toFixed(1)}°C`;
  lagValue.style.color = deltaColor;
  lagValue.textContent = `${delta.toFixed(2)}s`;
  vector.textContent = `L:${data.lamport_ts} | V:[${(data.vector_clock || []).slice(0, 3).join(',')}]`;

  const now = Date.now();
  if (now - Number(card.dataset.lastFlash) >= SENSOR_RENDER_INTERVAL_MS) {
    card.dataset.lastFlash = String(now);
    card.classList.add('flash-update');
    setTimeout(() => card.classList.remove('flash-update'), 500);
  }
}

function updateVisualQueue(queue, holder) {
  const track = document.getElementById('mutex-queue-track');
  if (!track) return;
  track.replaceChildren();

  if (holder) {
    const activeHolder = document.createElement('div');
    activeHolder.className = 'queue-node active-lock';
    activeHolder.textContent = `[@] ${holder}`;
    const arrow = document.createElement('div');
    arrow.style.cssText = 'color:#58a6ff; font-size:1.5em;';
    arrow.textContent = '←';
    track.append(activeHolder, arrow);
  }
  if (queue && queue.length > 0) {
    queue.slice(0, MAX_QUEUE_NODES).forEach(id => {
      const node = document.createElement('div');
      node.className = 'queue-node';
      node.textContent = ` ${id}`;
      track.appendChild(node);
    });
    if (queue.length > MAX_QUEUE_NODES) {
      const overflow = document.createElement('div');
      overflow.className = 'queue-node queue-overflow';
      overflow.textContent = `+${queue.length - MAX_QUEUE_NODES} en cola`;
      track.appendChild(overflow);
    }
  } else if (!holder) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Recurso libre';
    track.appendChild(empty);
  }
}

function scheduleVisualQueue(queue, holder) {
  perfState.pendingQueueState = { queue, holder };
  if (perfState.queueRenderScheduled) return;

  const elapsed = Date.now() - perfState.lastQueueRenderAt;
  const delay = Math.max(0, QUEUE_RENDER_INTERVAL_MS - elapsed);
  perfState.queueRenderScheduled = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      perfState.queueRenderScheduled = false;
      perfState.lastQueueRenderAt = Date.now();
      const pending = perfState.pendingQueueState;
      perfState.pendingQueueState = null;
      if (pending) updateVisualQueue(pending.queue, pending.holder);
    });
  }, delay);
}

function logEvent(type, msg) {
  const list = document.getElementById('messages');
  if (!list) return;
  const li = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = `[${new Date().toLocaleTimeString()}]`;
  const label = document.createElement('strong');
  label.style.color = 'var(--accent)';
  label.textContent = `${type}:`;

  li.append(time, document.createTextNode(' '), label, document.createTextNode(` ${msg}`));
  list.prepend(li);
  while (list.children.length > MAX_LOG_MESSAGES) list.removeChild(list.lastChild);
}

function handleObservableEvent(event) {
  if (!event || typeof event !== 'object') return;

  observableEvents.unshift(event);
  if (observableEvents.length > MAX_OBSERVABLE_EVENTS) observableEvents.pop();

  updateCockpitFromObservableEvent(event);
  scheduleLiveBadge(true);
  scheduleObservableTimelineRender();
}

function scheduleObservableTimelineRender() {
  if (perfState.timelineRenderScheduled) return;

  const elapsed = Date.now() - perfState.lastTimelineRenderAt;
  const delay = Math.max(0, TIMELINE_RENDER_INTERVAL_MS - elapsed);
  perfState.timelineRenderScheduled = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      perfState.timelineRenderScheduled = false;
      perfState.lastTimelineRenderAt = Date.now();
      renderObservableTimeline();
    });
  }, delay);
}

function scheduleCockpitGauges() {
  if (perfState.gaugesRenderScheduled) return;

  const elapsed = Date.now() - perfState.lastGaugeRenderAt;
  const delay = Math.max(0, GAUGE_RENDER_INTERVAL_MS - elapsed);
  perfState.gaugesRenderScheduled = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      perfState.gaugesRenderScheduled = false;
      perfState.lastGaugeRenderAt = Date.now();
      updateCockpitGauges();
    });
  }, delay);
}

function scheduleLiveBadge(hasEvents) {
  if (perfState.liveBadgeScheduled) return;

  const elapsed = Date.now() - perfState.lastLiveBadgeAt;
  const delay = Math.max(0, LIVE_BADGE_RENDER_INTERVAL_MS - elapsed);
  perfState.liveBadgeScheduled = true;
  setTimeout(() => {
    requestAnimationFrame(() => {
      perfState.liveBadgeScheduled = false;
      perfState.lastLiveBadgeAt = Date.now();
      updateLiveBadge(hasEvents);
    });
  }, delay);
}

function initCockpitControls() {
  renderCockpitAlgorithmCards();
  renderLoadProfileControls();
  renderScenarioLauncher();
  syncCockpitState();
}

function renderCockpitAlgorithmCards() {
  const container = document.getElementById('cockpit-algorithm-cards');
  if (!container) return;

  container.replaceChildren();
  COCKPIT_ALGORITHMS.forEach(algorithm => {
    const button = document.createElement('button');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    const meta = ALGORITHM_META[algorithm.id] || ALGORITHM_META.system;

    button.type = 'button';
    button.className = 'algorithm-card';
    button.dataset.algorithm = algorithm.id;
    button.style.setProperty('--algo-color', meta.color);
    button.addEventListener('click', () => selectCockpitAlgorithm(algorithm.id));
    title.textContent = algorithm.title;
    detail.textContent = algorithm.detail;
    button.append(title, detail);
    container.appendChild(button);
  });
}

function renderLoadProfileControls() {
  const container = document.getElementById('load-profile-controls');
  if (!container) return;

  container.replaceChildren();
  Object.entries(LOAD_PROFILES).forEach(([profileId, profile]) => {
    const button = document.createElement('button');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    const hint = document.createElement('small');

    button.type = 'button';
    button.className = 'load-profile-card';
    button.dataset.profile = profileId;
    button.addEventListener('click', () => startLoadProfile(profileId));
    title.textContent = profile.label;
    detail.textContent = profile.detail;
    hint.textContent = `${profile.telemetryRate} telemetry / ${profile.mutexPressure} mutex / ${profile.eventVolume} events`;
    button.append(title, detail, hint);
    container.appendChild(button);
  });
}

function renderScenarioLauncher() {
  const container = document.getElementById('scenario-launcher');
  if (!container) return;

  container.replaceChildren();
  SCENARIOS.forEach(scenario => {
    const button = document.createElement('button');
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    const status = document.createElement('small');

    button.type = 'button';
    button.className = 'scenario-card';
    button.dataset.scenario = scenario.id;
    button.addEventListener('click', () => launchScenario(scenario.id));
    title.textContent = scenario.title;
    detail.textContent = scenario.detail;
    status.textContent = 'Publishes guided intent; automated runner pending.';
    button.append(title, detail, status);
    container.appendChild(button);
  });
}

function selectCockpitAlgorithm(algorithmId) {
  cockpitState.activeAlgorithm = algorithmId;
  cockpitState.activeScenario = null;
  applyFocusFilter(algorithmId);
  syncCockpitState();
}

function startLoadProfile(profileId) {
  if (!LOAD_PROFILES[profileId]) return;

  cockpitState.activeLoadProfile = profileId;
  publishLabControlIntent('load-profile-started', {
    loadProfile: profileId,
    activeAlgorithm: cockpitState.activeAlgorithm,
    conceptualProfile: LOAD_PROFILES[profileId],
  });
  cockpitState.lastIntent = `Load profile '${LOAD_PROFILES[profileId].label}' emitted as control intent.`;
  syncCockpitState();
}

function launchScenario(scenarioId) {
  const scenario = SCENARIOS.find(candidate => candidate.id === scenarioId);
  if (!scenario) return;

  cockpitState.activeScenario = scenario;
  cockpitState.activeAlgorithm = scenario.focus;
  applyFocusFilter(scenario.focus);
  publishLabControlIntent('scenario-intent-issued', {
    scenarioId,
    activeAlgorithm: scenario.focus,
    loadProfile: cockpitState.activeLoadProfile,
    automationStatus: 'intent-only-runner-pending',
  });
  cockpitState.lastIntent = `Scenario '${scenario.title}' intent emitted; automated scenario runner is not implemented yet.`;
  syncCockpitState();
}

function publishLabControlIntent(eventType, data) {
  const payload = {
    schemaVersion: 'lab-control-intent/v1',
    eventType,
    emittedAt: new Date().toISOString(),
    source: 'web-monitor-cockpit',
    data,
  };

  if (client && client.connected) {
    client.publish(MQTT_TOPICS.labControl, JSON.stringify(payload), { qos: 0, retain: false });
  }
  logEvent('COCKPIT', `${eventType} -> ${MQTT_TOPICS.labControl}`);
}

function applyFocusFilter(algorithmId) {
  const algorithm = COCKPIT_ALGORITHMS.find(candidate => candidate.id === algorithmId);
  const firstFocus = algorithm?.focusAlgorithms[0] || 'all';
  OBSERVABILITY_FILTERS.algorithm = firstFocus;

  const select = document.getElementById('filter-algorithm');
  if (select) select.value = firstFocus;
  renderObservableTimeline();
}

function syncCockpitState() {
  const algorithm = COCKPIT_ALGORITHMS.find(candidate => candidate.id === cockpitState.activeAlgorithm) || COCKPIT_ALGORITHMS[0];
  const activeProfile = LOAD_PROFILES[cockpitState.activeLoadProfile];

  setText('cockpit-active-focus', algorithm.title);
  setText('cockpit-active-load', activeProfile.label);
  setText('cockpit-active-scenario', cockpitState.activeScenario?.title || 'Ninguno');
  setText('cockpit-last-intent', cockpitState.lastIntent);
  setText('cockpit-control-topic', MQTT_TOPICS.labControl.replace(`${MQTT_TOPIC_BASE}/`, ''));
  setText('cockpit-bundle-badge', algorithm.focusAlgorithms.length > 1 ? 'Guided bundle' : 'Solo focus');

  document.querySelectorAll('.algorithm-card').forEach(card => {
    const isActive = card.dataset.algorithm === algorithm.id;
    const isCompatible = algorithm.compatibleWith.includes(card.dataset.algorithm);
    card.classList.toggle('is-active', isActive);
    card.classList.toggle('is-compatible', !isActive && isCompatible);
    card.classList.toggle('is-muted', !isActive && !isCompatible);
  });
  document.querySelectorAll('.load-profile-card').forEach(card => {
    card.classList.toggle('is-active', card.dataset.profile === cockpitState.activeLoadProfile);
  });
  document.querySelectorAll('.scenario-card').forEach(card => {
    card.classList.toggle('is-active', card.dataset.scenario === cockpitState.activeScenario?.id);
  });
  renderCockpitGuidance(algorithm);
  updateCockpitGauges();
}

function renderCockpitGuidance(algorithm) {
  const box = document.getElementById('cockpit-guidance');
  if (!box) return;

  const title = document.createElement('strong');
  const summary = document.createElement('p');
  const list = document.createElement('ul');
  const honesty = document.createElement('small');

  title.textContent = 'Guidance';
  summary.textContent = algorithm.guidance;
  algorithm.dependencies.forEach(dependency => {
    const item = document.createElement('li');
    item.textContent = dependency;
    list.appendChild(item);
  });
  honesty.textContent = 'Focus mode filters and guides observability; algorithms continue running in simulator.';
  box.replaceChildren(title, summary, list, honesty);
}

function updateCockpitFromObservableEvent(event) {
  const now = Date.now();
  const eventType = event.eventType || event.type || '';
  const algorithm = getObservableAlgorithm(event);

  cockpitState.eventTimestamps.push(now);
  cockpitState.eventTimestamps = cockpitState.eventTimestamps.filter(timestamp => now - timestamp <= 60000);

  if (algorithm === 'physical-clock' && eventType.includes('cristian-sync')) {
    cockpitState.latestClockSync = eventType.includes('rejected') ? 'Rejected' : 'Accepted';
  }
  if (eventType === 'mutex-granted') cockpitState.mutexGranted += 1;
  if (eventType === 'mutex-grant-rejected') cockpitState.mutexRejected += 1;
  if (eventType === 'wal-restored') cockpitState.walRestored += 1;
  if (eventType === 'leader-elected' && event.data?.leaderId) currentLeader = event.data.leaderId;

  scheduleCockpitGauges();
}

function updateCockpitGauges() {
  setText('gauge-leader', currentLeader || '-');
  setText('gauge-event-rate', `${cockpitState.eventTimestamps.length}/min`);
  setText('gauge-clock-sync', cockpitState.latestClockSync);
  setText('gauge-mutex', `${cockpitState.mutexGranted} / ${cockpitState.mutexRejected}`);
  setText('gauge-wal', cockpitState.walRestored);
  setText('gauge-focus', cockpitState.activeAlgorithm);
}

function initObservabilityControls() {
  const algorithmFilter = document.getElementById('filter-algorithm');
  const severityFilter = document.getElementById('filter-severity');
  const nodeFilter = document.getElementById('filter-node');
  const limitFilter = document.getElementById('filter-limit');
  const clearButton = document.getElementById('clear-observability');

  renderAlgorithmOptions();
  renderAlgorithmLegend();

  algorithmFilter?.addEventListener('change', event => {
    OBSERVABILITY_FILTERS.algorithm = event.target.value;
    renderObservableTimeline();
  });
  severityFilter?.addEventListener('change', event => {
    OBSERVABILITY_FILTERS.severity = event.target.value;
    renderObservableTimeline();
  });
  nodeFilter?.addEventListener('change', event => {
    OBSERVABILITY_FILTERS.node = event.target.value;
    renderObservableTimeline();
  });
  limitFilter?.addEventListener('change', event => {
    OBSERVABILITY_FILTERS.limit = Math.min(Number(event.target.value) || DEFAULT_OBSERVABLE_LIMIT, MAX_OBSERVABLE_EVENTS);
    renderObservableTimeline();
  });
  clearButton?.addEventListener('click', () => {
    observableEvents.length = 0;
    updateLiveBadge(false);
    renderObservableTimeline();
  });
}

function renderAlgorithmOptions() {
  const select = document.getElementById('filter-algorithm');
  if (!select) return;

  Object.entries(ALGORITHM_META).forEach(([algorithm, meta]) => {
    const option = document.createElement('option');
    option.value = algorithm;
    option.textContent = meta.label;
    select.appendChild(option);
  });
}

function renderAlgorithmLegend() {
  const legend = document.getElementById('algorithm-legend');
  if (!legend) return;

  legend.innerHTML = '';
  Object.entries(ALGORITHM_META).forEach(([algorithm, meta]) => {
    const item = document.createElement('span');
    item.className = `legend-pill algo-${algorithm}`;
    item.style.setProperty('--algo-color', meta.color);
    item.textContent = `${meta.icon} ${meta.label}`;
    item.title = meta.description;
    legend.appendChild(item);
  });
}

function updateNodeFilterOptions() {
  const select = document.getElementById('filter-node');
  if (!select) return;

  const currentValue = select.value;
  const now = Date.now();
  const nextNodeIds = new Set(observableEvents.map(event => getObservableNode(event)));
  const changed = nextNodeIds.size !== perfState.knownObservableNodes.size
    || Array.from(nextNodeIds).some(nodeId => !perfState.knownObservableNodes.has(nodeId));

  if (!changed && now - perfState.lastNodeFilterUpdateAt < NODE_FILTER_RENDER_INTERVAL_MS) return;

  perfState.lastNodeFilterUpdateAt = now;
  perfState.knownObservableNodes = nextNodeIds;

  const nodeIds = Array.from(nextNodeIds).sort();
  select.replaceChildren(new Option('Todos', 'all'));
  nodeIds.forEach(nodeId => {
    const option = document.createElement('option');
    option.value = nodeId;
    option.textContent = nodeId;
    select.appendChild(option);
  });
  select.value = nodeIds.includes(currentValue) ? currentValue : 'all';
  OBSERVABILITY_FILTERS.node = select.value;
}

function updateLiveBadge(hasEvents) {
  const badge = document.getElementById('observability-live-badge');
  if (!badge) return;

  badge.textContent = hasEvents ? 'RECIBIENDO MQTT' : 'EN ESPERA';
  badge.className = hasEvents ? 'live-badge is-live' : 'live-badge is-idle';
}

function renderObservableTimeline() {
  const list = document.getElementById('observability-timeline');
  if (!list) return;

  updateNodeFilterOptions();
  list.replaceChildren();

  if (observableEvents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'Esperando eventos observables...';
    list.appendChild(empty);
    updateObservabilityMetrics([]);
    return;
  }

  const visibleLimit = Math.min(OBSERVABILITY_FILTERS.limit, MAX_OBSERVABLE_EVENTS);
  const filteredEvents = observableEvents
    .filter(event => OBSERVABILITY_FILTERS.algorithm === 'all' || getObservableAlgorithm(event) === OBSERVABILITY_FILTERS.algorithm)
    .filter(event => OBSERVABILITY_FILTERS.severity === 'all' || getObservableSeverity(event) === OBSERVABILITY_FILTERS.severity)
    .filter(event => OBSERVABILITY_FILTERS.node === 'all' || getObservableNode(event) === OBSERVABILITY_FILTERS.node)
    .slice(0, visibleLimit);

  updateObservabilityMetrics(filteredEvents);

  if (filteredEvents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No hay eventos para los filtros actuales.';
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  filteredEvents.forEach(event => {
    const item = document.createElement('li');
    const severity = getObservableSeverity(event);
    const emittedAt = event.emittedAt || event.timestamp || new Date().toISOString();
    const eventType = event.eventType || event.type || 'unknown-event';
    const algorithm = getObservableAlgorithm(event);
    const algorithmMeta = ALGORITHM_META[algorithm] || { label: algorithm, description: 'Evento observable', icon: 'EVT', color: '#58a6ff' };
    const nodeId = getObservableNode(event);
    const summary = event.summary || event.message || eventType;
    const main = document.createElement('div');
    const time = document.createElement('span');
    const algorithmEl = document.createElement('strong');
    const eventTypeEl = document.createElement('span');
    const nodeIdEl = document.createElement('small');
    const summaryEl = document.createElement('div');

    item.className = `observable-event severity-${severity} algo-${algorithm}`;
    item.style.setProperty('--algo-color', algorithmMeta.color);
    main.className = 'observable-event-main';
    time.className = 'log-time';
    time.textContent = `[${new Date(emittedAt).toLocaleTimeString()}]`;
    algorithmEl.className = 'algorithm-chip';
    algorithmEl.textContent = `${algorithmMeta.icon} ${algorithmMeta.label}`;
    eventTypeEl.textContent = eventType;
    eventTypeEl.className = 'event-type-chip';
    nodeIdEl.textContent = nodeId;
    summaryEl.className = 'observable-event-summary';
    summaryEl.textContent = summary;

    main.append(time, algorithmEl, eventTypeEl, nodeIdEl);
    item.append(main, summaryEl);
    item.title = `${eventType} | ${nodeId} | ${summary}`;
    fragment.appendChild(item);
  });
  list.appendChild(fragment);
}

function updateObservabilityMetrics(visibleEvents) {
  const alertCount = observableEvents.filter(event => ['warn', 'error', 'critical'].includes(getObservableSeverity(event))).length;
  const nodeCount = new Set(observableEvents.map(event => getObservableNode(event))).size;

  setText('obs-total-count', observableEvents.length);
  setText('obs-visible-count', visibleEvents.length);
  setText('obs-alert-count', alertCount);
  setText('obs-node-count', nodeCount);
}

function getObservableAlgorithm(event) {
  return event.algorithm || 'system';
}

function getObservableNode(event) {
  return event.nodeId || event.processId || 'system';
}

function getObservableSeverity(event) {
  return ['debug', 'info', 'warn', 'error', 'critical'].includes(event.severity) ? event.severity : 'info';
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

document.addEventListener('DOMContentLoaded', () => {
  initNetworkGraph();
  initCockpitControls();
  initObservabilityControls();
  connectToMqtt();
  renderObservableTimeline();
});
