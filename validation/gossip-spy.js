const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://localhost:1883');

// Mapa de la visión del mundo: Quién ve a quién
const networkView = {};

console.log("  [SPY] Escuchando canales de Gossip (internal/gossip/#)...");

client.on('connect', () => {
    client.subscribe('internal/gossip/#');

    // Matar el espía en 30 segundos
    setTimeout(() => {
        analyzeTopology();
        process.exit(0);
    }, 30000);
});

client.on('message', (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        // Asumimos payload: { senderId: "node-1", knownPeers: ["node-2", "node-3"] }
        if (payload.senderId && Array.isArray(payload.knownPeers)) {
            networkView[payload.senderId] = payload.knownPeers.length;
            process.stdout.write('.'); // Feedback visual
        }
    } catch (e) { }
});

function analyzeTopology() {
    console.log("\n\n [SPY] Reporte de Topología:");
    console.table(networkView);

    const nodes = Object.keys(networkView);
    if (nodes.length < 3) {
        console.error(" [FAIL] Menos de 3 nodos reportando. El protocolo Gossip no funciona.");
    } else {
        const avgPeers = Object.values(networkView).reduce((a, b) => a + b, 0) / nodes.length;
        if (avgPeers >= 2) {
            console.log(" [PASS] Topología saludable. Los nodos se conocen entre sí.");
        } else {
            console.log(" [WARN] Conocimiento parcial. Convergencia lenta.");
        }
    }
    client.end();
}