// --- Configuración ---
const MQTT_BROKER_URL = "ws://localhost:9001";
const CLIENT_ID = `titan_monitor_${Math.random().toString(16).slice(2, 8)}`;

// --- Estado Global ---
let client;
let currentLeader = null;
const devices = {}; // Almacén de datos de sensores
let network; // Instancia de Vis.js
let nodesDataSet, edgesDataSet; // DataSets de Vis.js

// ============================================================================
// 1. INICIALIZACIÓN VISUAL (MAPA DE RED)
// ============================================================================
function initNetworkGraph() {
  const container = document.getElementById("network-viz");

  // Definición Inicial de Nodos (Estática por ahora, se podría hacer dinámica)
  const nodesArray = [
    {
      id: "broker",
      label: "MQTT Broker",
      shape: "hexagon",
      color: "#fff",
      size: 40,
      font: { color: "#000" },
    },
    { id: "sensor-001", label: "S1\n(10)", shape: "dot", color: "#238636" },
    { id: "sensor-002", label: "S2\n(20)", shape: "dot", color: "#238636" },
    { id: "sensor-003", label: "S3\n(30)", shape: "dot", color: "#238636" },
    { id: "sensor-004", label: "S4\n(40)", shape: "dot", color: "#238636" },
    { id: "sensor-005", label: "S5\n(50)", shape: "dot", color: "#238636" },
  ];

  const edgesArray = [
    { id: "e1", from: "sensor-001", to: "broker" },
    { id: "e2", from: "sensor-002", to: "broker" },
    { id: "e3", from: "sensor-003", to: "broker" },
    { id: "e4", from: "sensor-004", to: "broker" },
    { id: "e5", from: "sensor-005", to: "broker" },
  ];

  nodesDataSet = new vis.DataSet(nodesArray);
  edgesDataSet = new vis.DataSet(edgesArray);

  const data = { nodes: nodesDataSet, edges: edgesDataSet };
  const options = {
    physics: { stabilization: true, barnesHut: { springLength: 150 } },
    nodes: {
      font: { color: "#ffffff", face: "JetBrains Mono", size: 14 },
      borderWidth: 2,
    },
    edges: {
      color: "#30363d",
      width: 2,
      smooth: { type: "continuous" },
    },
    interaction: { hover: true },
  };

  network = new vis.Network(container, data, options);
}

// ============================================================================
// 2. LÓGICA DE CONEXIÓN MQTT
// ============================================================================
function connectToMqtt() {
  logEvent("SYSTEM", `Conectando a ${MQTT_BROKER_URL}...`);

  client = mqtt.connect(MQTT_BROKER_URL, {
    clientId: CLIENT_ID,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    document.getElementById("connection-status").innerText = "ONLINE";
    document.getElementById("connection-status").style.backgroundColor =
      "#238636"; // Green
    logEvent("SYSTEM", " Conectado al Broker MQTT");

    // Suscripciones
    client.subscribe("utp/sistemas_distribuidos/grupo1/election/coordinator");
    client.subscribe("utp/sistemas_distribuidos/grupo1/mutex/status");
    client.subscribe("utp/sistemas_distribuidos/grupo1/+/telemetry");
    client.subscribe("utp/sistemas_distribuidos/grupo1/election/lease");
  });

  client.on("message", (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      // A. Mensajes de Telemetría (Actualización frecuente)
      if (topic.includes("/telemetry")) {
        handleTelemetry(payload);
      }
      // B. Mensajes de Coordinador (Cambio de Líder)
      else if (topic.includes("election/coordinator")) {
        handleLeaderChange(payload);
      }
      // C. Mensajes de Mutex (Cola)
      else if (topic.includes("mutex/status")) {
        updateVisualQueue(payload.queue, payload.holder);
      }
    } catch (e) {
      console.error("Error parseando mensaje:", e);
    }
  });

  client.on("offline", () => {
    document.getElementById("connection-status").innerText = "OFFLINE";
    document.getElementById("connection-status").style.backgroundColor =
      "#da3633"; // Red
  });
}

// ============================================================================
// 3. MANEJADORES DE EVENTOS
// ============================================================================

function handleTelemetry(data) {
  const id = data.deviceId;

  // 1. Actualizar Datos en Memoria
  devices[id] = data;

  // 2. Actualizar Tarjeta Visual (Nivel Operativo)
  updateSensorCard(id, data);

  // 3. Animar Grafo (Nivel Estratégico)
  triggerTrafficAnimation(id);
}

