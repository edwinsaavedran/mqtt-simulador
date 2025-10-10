const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  client.subscribe("sistema/unicast/usuarioA", { qos: 1 });
  console.log("Usuario A esperando mensaje unicast...");
});

client.on("message", (topic, message) => {
  console.log(`[UNICAST] Mensaje en ${topic}: ${message.toString()}`);
});
