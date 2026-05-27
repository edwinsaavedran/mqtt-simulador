// --- CONFIGURACIÓN ---
const MQTT_BROKER_URL = "ws://localhost:9001";
const CLIENT_ID = `utp_ops_${Math.random().toString(16).slice(2, 8)}`;
const MQTT_TOPIC_BASE = 'utp/sistemas_distribuidos/grupo1';
const MQTT_TOPICS = {
  all: `${MQTT_TOPIC_BASE}/#`,
  chaosControl: `${MQTT_TOPIC_BASE}/chaos/control`,
  electionCoordinator: `${MQTT_TOPIC_BASE}/election/coordinator`,
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
const MAX_OBSERVABLE_EVENTS = 80;
const DEFAULT_OBSERVABLE_LIMIT = 40;
const OBSERVABILITY_FILTERS = {
  algorithm: 'all',
  severity: 'all',
  node: 'all',
  limit: DEFAULT_OBSERVABLE_LIMIT,
};
const ALGORITHM_META = {
  'physical-clock': { label: 'Clock Sync', description: 'Cristian / reloj físico', icon: 'CLK', color: '#58a6ff' },
  election: { label: 'Election', description: 'Coordinador y líder', icon: 'LEAD', color: '#d29922' },
  'lease-quorum': { label: 'Lease', description: 'Quorum y expiración', icon: 'LEASE', color: '#a371f7' },
  mutex: { label: 'Mutex', description: 'Sección crítica', icon: 'LOCK', color: '#f0883e' },
  'wal-recovery': { label: 'WAL / Recovery', description: 'Persistencia y reinicio', icon: 'WAL', color: '#3fb950' },
  recovery: { label: 'Recovery', description: 'Recuperación de nodo', icon: 'REC', color: '#3fb950' },
  system: { label: 'System', description: 'Infraestructura', icon: 'SYS', color: '#8b949e' },
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
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      const progress = (now - p.startTime) / p.duration;

      if (progress >= 1) {
        packets.splice(i, 1);
        continue;
      }

      const posFrom = network.getPositions([p.from])[p.from];
      const posTo = network.getPositions([p.to])[p.to];

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
      network.redraw(); // CORRECCIÓN CRÍTICA APLICADA
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
        updateVisualQueue(payload.queue, payload.holder);
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
  network.redraw();
}

function handleTelemetry(data) {
  const id = data.deviceId;
  devices[id] = data;
  updateSensorCard(id, data);
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
    grid.appendChild(card);
  }

  const isLeader = (id === currentLeader);
  card.classList.toggle('leader', isLeader);

  const delta = (Date.now() - new Date(data.timestamp).getTime()) / 1000;
  const deltaColor = Math.abs(delta) > 2 ? '#da3633' : '#8b949e';

  const header = document.createElement('div');
  header.style.cssText = 'border-bottom:1px solid #333; padding-bottom:8px; margin-bottom:8px; display:flex; justify-content:space-between;';

  const title = document.createElement('strong');
  title.textContent = id;

  const role = document.createElement('small');
  role.style.color = isLeader ? '#d29922' : '#8b949e';
  role.textContent = isLeader ? '[*] LÍDER' : 'SEGUIDOR';

  const temperature = document.createElement('div');
  temperature.className = 'metric-row';
  const temperatureLabel = document.createElement('span');
  temperatureLabel.className = 'metric-label';
  temperatureLabel.textContent = 'Temp:';
  const temperatureValue = document.createElement('span');
  temperatureValue.className = 'metric-val';
  temperatureValue.textContent = `${Number(data.temperatura).toFixed(1)}°C`;

  const lag = document.createElement('div');
  lag.className = 'metric-row';
  const lagLabel = document.createElement('span');
  lagLabel.className = 'metric-label';
  lagLabel.textContent = 'Lag:';
  const lagValue = document.createElement('span');
  lagValue.className = 'metric-val';
  lagValue.style.color = deltaColor;
  lagValue.textContent = `${delta.toFixed(2)}s`;

  const vector = document.createElement('div');
  vector.style.cssText = 'margin-top:8px; font-size:0.8em; color:#58a6ff; text-align:center;';
  vector.textContent = `L:${data.lamport_ts} | V:[${data.vector_clock.slice(0, 3).join(',')}]`;

  header.append(title, role);
  temperature.append(temperatureLabel, document.createTextNode(' '), temperatureValue);
  lag.append(lagLabel, document.createTextNode(' '), lagValue);
  card.replaceChildren(header, temperature, lag, vector);

  card.classList.remove('flash-update');
  void card.offsetWidth;
  card.classList.add('flash-update');
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
    queue.forEach(id => {
      const node = document.createElement('div');
      node.className = 'queue-node';
      node.textContent = ` ${id}`;
      track.appendChild(node);
    });
  } else if (!holder) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Recurso libre';
    track.appendChild(empty);
  }
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
  if (list.children.length > 12) list.removeChild(list.lastChild);
}

function handleObservableEvent(event) {
  if (!event || typeof event !== 'object') return;

  observableEvents.unshift(event);
  if (observableEvents.length > MAX_OBSERVABLE_EVENTS) observableEvents.pop();

  updateLiveBadge(true);
  renderObservableTimeline();
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
    OBSERVABILITY_FILTERS.limit = Number(event.target.value) || DEFAULT_OBSERVABLE_LIMIT;
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
  const nodeIds = Array.from(new Set(observableEvents.map(event => getObservableNode(event)))).sort();
  select.innerHTML = '<option value="all">Todos</option>';
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
  list.innerHTML = '';

  if (observableEvents.length === 0) {
    list.innerHTML = '<li class="empty-state">Esperando eventos observables...</li>';
    updateObservabilityMetrics([]);
    return;
  }

  const filteredEvents = observableEvents
    .filter(event => OBSERVABILITY_FILTERS.algorithm === 'all' || getObservableAlgorithm(event) === OBSERVABILITY_FILTERS.algorithm)
    .filter(event => OBSERVABILITY_FILTERS.severity === 'all' || getObservableSeverity(event) === OBSERVABILITY_FILTERS.severity)
    .filter(event => OBSERVABILITY_FILTERS.node === 'all' || getObservableNode(event) === OBSERVABILITY_FILTERS.node)
    .slice(0, OBSERVABILITY_FILTERS.limit);

  updateObservabilityMetrics(filteredEvents);

  if (filteredEvents.length === 0) {
    list.innerHTML = '<li class="empty-state">No hay eventos para los filtros actuales.</li>';
    return;
  }

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
    item.title = JSON.stringify(event, null, 2);
    list.appendChild(item);
  });
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
  initObservabilityControls();
  connectToMqtt();
  renderObservableTimeline();
});
