# Contrato de topicos MQTT

Este documento audita los topicos MQTT usados por el simulador. La fuente central para los servicios Node.js es `config/index.js`; el monitor web mantiene constantes equivalentes en `web-monitor/app.js` porque corre en el navegador y no puede importar el modulo CommonJS directamente.

## Namespace activo

| Campo | Valor |
|-------|-------|
| Base | `utp/sistemas_distribuidos/grupo1` |
| Catch-all | `utp/sistemas_distribuidos/grupo1/#` |
| Broker interno Docker | `mqtt://mqtt-broker:1883` |
| Broker WebSocket local | `ws://localhost:9001` |

## Topicos activos

| Topico | Direccion / publicador | Suscriptores | Payload | Notas de validacion / auditoria |
|--------|-------------------------|--------------|---------|----------------------------------|
| `utp/sistemas_distribuidos/grupo1/<deviceId>/telemetry` | `publisher` por cada sensor | `persistence-subscriber`, `multicast`, `broadcast`, `web-monitor`; `unicast` para un `DEVICE_ID` especifico | `{ "deviceId": string, "processId": number, "vectorIndex": number, "temperatura": string, "humedad": string, "timestamp": ISO-8601 string, "lamport_ts": number, "vector_clock": number[], "sensor_state": string }` | `persistence-subscriber` descarta mensajes sin identidad causal auditable, vector invalido, `deviceId`, `temperatura` o `humedad`. Tambien rechaza skew temporal mayor a 2000 ms salvo rescate Lamport/vector documentado. `temperatura` y `humedad` se publican como strings por uso de `toFixed(2)`. |
| `utp/sistemas_distribuidos/grupo1/<deviceId>/status` | `publisher` al conectar, al caer por caos y como Last Will | `monitor`, `broadcast`, `web-monitor` | `{ "deviceId": string, "status": "online" | "offline" }` | Es retenido en el Last Will y en publicaciones online/offline. El monitor ignora payloads sin `deviceId` o `status`. |
| `utp/sistemas_distribuidos/grupo1/time/request` | `publisher` durante sincronizacion | `time-server`, `broadcast` | `{ "deviceId": string, "t1": number }` | `t1` es `Date.now()` del publisher al publicar la solicitud y permite calcular RTT al recibir la respuesta. |
| `utp/sistemas_distribuidos/grupo1/time/response/<deviceId>` | `time-server` | `publisher` correspondiente, `broadcast`, `web-monitor` via catch-all | `{ "deviceId": string, "t1": number, "serverReceivedAt": number, "serverTime": number }` | El publisher acepta la sincronizacion solo si `deviceId` coincide, los campos temporales son numericos y `0 <= RTT <= 500 ms`. |
| `utp/sistemas_distribuidos/grupo1/mutex/request` | `publisher` no coordinador cuando solicita calibracion | `publisher` que actua como coordinador; `lock-coordinator` si se habilita; `broadcast`, `web-monitor` via catch-all | `{ "deviceId": string }` | Activo en `publisher` cuando un nodo se vuelve coordinador. `lock-coordinator` existe pero esta fuera del flujo activo de `docker-compose.yml`. |
| `utp/sistemas_distribuidos/grupo1/mutex/release` | `publisher` al salir de la seccion critica | `publisher` coordinador; `lock-coordinator` si se habilita; `broadcast`, `web-monitor` via catch-all | `{ "deviceId": string }` | El coordinador ignora liberaciones de nodos que no poseen el recurso. |
| `utp/sistemas_distribuidos/grupo1/mutex/grant/<deviceId>` | `publisher` coordinador o `lock-coordinator` | `publisher` correspondiente, `broadcast`, `web-monitor` via catch-all | `{ "status": "granted" }` | Usa QoS 1 en publicacion de grant. |
| `utp/sistemas_distribuidos/grupo1/mutex/status` | `publisher` coordinador o `lock-coordinator` | `web-monitor`, `broadcast` | `{ "isAvailable": boolean, "holder": string | null, "queue": string[] }` | Se publica con retain para que el monitor reciba el ultimo estado. |
| `utp/sistemas_distribuidos/grupo1/election/heartbeat` | `publisher` no coordinador; `lock-coordinator` si se habilita | `publisher`, `lock-coordinator`, `broadcast`, `web-monitor` via catch-all | `{ "type": "PING" | "PONG", "fromPriority": number }` | Actualmente `publisher` publica `PING`; `lock-coordinator` puede responder `PONG` si se habilita. |
| `utp/sistemas_distribuidos/grupo1/election/messages` | `publisher`; `lock-coordinator` si se habilita | `publisher`, `lock-coordinator`, `broadcast`, `web-monitor` via catch-all | `{ "type": "ELECTION" | "ALIVE", "fromPriority": number, "toPriority"?: number }` | Canal del algoritmo Bully. La semantica formal de quorum, lease y split-brain esta definida en `docs/ELECTION_DESIGN.md`. |
| `utp/sistemas_distribuidos/grupo1/election/coordinator` | `publisher` ganador o `lock-coordinator` si se habilita | `publisher`, `web-monitor`, `broadcast` | `{ "type": "VICTORY", "coordinatorId": string, "priority": number }` | Mensaje retenido para anunciar lider actual. La semantica formal de termino/electionId esta definida en `docs/ELECTION_DESIGN.md`. |
| `utp/sistemas_distribuidos/grupo1/election/lease` | `publisher` lider | `publisher`, `broadcast`, `web-monitor` via catch-all | `{ "term": number, "electionId": string, "leaderId": string, "coordinatorId": string, "priority": number, "issuedAt": number, "leaseUntil": number }` | Phase 4.4 activa lease formal. Mensaje retenido; un lease expirado o malformado se ignora. |
| `utp/sistemas_distribuidos/grupo1/election/quorum/check` | `publisher` candidato | `publisher`, `broadcast`, `web-monitor` via catch-all | `{ "term": number, "electionId": string, "candidateId": string, "candidatePriority": number }` | Cada nodo concede como maximo un voto por termino y rechaza votos si observa un lease vigente para otro lider. |
| `utp/sistemas_distribuidos/grupo1/election/quorum/ack` | `publisher` receptor de quorum check | `publisher` candidato, `broadcast`, `web-monitor` via catch-all | `{ "term": number, "electionId": string, "candidateId": string, "voterId": string }` | El candidato solo cuenta votos para su `term`, `electionId`, `candidateId` y por `voterId` unico. |
| `utp/sistemas_distribuidos/grupo1/chaos/control` | `web-monitor` | `publisher` | `{ "targetId": string, "action": "KILL" | "REVIVE" }` | Canal operativo para simular fallos. `publisher` solo procesa comandos dirigidos a su `DEVICE_ID`. |

