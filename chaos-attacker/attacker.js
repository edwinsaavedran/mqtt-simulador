// chaos-attacker/attacker.js
const mqtt = require('mqtt');

// Configuración Hardcoded para el atacante (Debe coincidir con la red de su solución)
const BROKER_URL = process.env.BROKER_URL || 'mqtt://localhost:1883';
const ATTACK_INTERVAL = 2000;

console.log(`[CHAOS] Iniciando Nodo Atacante v1.0. Conectando a ${BROKER_URL}...`);

const client = mqtt.connect(BROKER_URL, {
    clientId: 'unknown-attacker-' + Math.random().toString(16).substr(2, 8)
});

client.on('connect', () => {
    console.log('[CHAOS] Conexión establecida. Iniciando inyección de fallos.');
    startAttacks();
});

function startAttacks() {
    setInterval(() => {
        const attackType = Math.random() > 0.5 ? 'MUTEX_POISON' : 'CLOCK_SKEW';

        if (attackType === 'MUTEX_POISON') {
            // ATAQUE 1: Liberación Falsa de Recursos
            // Intenta liberar el recurso fingiendo ser un ID aleatorio
            const fakeId = `sensor-00${Math.floor(Math.random() * 5) + 1}`;
            console.log(`[ATTACK] Enviando liberación falsa para: ${fakeId}`);

            client.publish('mutex/release', JSON.stringify({
                deviceId: fakeId,
                force: true // Payload inesperado
            }));
        } else {
            // ATAQUE 2: Corrupción de Reloj Vectorial
            // Se envía un reloj lógico absurdo para romper la causalidad
            console.log(`[ATTACK] Inyectando Salto Temporal Vectorial`);

            client.publish('sensors/telemetry/chaos', JSON.stringify({
                deviceId: 'chaos-node',
                temperatura: 9999,
                timestamp: new Date().toISOString(),
                // Vector Clock corrupto: salto mayor a 10 unidades
                vector_clock: [5000, 0, 0],
                lamport_ts: 99999
            }));
        }
    }, ATTACK_INTERVAL);
}

client.on('error', (err) => {
    console.error('[ERROR] ', err.message);
});