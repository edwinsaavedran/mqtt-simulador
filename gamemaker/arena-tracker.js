// gamemaker/arena-tracker.js
const mqtt = require('mqtt');

// Configuración
const BROKER_URL = process.env.BROKER_URL || 'mqtt://localhost:1883';
const REQUIRED_NODES = 4; // Ajustar según el docker-compose
const TIMEOUT_MS = 15000;

const client = mqtt.connect(BROKER_URL);
const networkMap = new Map();

console.log(`   [RASTREVÍSPULA] Inyectando espía en ${BROKER_URL}...`);

client.on('connect', () => {
    client.subscribe('internal/gossip/#');

    // Cuenta regresiva de muerte
    setTimeout(() => {
        analyze();
        process.exit(1); // Asumimos fallo si llega al timeout
    }, TIMEOUT_MS);
});

client.on('message', (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        // payload esperado: { senderId: "node-1", knownNodes: ["node-1", "node-2"...] }

        if (payload.senderId && Array.isArray(payload.knownNodes)) {
            networkMap.set(payload.senderId, payload.knownNodes.length);
            process.stdout.write('%'); // Efecto visual de enjambre 
        }
    } catch (e) { }
});

function analyze() {
    console.log("\n   [RASTREVÍSPULA] Reporte de Inteligencia:");

    let healthyNodes = 0;
    networkMap.forEach((count, node) => {
        console.log(`     - Nodo ${node} conoce a ${count} pares.`);
        if (count >= REQUIRED_NODES - 1) healthyNodes++;
    });

    if (healthyNodes >= REQUIRED_NODES) {
        console.log("   [EXITO] La colmena está conectada.");
        process.exit(0);
    } else {
        console.log(`   [FALLO] Solo ${healthyNodes}/${REQUIRED_NODES} nodos tienen visión completa. La inspección no fluye.`);
        process.exit(1);
    }
}