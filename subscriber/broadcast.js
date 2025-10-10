const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  client.subscribe("sistema/broadcast/#", { qos: 1 }); // # acepta todos los subtopics
  console.log("Nodo global esperando broadcast...");
});

client.on("message", (topic, message) => {
  console.log(`[BROADCAST] Mensaje en ${topic}: ${message.toString()}`);
});
