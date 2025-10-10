const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  client.subscribe("sistema/multicast/zonaNorte", { qos: 1 });
  console.log("Nodo Zona Norte esperando multicast...");
});

client.on("message", (topic, message) => {
  console.log(`[MULTICAST] Mensaje en ${topic}: ${message.toString()}`);
});
