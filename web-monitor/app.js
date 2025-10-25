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

// --- Estado de la Aplicación ---
let client;
const devices = {}; // Almacenará el estado y datos de cada dispositivo

// --- Funciones de Logging ---
function logMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    messageLogEl.innerHTML += `[${timestamp}] ${message}\n`;
    // Auto-scroll hacia abajo
    messageLogEl.scrollTop = messageLogEl.scrollHeight; 
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
    const temp = deviceData.telemetry.temperatura !== undefined ? `${deviceData.telemetry.temperatura} °C` : 'N/A';
    const hum = deviceData.telemetry.humedad !== undefined ? `${deviceData.telemetry.humedad} %` : 'N/A';
    const time = deviceData.telemetry.timestamp ? new Date(deviceData.telemetry.timestamp).toLocaleTimeString() : 'N/A';

    cardEl.innerHTML = `
        <h3>${deviceId} <span class="status-indicator ${statusClass}">${deviceData.status.toUpperCase()}</span></h3>
        <p>Temperatura: <strong>${temp}</strong></p>
        <p>Humedad: <strong>${hum}</strong></p>
        <p>Última act.: ${time}</p>
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
        const messageString = message.toString();
        logMessage(`Mensaje recibido en [${topic}]: ${messageString}`);
        
        try {
            const data = JSON.parse(messageString);
            const deviceId = data.deviceId;

            if (!deviceId) {
                logMessage("Mensaje recibido sin deviceId, ignorando.");
                return;
            }

            // Inicializar si es la primera vez que vemos este deviceId
            if (!devices[deviceId]) {
                 devices[deviceId] = { status: 'desconocido', telemetry: {} };
            }

            if (topic.includes('/status')) {
                updateDeviceStatus(deviceId, data.status);
            } else if (topic.includes('/telemetry')) {
                devices[deviceId].telemetry = data; // Guardar últimos datos
                updateSensorCard(deviceId); // Actualizar la tarjeta con nuevos datos
                // Asegurarse de que el estado en la lista también se actualice si vemos telemetría
                if (devices[deviceId].status === 'desconocido' || devices[deviceId].status === 'offline') {
                    updateDeviceStatus(deviceId, 'online'); // Asumimos online si envía telemetría
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

// --- Iniciar Conexión ---
connectToMqtt();