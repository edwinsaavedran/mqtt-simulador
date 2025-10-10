const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.hivemq.com");

client.on("connect", () => {
  console.log("Conectado al broker MQTT");

  // UNICAST
  client.publish("sistema/unicast/usuarioA", "Mensaje privado a Usuario A", {
    qos: 1,
    retain: true,
  });

  // MULTICAST
  client.publish(
    "sistema/multicast/zonaNorte",
    "Actualización para Zona Norte",
    {
      qos: 1,
      retain: true,
    },
  );

  // BROADCAST
  client.publish("sistema/broadcast/general", "ALARMA GLOBAL: Servicio caído", {
    qos: 1,
    retain: true,
  });

  console.log("Mensajes enviados con QoS 1 y retención activada");
});
