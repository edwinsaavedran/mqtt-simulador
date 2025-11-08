// app.js

// --- Configuración ---
// OJO: Cambia 'localhost' por la IP de tu máquina si accedes
// desde otro dispositivo en tu red local. Si Docker está en la misma
// máquina donde abres el navegador, 'localhost' funciona.
const MQTT_BROKER_URL = 'ws://localhost:9001'; 
const CLIENT_ID = `web_monitor_${Math.random().toString(16).slice(2, 8)}`;

const TELEMETRY_TOPIC = 'utp/sistemas_distribuidos/grupo1/+/telemetry';
const STATUS_TOPIC = 'utp/sistemas_distribuidos/grupo1/+/status';

// --- Elementos del DOM ---
const connectionStatusEl = document.getElementById('connection-status');
const deviceListEl = document.getElementById('device-list');
const sensorCardsEl = document.getElementById('sensor-cards');
const messageLogEl = document.getElementById('message-log');
const browserTimeEl = document.getElementById('browser-time');
const monitorClockEl = document.getElementById('monitor-clock');
const monitorVectorClockEl = document.getElementById('monitor-vector-clock');

// --- Mostrar Hora del Navegador ---
function updateBrowserTime() {
    const now = new Date();
    browserTimeEl.textContent = `Hora del Navegador: ${now.toLocaleTimeString()}`;
}
//setInterval(updateBrowserTime, 1000);

// --- Estado de la Aplicación ---
let client;
const devices = {}; // Almacenará el estado y datos de cada dispositivo
// Reloj Lógico de Lamport para el Monitor
let lamportClock = 0;

// --- Configuración Reloj Vectorial del Monitor ---
/**
 * Definimos 4 procesos:
 * P_0: publisher-1
 * P_1: publisher-2
 * P_2: persistence-subscriber
 * P_3: web-monitor (nosotros)
 */
const VECTOR_PROCESS_COUNT_MONITOR = 4;
const PROCESS_ID_MONITOR = 3; // Nosotros somos el proceso 3
let vectorClock = new Array(VECTOR_PROCESS_COUNT_MONITOR).fill(0);
// Almacenará el último vector recibido para comparaciones
let lastReceivedVector = null;

// --- Funciones de Logging ---
function logMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    messageLogEl.innerHTML += `[${timestamp}] ${message}\n`;
    // Auto-scroll hacia abajo
    messageLogEl.scrollTop = messageLogEl.scrollHeight; 
}

// --- NUEVO: Función para actualizar el reloj del monitor ---
function updateMonitorClock() {
    monitorClockEl.textContent = `Reloj Lógico (Monitor): ${lamportClock}`;
}

function updateMonitorVectorClock() {
    monitorVectorClockEl.textContent = `Reloj Vectorial: [${vectorClock.join(',')}]`;
}

// --- Funciones de Actualización del DOM ---
function updateConnectionStatus(isConnected, error = null) {
    if (isConnected) {
        connectionStatusEl.textContent = 'Estado: Conectado';
        connectionStatusEl.classList.add('connected');
        connectionStatusEl.classList.remove('disconnected');
        logMessage('*** Conectado al Broker MQTT ***');
    } else {
        connectionStatusEl.textContent = `Estado: Desconectado ${error ? `(${error})` : ''}`;
        connectionStatusEl.classList.remove('connected');
        connectionStatusEl.classList.add('disconnected');
        logMessage(`*** Desconectado del Broker MQTT ${error ? `- ${error}` : ''} ***`);
    }
}

function updateDeviceStatus(deviceId, status) {
    if (!devices[deviceId]) {
        devices[deviceId] = { status: 'desconocido', telemetry: {} };
    }
    devices[deviceId].status = status.toLowerCase();

    let deviceEl = document.getElementById(`device-${deviceId}`);
    if (!deviceEl) {
        deviceEl = document.createElement('div');
        deviceEl.id = `device-${deviceId}`;
        deviceEl.classList.add('device-status-item');
        deviceListEl.appendChild(deviceEl);
    }

    deviceEl.innerHTML = `
        <span class="device-id">${deviceId}</span>
        <span class="status-indicator ${devices[deviceId].status}">${status.toUpperCase()}</span>
    `;
    
    // Actualizar también la tarjeta si existe
    updateSensorCard(deviceId);
}