function handleLeaderChange(payload) {
  const newLeader = payload.coordinatorId;
  if (currentLeader !== newLeader) {
    logEvent(
      "ELECTION",
      ` NUEVO LÍDER: ${newLeader} (Prio: ${payload.priority})`,
    );
    currentLeader = newLeader;

    // Actualizar Colores en Grafo
    const updates = nodesDataSet.get().map((node) => {
      if (node.id === "broker") return node;
      const isLeader = node.id === newLeader;
      return {
        id: node.id,
        color: isLeader ? "#d29922" : "#238636", // Gold vs Green
        borderWidth: isLeader ? 4 : 2,
        size: isLeader ? 35 : 25,
        label: isLeader
          ? node.label.replace("", "") + "\n"
          : node.label.replace("\n", ""), // Hack simple para label
      };
    });
    nodesDataSet.update(updates);

    // Actualizar Borde en Tarjetas
    document.querySelectorAll(".sensor-card").forEach((card) => {
      card.classList.remove("leader");
    });
    const card = document.getElementById(`card-${newLeader}`);
    if (card) card.classList.add("leader");
  }
}

function triggerTrafficAnimation(sensorId) {
  // Buscar el edge conectado a este sensor (asumimos ID sensor -> ID edge simple)
  // En nuestra config estática: 'sensor-001' -> edge index 0? No, busquemos por 'from'
  const edges = edgesDataSet.get({ filter: (item) => item.from === sensorId });
  if (edges.length > 0) {
    const edge = edges[0];

    // Efecto "Flash" en el enlace
    edgesDataSet.update({ id: edge.id, color: "#58a6ff", width: 5 }); // Azul brillante

    setTimeout(() => {
      edgesDataSet.update({ id: edge.id, color: "#30363d", width: 2 }); // Restaurar
    }, 150);
  }
}

// ============================================================================
// 4. COMPONENTES UI (RENDERIZADO)
// ============================================================================

function updateSensorCard(id, data) {
  const container = document.getElementById("sensor-grid");
  let card = document.getElementById(`card-${id}`);

  // Crear tarjeta si no existe
  if (!card) {
    card = document.createElement("div");
    card.id = `card-${id}`;
    card.className = "sensor-card";
    container.appendChild(card);
  }

  // Calcular Delta de Tiempo (Drift)
  const now = Date.now();
  const msgTime = new Date(data.timestamp).getTime();
  const delta = (now - msgTime) / 1000; // segundos
  const deltaColor = Math.abs(delta) > 2 ? "#da3633" : "#238636";

  // Estado del Mutex (si el sensor lo reporta)
  const mutexState = data.sensor_state || "IDLE";

  // Renderizar Contenido
  card.innerHTML = `
        <div class="sensor-header">
            <span>${id}</span>
            <span style="font-size: 0.8em; color: #8b949e">${mutexState}</span>
        </div>

        <div class="sensor-metric">
            <span class="metric-label">Temp</span>
            <span class="metric-value">${Number(data.temperatura).toFixed(1)}°C</span>
        </div>
        <div class="sensor-metric">
            <span class="metric-label">Hum</span>
            <span class="metric-value">${Number(data.humedad).toFixed(1)}%</span>
        </div>
        <div class="sensor-metric">
            <span class="metric-label">Latency</span>
            <span class="metric-value" style="color: ${deltaColor}">${delta.toFixed(2)}s</span>
        </div>

        <div class="vector-clock">
            L:${data.lamport_ts} | V:[${data.vector_clock.join(",")}]
        </div>
    `;

  // Efecto visual de actualización
  card.classList.add("flash-update");
  setTimeout(() => card.classList.remove("flash-update"), 500);
}

function updateVisualQueue(queue, holder) {
  const track = document.getElementById("mutex-queue-track");
  if (!track) return;
  track.innerHTML = "";

  // 1. Holder (Quien tiene el recurso)
  if (holder) {
    const node = document.createElement("div");
    node.className = "queue-node active-lock";
    node.innerHTML = ` <strong>${holder}</strong><br><small>EN SECCIÓN CRÍTICA</small>`;
    track.appendChild(node);

    // Flecha
    const arrow = document.createElement("div");
    arrow.innerText = "⬅";
    arrow.style.color = "#58a6ff";
    track.appendChild(arrow);
  } else {
    const empty = document.createElement("div");
    empty.innerText = " Recurso Libre";
    empty.style.color = "#238636";
    track.appendChild(empty);
  }

  // 2. Cola de Espera
  if (queue && queue.length > 0) {
    queue.forEach((waiter) => {
      const node = document.createElement("div");
      node.className = "queue-node";
      node.innerText = ` ${waiter}`;
      track.appendChild(node);
    });
  }
}

function logEvent(type, msg) {
  const list = document.getElementById("messages");
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-type" style="color: var(--accent-color)">${type}:</span> ${msg}`;
  list.prepend(li);
  if (list.children.length > 15) list.removeChild(list.lastChild);
}

// --- Arranque ---
initNetworkGraph();
connectToMqtt();
