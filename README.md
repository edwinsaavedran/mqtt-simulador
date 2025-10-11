# Simulador MQTT para Sistemas Distribuidos

Este proyecto es un simulador práctico desarrollado en Node.js para demostrar los conceptos de comunicación en sistemas distribuidos utilizando el protocolo MQTT. Sirve como material de trabajo para el curso de **Sistemas Distribuidos**.

La simulación se centra en un caso de uso de **Internet de las Cosas (IoT)**, donde un dispositivo sensor publica datos de telemetría (temperatura y humedad), y diferentes tipos de suscriptores consumen esta información.

---

## ## Arquitectura del Sistema

La arquitectura sigue el patrón **Publish/Subscribe**, que desacopla los componentes del sistema. El **Broker MQTT** actúa como intermediario central, gestionando la distribución de mensajes desde los publicadores hacia los suscriptores interesados.

# Estructura del Proyecto
.
├── config/               # Configuración centralizada de la aplicación
│   └── index.js          # Define el broker y la estructura de tópicos
├── publisher/            # Lógica de los clientes que publican mensajes
│   └── publisher.js      # Simulador del sensor IoT
├── subscriber/           # Lógica de los clientes que se suscriben a tópicos
│   ├── broadcast.js
│   ├── multicast.js
│   └── unicast.js
├── node_modules/         # Dependencias del proyecto
├── package.json          # Metadatos y dependencias del proyecto
└── README.md             # Esta documentación