function updateSensorCard(deviceId) {
    if (!devices[deviceId]) return; // No hay datos aún

    let cardEl = document.getElementById(`card-${deviceId}`);
    if (!cardEl) {
        cardEl = document.createElement('div');
        cardEl.id = `card-${deviceId}`;
        cardEl.classList.add('sensor-card');
        sensorCardsEl.appendChild(cardEl);
    }
    
    const deviceData = devices[deviceId];
    const statusClass = deviceData.status === 'online' ? 'online' : 'offline';

    let time = 'N/A';
    let timeCorregido = 'N/A';
    let timeSimulado = 'N/A';
    let offset = 'N/A';
    let delta = 'N/A';
    let deltaClass = '';

    if (deviceData.telemetry.timestamp) {
        const sensorTime = new Date(deviceData.telemetry.timestamp);
        time = sensorTime.toLocaleTimeString();

        const sensorTimeCorrected = new Date(deviceData.telemetry.timestamp);
        const browserTime = new Date();
        timeCorregido = sensorTimeCorrected.toLocaleTimeString('en-GB', { hour12: false });
        
        // Calculamos la diferencia en segundos
        //const deltaSeconds = (sensorTime.getTime() - browserTime.getTime()) / 1000;

        const deltaSeconds = (sensorTimeCorrected.getTime() - browserTime.getTime()) / 1000;
        delta = `${deltaSeconds.toFixed(1)} s`;
        if (deltaSeconds > 1.5) { // Damos un margen de 1.5s
            deltaClass = 'delta-positive';
        } else if (deltaSeconds < -1.5) {
            deltaClass = 'delta-negative';
        }

        // delta = `${deltaSeconds.toFixed(1)} s`;
        // if (deltaSeconds > 1) {
        //     deltaClass = 'delta-positive'; // El sensor está en el "futuro"
        // } else if (deltaSeconds < -1) {
        //     deltaClass = 'delta-negative'; // El sensor está en el "pasado"
        // }
    }

    if (deviceData.telemetry.timestamp_simulado) {
        timeSimulado = new Date(deviceData.telemetry.timestamp_simulado).toLocaleTimeString('en-GB', { hour12: false });
    }
    
    if (deviceData.telemetry.clock_offset) {
        offset = `${deviceData.telemetry.clock_offset} ms`;
    }

    const temp = deviceData.telemetry.temperatura !== undefined ? `${deviceData.telemetry.temperatura} °C` : 'N/A';
    const hum = deviceData.telemetry.humedad !== undefined ? `${deviceData.telemetry.humedad} %` : 'N/A';
    const lamport_ts = deviceData.telemetry.lamport_ts !== undefined ? deviceData.telemetry.lamport_ts : 'N/A';

    const vector_clock = deviceData.telemetry.vector_clock ? 
        `[${deviceData.telemetry.vector_clock.join(',')}]` : 'N/A';

    cardEl.innerHTML = `
        <h3>${deviceId} <span class="status-indicator ${statusClass}">${deviceData.status.toUpperCase()}</span></h3>
        <p>Temperatura: <strong>${temp}</strong></p>
        <p>Humedad: <strong>${hum}</strong></p>
        <p>T. Corregido: <strong>${timeCorregido}</strong></p>
        <p>T. Simulado: <span class="${deltaClass}">${timeSimulado}</span></p>
        <p>Offset Aplicado: <strong>${offset}</strong></p>
        <p class="delta ${deltaClass}">Delta (Corregido - Navegador): <strong>${delta}</strong></p>
        <p>Lamport TS (Sensor): <strong>${lamport_ts}</strong></p>
        <p>Vector (Sensor): <strong>${vector_clock}</strong></p>
    `;
}