## Topicos legacy o inconsistentes en scripts

| Archivo | Topico observado | Estado | Nota |
|---------|------------------|--------|------|
| `assessment-runner.sh` | `mutex/request` | Stale | El contrato activo es `utp/sistemas_distribuidos/grupo1/mutex/request`. Mantener como pendiente porque el script cubre evaluaciones futuras de snapshot/WAL. |
| `chaos-attacker/attacker.js` | `mutex/release` | Stale | El contrato activo es `utp/sistemas_distribuidos/grupo1/mutex/release`. Si se migra, el atacante empezara a impactar el flujo real de mutex. |
| `chaos-attacker/attacker.js` | `sensors/telemetry/chaos` | Stale | El contrato activo de telemetria es `utp/sistemas_distribuidos/grupo1/<deviceId>/telemetry`. |
| `validation/saga-validator.sh` | `cmd/saga/rotate` | Futuro/no implementado | No hay consumidores Saga activos en esta fase. Ademas contiene un sufijo `ss` despues del payload que parece error tipografico. |
| `gamemaker/uprising.sh` | `cmd/saga/start` | Futuro/no implementado | No hay consumidores Saga activos en esta fase. |
| `validation/gossip-spy.js` | `internal/gossip/#` | Futuro/no implementado | No se encontraron publishers activos de gossip. |
| `gamemaker/arena-tracker.js` | `internal/gossip/#` | Futuro/no implementado | No se encontraron publishers activos de gossip. |

## Pendientes fuera de Phase 1

| Area | Pendiente |
|------|-----------|
| Cristian | La excepcion de rescate Lamport/vector ya esta acotada a identidad causal auditable. Ver `docs/CAUSALITY.md`. |
| Eleccion y quorum | Phase 4.5 ya implementa quorum formal, lease retenido y rechazo de votos cuando existe lease vigente para otro lider. Queda agregar pruebas end-to-end de pausa/reanudacion para Phase 4.6. |
| Scripts de validacion | Decidir cuales scripts son parte del flujo actual y migrar solo esos a los topicos canonicos. |
| Saga y gossip | Implementar consumidores/productores antes de validar esos escenarios. |
