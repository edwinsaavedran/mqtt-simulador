// --- CONFIGURACIÓN ---
const MQTT_BROKER_URL = "ws://localhost:9001";
const CLIENT_ID = `utp_ops_${Math.random().toString(16).slice(2, 8)}`;

// --- ESTADO GLOBAL ---
let client;
let currentLeader = null;
const devices = {};
let network;
let nodesDataSet, edgesDataSet;
const packets = [];
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
    client.subscribe('utp/sistemas_distribuidos/grupo1/#');
  });

  client.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
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
      } else if (topic.includes('election/coordinator')) {
        handleLeaderChange(payload);
      } else if (topic.includes('mutex/status')) {
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

  const topic = 'utp/sistemas_distribuidos/grupo1/chaos/control';
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
  if (isLeader) card.classList.add('leader');

  const delta = (Date.now() - new Date(data.timestamp).getTime()) / 1000;
  const deltaColor = Math.abs(delta) > 2 ? '#da3633' : '#8b949e';

  card.innerHTML = `
        <div style="border-bottom:1px solid #333; padding-bottom:8px; margin-bottom:8px; display:flex; justify-content:space-between;">
            <strong>${id}</strong>
            <small style="color:${isLeader ? '#d29922' : '#8b949e'}">${isLeader ? '[*] LÍDER' : 'SEGUIDOR'}</small>
        </div>
        <div class="metric-row"><span class="metric-label">Temp:</span> <span class="metric-val">${Number(data.temperatura).toFixed(1)}°C</span></div>
        <div class="metric-row"><span class="metric-label">Lag:</span> <span class="metric-val" style="color:${deltaColor}">${delta.toFixed(2)}s</span></div>
        <div style="margin-top:8px; font-size:0.8em; color:#58a6ff; text-align:center;">
            L:${data.lamport_ts} | V:[${data.vector_clock.slice(0, 3).join(',')}]
        </div>
    `;

  card.classList.remove('flash-update');
  void card.offsetWidth;
  card.classList.add('flash-update');
}

function updateVisualQueue(queue, holder) {
  const track = document.getElementById('mutex-queue-track');
  if (!track) return;
  track.innerHTML = '';

  if (holder) {
    track.innerHTML += `<div class="queue-node active-lock">[@] ${holder}</div>`;
    track.innerHTML += `<div style="color:#58a6ff; font-size:1.5em;">←</div>`;
  }
  if (queue && queue.length > 0) {
    queue.forEach(id => { track.innerHTML += `<div class="queue-node"> ${id}</div>`; });
  } else if (!holder) {
    track.innerHTML = `<div class="empty-state">Recurso libre</div>`;
  }
}

function logEvent(type, msg) {
  const list = document.getElementById('messages');
  if (!list) return;
  const li = document.createElement('li');
  li.innerHTML = `<span class="log-time">[${new Date().toLocaleTimeString()}]</span> <strong style="color:var(--accent)">${type}:</strong> ${msg}`;
  list.prepend(li);
  if (list.children.length > 12) list.removeChild(list.lastChild);
}

document.addEventListener('DOMContentLoaded', () => {
  initNetworkGraph();
  connectToMqtt();
});