// --- Lógica MQTT ---
function connectToMqtt() {
    logMessage(`Intentando conectar a ${MQTT_BROKER_URL}...`);
    client = mqtt.connect(MQTT_BROKER_URL, {
        clientId: CLIENT_ID,
        clean: true, // Empezar sesión limpia
        connectTimeout: 4000, // Tiempo de espera para conectar
    });

    client.on('connect', () => {
        updateConnectionStatus(true);
        
        client.subscribe(TELEMETRY_TOPIC, { qos: 0 }, (err) => { // QoS 0 para telemetría es común
            if (!err) {
                logMessage(`Suscrito a telemetría: ${TELEMETRY_TOPIC}`);
            } else {
                logMessage(`Error al suscribirse a telemetría: ${err}`);
            }
        });

        client.subscribe(STATUS_TOPIC, { qos: 1 }, (err) => { // QoS 1 para estado es importante
            if (!err) {
                logMessage(`Suscrito a estado: ${STATUS_TOPIC}`);
            } else {
                logMessage(`Error al suscribirse a estado: ${err}`);
            }
        });
    });

    client.on('message', (topic, message) => {
        // --- REGLA 1 (VECTORIAL): Evento interno ---
        // Incrementamos nuestro propio reloj (P_3)
        vectorClock[PROCESS_ID_MONITOR]++;
        // Incrementamos el reloj del monitor por el evento de "recibir"
        lamportClock++;

        const messageString = message.toString();
        logMessage(`Mensaje recibido en [${topic}] (Reloj Monitor: ${lamportClock})`);

        try {
            const data = JSON.parse(messageString);
            const deviceId = data.deviceId;

            if (!deviceId) {
                logMessage("Mensaje recibido sin deviceId, ignorando.");
                return;
            }

            // --- (LAMPORT): Parte 2 (Fusión) ---
            const receivedLamportTS = data.lamport_ts || 0;
            lamportClock = Math.max(lamportClock, receivedLamportTS);
            updateMonitorClock();

            const receivedVectorClock = data.vector_clock;
            if (receivedVectorClock && Array.isArray(receivedVectorClock)) {
                // Rellenamos el vector recibido si es más corto (ej. P_0 no sabe de P_3)
                while (receivedVectorClock.length < VECTOR_PROCESS_COUNT_MONITOR) {
                    receivedVectorClock.push(0);
                }
                
                // Fusionamos
                for (let i = 0; i < VECTOR_PROCESS_COUNT_MONITOR; i++) {
                    vectorClock[i] = Math.max(vectorClock[i], receivedVectorClock[i]);
                }
                updateMonitorVectorClock();
                logMessage(`[VECTOR] Fusión: [${receivedVectorClock.join(',')}] -> [${vectorClock.join(',')}]`);

                // --- NUEVO: Detección de Concurrencia ---
                checkConcurrency(receivedVectorClock);
                lastReceivedVector = receivedVectorClock; // Guardamos para la próxima comparación
            }

            // Inicializar si es la primera vez que vemos este deviceId
            if (!devices[deviceId]) {
                 devices[deviceId] = { status: 'desconocido', telemetry: {} };
            }

            if (topic.includes('/status')) {
                updateDeviceStatus(deviceId, data.status);
            } else if (topic.includes('/telemetry')) {
                devices[deviceId].telemetry = data; // Guardar últimos datos
                updateSensorCard(deviceId); 
                if (devices[deviceId].status === 'desconocido' || devices[deviceId].status === 'offline') {
                    updateDeviceStatus(deviceId, 'online');
                }
            }
        } catch (e) {
            logMessage(`Error procesando mensaje JSON: ${e.message}`);
        }
    });

    client.on('error', (err) => {
        updateConnectionStatus(false, err.message);
        logMessage(`Error MQTT: ${err.message}`);
        // Intentar reconectar después de un tiempo podría ser una opción aquí
        // client.end(); // Podríamos cerrar o dejar que intente reconectar
    });

    client.on('close', () => {
        // Se llama si la conexión se cierra limpiamente o después de errores
        if (connectionStatusEl.textContent !== 'Estado: Desconectado') { // Evitar doble log si ya hubo error
             updateConnectionStatus(false);
        }
    });

    client.on('offline', () => {
        updateConnectionStatus(false, 'Cliente desconectado');
    });

    client.on('reconnect', () => {
        logMessage('Intentando reconectar...');
    });
}

// --- NUEVO: Función para comparar relojes vectoriales ---
/**
 * Compara dos relojes vectoriales (A y B)
 * @returns 'A_BEFORE_B', 'B_BEFORE_A', 'CONCURRENT'
 */
function compareVectorClocks(vA, vB) {
    let a_lt_b = false;
    let b_lt_a = false;
    for (let i = 0; i < vA.length; i++) {
        if (vA[i] < vB[i]) {
            a_lt_b = true;
        } else if (vA[i] > vB[i]) {
            b_lt_a = true;
        }
    }
    if (a_lt_b && !b_lt_a) return 'A_BEFORE_B';
    if (b_lt_a && !a_lt_b) return 'B_BEFORE_A';
    return 'CONCURRENT';
}

function checkConcurrency(newVector) {
    if (lastReceivedVector) {
        const relation = compareVectorClocks(lastReceivedVector, newVector);
        if (relation === 'CONCURRENT') {
            logMessage(`[CONCURRENCIA] Evento [${newVector.join(',')}] es CONCURRENTE con [${lastReceivedVector.join(',')}]`);
        } else {
             logMessage(`[ORDEN] Evento [${lastReceivedVector.join(',')}] sucedió ${relation.replace('_', ' ')} [${newVector.join(',')}]`);
        }
    } else {
        logMessage(`[VECTOR] Primer evento recibido [${newVector.join(',')}]`);
    }
}

// --- Iniciar Conexión y Reloj ---
connectToMqtt();
updateBrowserTime();
setInterval(updateBrowserTime, 1000);
updateMonitorClock();
updateMonitorVectorClock(); // Inicializar reloj vectorial en UI