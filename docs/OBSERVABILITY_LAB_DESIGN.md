# Diseno del Observatorio de Algoritmos Distribuidos

Este documento define la arquitectura objetivo para convertir el simulador MQTT en un observatorio de algoritmos distribuidos: cada algoritmo debe emitir eventos explicables, el visor debe mostrar decisiones y efectos, y cada escenario debe dejar evidencia exportable.

## Resultado Esperado

El proyecto debe pasar de "servicios que publican logs" a un laboratorio donde se pueda responder, con datos visibles:

- Que algoritmo esta corriendo.
- Que nodo tomo una decision.
- Que evidencia uso para tomarla.
- Que invariant se mantuvo o se rompio.
- Que efecto produjo el caos, el stress, la escala o la recuperacion.
- Que evidencia se puede adjuntar para revision academica o tecnica.

## Vision

El sistema sera un **Observatorio de Algoritmos Distribuidos** sobre MQTT, Docker Compose e InfluxDB. Los publishers, subscribers, coordinadores y validadores emitiran eventos normalizados a un bus de observabilidad. El monitor web consumira esos eventos para mostrar topologia, timeline, paneles por algoritmo, metricas y escenarios reproducibles.

La prioridad es explicar comportamiento distribuido bajo situaciones real-simuladas antes de agregar mas algoritmos. Berkeley, NTP, Ring, Raft, Gossip o Saga no deben entrar como demos aisladas: deben entrar con contrato observable desde el dia uno.

## No Objetivos

- No implementar Berkeley, NTP, Ring, Raft, Gossip ni Saga en este documento.
- No reemplazar MQTT por Kafka, OpenTelemetry Collector o Prometheus en la primera etapa.
- No convertir el laboratorio en una plataforma de observabilidad generica.
- No prometer garantias que el modelo actual no tiene, como consenso fuerte o WAL replicado.
- No migrar todo el frontend a un framework antes de tener eventos correctos.
- No usar logs textuales como fuente primaria de evidencia nueva.

## Baseline Actual

| Area | Estado actual | Fuente |
|------|---------------|--------|
| Broker | Mosquitto con MQTT TCP `1883` y WebSocket `9001` | `docker-compose.yml`, `config/index.js` |
| Topicos canonicos | Namespace `utp/sistemas_distribuidos/grupo1` | `docs/TOPICS.md`, `config/index.js` |
| Nodos activos | Cinco publishers `sensor-001` a `sensor-005` | `docker-compose.yml` |
| Reloj fisico | Cristian con drift simulado y descarte por RTT mayor a `500 ms` | `publisher/publisher.js`, `time-server/time-server.js`, `docs/SYNCHRONIZATION.md` |
| Relojes logicos | Lamport y vector clocks de cinco procesos | `publisher/publisher.js`, `subscriber/persistence-subscriber.js`, `docs/CAUSALITY.md` |
| Persistencia | InfluxDB measurement `sensor_data` para telemetria validada | `subscriber/persistence-subscriber.js` |
| Causalidad | Barrera temporal de `2000 ms` con rescate Lamport/vectorial acotado | `docs/SYNCHRONIZATION.md`, `docs/CAUSALITY.md` |
| Eleccion | Bully-like con roles `FOLLOWER`, `CANDIDATE`, `LEADER`, quorum 3/5 y lease | `publisher/publisher.js`, `docs/ELECTION_DESIGN.md` |
| Mutex | Coordinador dinamico dentro del publisher lider con fencing por lease | `publisher/publisher.js` |
| WAL | WAL local por publisher lider para cola/holder de mutex | `publisher/publisher.js`, `EVIDENCIAS.md` |
| Visor | Web monitor con grafo, tarjetas, cola mutex y control KILL/REVIVE | `web-monitor/app.js` |
| Evidencia | `chaos-ultimate.sh` valida por scripts y grep de logs | `chaos-ultimate.sh`, `EVIDENCIAS.md` |

## Limitaciones Actuales

| Limitacion | Impacto | Direccion de mejora |
|------------|---------|---------------------|
| Los logs son la evidencia principal de decisiones internas | El visor no puede reconstruir causalidad completa ni explicar por que ocurrio algo | Emitir eventos estructurados por algoritmo |
| El monitor consume catch-all y deduce por strings de topico | Acopla visualizacion a payloads heterogeneos | Crear topicos `observability/*` con contrato estable |
| InfluxDB guarda telemetria, no eventos de algoritmo | No hay consultas historicas uniformes para elecciones, leases, caos o WAL | Persistir eventos observables en measurement separada |
| `lock-coordinator` es legado y no esta activo en Compose | Puede confundir el modelo de mutex actual | Documentarlo como legacy hasta retirarlo o migrarlo |
| `chaos-ultimate.sh` valida con `docker logs` y `grep` | Evidencia fragil y dificil de exportar desde el visor | Escenarios con `scenarioId`, eventos y reporte JSON |
| No hay contrato comun de correlacion | Es dificil unir causa: comando de caos, eleccion, lease, mutex y recuperacion | Introducir `eventId`, `scenarioId`, `correlationId`, `causationId` |
| README esta por detras de la arquitectura real | Explica `lock-coordinator` como coordinador principal aunque Compose lo tiene comentado | Actualizar despues del primer PR de observabilidad |

## Principio Arquitectonico

Todo evento importante debe ser **emitido una vez, consumible por muchos**.

Los servicios no deben emitir eventos pensando en el frontend. Deben emitir hechos del dominio distribuido. El visor, persistencia y validadores son consumidores.

## Contrato de Evento Observable

### Topico Canonico

```text
utp/sistemas_distribuidos/grupo1/observability/events/<algorithm>/<eventType>
```

Ejemplos:

```text
utp/sistemas_distribuidos/grupo1/observability/events/physical-clock/cristian-sync-accepted
utp/sistemas_distribuidos/grupo1/observability/events/election/leader-elected
utp/sistemas_distribuidos/grupo1/observability/events/mutex/mutex-granted
utp/sistemas_distribuidos/grupo1/observability/events/chaos/node-paused
```

### Sobre Comun

Todos los eventos deben compartir este sobre:

```json
{
  "schemaVersion": "observability-event/v1",
  "eventId": "01JY7R7T0K8Y3P4D7E4F9G2H1A",
  "eventType": "leader-elected",
  "algorithm": "election",
  "emittedAt": "2026-05-27T10:15:30.250Z",
  "nodeId": "sensor-005",
  "processId": 5,
  "role": "LEADER",
  "scenarioId": "split-brain-drill-20260527-1015",
  "correlationId": "election-sensor-005-1779876930250",
  "causationId": "01JY7R7P9Q9W2M8D7K1S3Z6C4N",
  "severity": "info",
  "summary": "sensor-005 became leader after quorum 3/5",
  "data": {}
}
```

### Reglas del Sobre

| Campo | Regla |
|-------|-------|
| `schemaVersion` | Obligatorio. Cambia solo con migracion explicita. |
| `eventId` | Obligatorio. Unico por evento. Puede ser ULID o UUID. |
| `eventType` | Obligatorio. Nombre estable en kebab-case. |
| `algorithm` | Obligatorio. Categoria de taxonomia. |
| `emittedAt` | Obligatorio. Hora real del proceso emisor en ISO-8601. |
| `nodeId` | Obligatorio si el evento pertenece a un nodo. Usar `system`, `broker`, `time-server` o `persistence-subscriber` cuando aplique. |
| `processId` | Opcional, pero recomendado para publishers. |
| `role` | Opcional. Estado local del nodo al emitir. |
| `scenarioId` | Obligatorio para eventos producidos dentro de un escenario ejecutado por runner. `null` fuera de escenario. |
| `correlationId` | Obligatorio cuando varios eventos pertenecen a la misma operacion. |
| `causationId` | Opcional. Apunta al evento que causo este evento. |
| `severity` | `debug`, `info`, `warn`, `error` o `critical`. |
| `summary` | Frase corta para timeline. No debe ser la unica fuente de datos. |
| `data` | Payload especifico del evento. Debe ser JSON plano y serializable. |

### Reglas de Compatibilidad

- Los eventos nuevos deben agregarse sin romper consumidores existentes.
- Si cambia el significado de un campo, se crea `schemaVersion` nueva.
- El visor debe ignorar eventos desconocidos y mostrarlos en un panel generico.
- Los scripts de evidencia deben fallar si falta un campo obligatorio.

## Taxonomia de Eventos por Algoritmo

### Relojes Fisicos

Algoritmos objetivo: Cristian actual, Berkeley futuro, NTP futuro.

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `clock-drift-sampled` | publisher | Antes de publicar telemetria o en intervalo fijo | `simulatedTime`, `realTime`, `clockOffsetMs`, `driftRateMsPerSecond` |
| `cristian-request-sent` | publisher | Al solicitar tiempo | `t1`, `requestTopic` |
| `cristian-response-sent` | time-server | Al responder | `t1`, `serverReceivedAt`, `serverTime`, `responseTopic` |
| `cristian-sync-accepted` | publisher | Respuesta valida | `t1`, `t4`, `rttMs`, `offsetMs`, `thresholdMs` |
| `cristian-sync-rejected` | publisher | RTT invalido o payload invalido | `reason`, `rttMs`, `thresholdMs` |
| `time-barrier-rejected` | persistence-subscriber | Paquete fuera de skew sin rescate | `deviceId`, `skewMs`, `maxSkewMs`, `direction` |
| `time-barrier-rescued` | persistence-subscriber | Paquete fuera de skew aceptado por causalidad | `deviceId`, `skewMs`, `lamportTs`, `vectorIndex`, `acceptedTimestamp` |

Ejemplo:

```json
{
  "schemaVersion": "observability-event/v1",
  "eventType": "cristian-sync-accepted",
  "algorithm": "physical-clock",
  "nodeId": "sensor-001",
  "correlationId": "time-sync-sensor-001-1779876900000",
  "severity": "info",
  "summary": "Cristian sync accepted with RTT 42ms",
  "data": {
    "t1": 1779876900000,
    "t4": 1779876900042,
    "serverTime": 1779876900020,
    "rttMs": 42,
    "offsetMs": -12,
    "thresholdMs": 500
  }
}
```

### Relojes Logicos

Algoritmos objetivo: Lamport actual, vector clocks actuales.

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `lamport-incremented` | publisher | Antes de publicar telemetria | `previous`, `next`, `reason` |
| `lamport-merged` | persistence-subscriber | Al recibir telemetria valida | `previous`, `received`, `next` |
| `vector-incremented` | publisher | Antes de publicar telemetria | `vectorIndex`, `previousVector`, `nextVector` |
| `vector-merged` | persistence-subscriber | Al fusionar vector recibido | `receivedVector`, `previousVector`, `nextVector` |
| `vector-rejected` | persistence-subscriber | Vector invalido | `reason`, `receivedVector`, `expectedSize` |

### Causalidad

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `causal-identity-resolved` | publisher o persistence-subscriber | Al mapear `deviceId` a `vectorIndex` | `deviceId`, `vectorIndex`, `participants` |
| `causal-identity-rejected` | publisher o persistence-subscriber | No existe mapping auditable | `deviceId`, `participants` |
| `causal-order-observed` | persistence-subscriber | Evento aceptado por progreso causal | `deviceId`, `lamportTs`, `vectorClock`, `relation` |
| `concurrency-detected` | future validator | Dos eventos no son comparables por vector clock | `leftEventId`, `rightEventId`, `leftVector`, `rightVector` |

### Eleccion de Lider

Algoritmos objetivo: Bully-like actual, Ring futuro.

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `election-started` | publisher | Nodo entra a `CANDIDATE` | `reason`, `term`, `electionId`, `candidatePriority` |
| `role-changed` | publisher | Cambia `FOLLOWER`/`CANDIDATE`/`LEADER` | `previousRole`, `nextRole`, `reason`, `term` |
| `bully-message-sent` | publisher | Publica `ELECTION` o `ALIVE` | `messageType`, `fromPriority`, `toPriority` |
| `leader-elected` | publisher | Gana quorum y anuncia coordinator | `term`, `electionId`, `leaderId`, `priority`, `votes`, `requiredQuorum` |
| `leader-stepped-down` | publisher | Abandona liderazgo | `reason`, `term`, `lastLeaseUntil` |
| `election-cooldown-applied` | publisher | Aplica cooldown post-recuperacion | `reason`, `cooldownUntil` |

### Lease y Quorum

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `quorum-check-sent` | candidate | Solicita votos | `term`, `electionId`, `candidateId`, `candidatePriority` |
| `quorum-vote-granted` | voter | Concede voto | `term`, `electionId`, `candidateId`, `voterId` |
| `quorum-vote-rejected` | voter | Rechaza voto | `reason`, `term`, `candidateId`, `knownLeaderId`, `knownLeaseUntil` |
| `quorum-not-reached` | candidate | Timeout sin mayoria | `votes`, `requiredQuorum`, `totalNodes` |
| `lease-renewed` | leader | Publica lease retenido | `term`, `electionId`, `leaderId`, `issuedAt`, `leaseUntil`, `durationMs` |
| `lease-observed` | follower/candidate | Recibe lease valido | `leaderId`, `term`, `leaseUntil`, `remainingMs` |
| `lease-rejected` | publisher | Payload malformado o expirado | `reason`, `payload` |
| `lease-expired` | publisher | Lease local o observado vence | `leaderId`, `leaseUntil`, `now` |

Ejemplo:

```json
{
  "schemaVersion": "observability-event/v1",
  "eventType": "quorum-vote-rejected",
  "algorithm": "lease-quorum",
  "nodeId": "sensor-003",
  "correlationId": "election-sensor-002-1779876930250",
  "severity": "warn",
  "summary": "Vote rejected because a valid lease is still observed",
  "data": {
    "term": 1779876930250,
    "candidateId": "sensor-002",
    "knownLeaderId": "sensor-005",
    "knownLeaseUntil": 1779876934800,
    "reason": "valid-observed-lease"
  }
}
```

### Mutex

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `mutex-requested` | publisher | Nodo solicita calibracion | `requesterId`, `resourceId`, `sensorState` |
| `mutex-request-accepted` | leader | Lider recibe request valida | `requesterId`, `holder`, `queueLength` |
| `mutex-grant-rejected` | publisher | Nodo sin liderazgo rechaza otorgar el recurso | `requesterId`, `reason`, `role`, `hasValidLease` |
| `mutex-granted` | leader | Otorga recurso | `requesterId`, `resourceId`, `leaseUntil` |
| `mutex-release-received` | leader | Holder libera recurso | `requesterId`, `holderBeforeRelease` |
| `mutex-watchdog-revoked` | leader | Timeout fuerza release | `requesterId`, `timeoutMs` |
| `mutex-status-published` | leader | Publica estado retenido | `isAvailable`, `holder`, `queue` |

### WAL y Recuperacion

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `wal-appended` | leader | Escribe `QUEUE`, `GRANT` o `RELEASE` | `walFile`, `operation`, `record`, `sequence` |
| `wal-recovery-started` | publisher | Inicia replay local | `walFile`, `exists` |
| `wal-restored` | publisher | Termina replay y restaura estado local | `walFile`, `restoredHolder`, `restoredQueue`, `recordsRead` |
| `wal-recovery-failed` | publisher | Error parseando WAL | `walFile`, `line`, `reason` |
| `wal-scope-warning` | publisher | Cambia lider y WAL no se transfiere | `previousLeader`, `nextLeader`, `scope` |

### Chaos

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `chaos-command-issued` | web-monitor o scenario-runner | Usuario/runner publica KILL/REVIVE/PAUSE/etc. | `targetId`, `action`, `method` |
| `chaos-command-received` | publisher | Nodo recibe comando | `targetId`, `action` |
| `node-failed` | publisher o scenario-runner | Nodo queda offline/simulado muerto | `targetId`, `failureMode` |
| `node-recovered` | publisher o scenario-runner | Nodo vuelve | `targetId`, `recoveryMode` |
| `partition-started` | scenario-runner | Se aplica particion futura | `groups`, `durationMs` |
| `partition-healed` | scenario-runner | Se remueve particion | `groups` |

### Stress, Escalabilidad y Elasticidad

| Evento | Emisor | Cuando ocurre | `data` minimo |
|--------|--------|---------------|---------------|
| `stress-run-started` | scenario-runner | Inicia carga | `targetRate`, `durationMs`, `payloadType` |
| `stress-sample-recorded` | scenario-runner o metrics-collector | Muestra periodica | `messagesPerSecond`, `p95LatencyMs`, `droppedMessages`, `cpuHint` |
| `stress-run-completed` | scenario-runner | Termina carga | `sent`, `accepted`, `rejected`, `durationMs` |
| `scale-out-requested` | scenario-runner | Solicita agregar nodos | `fromNodes`, `toNodes`, `method` |
| `scale-in-requested` | scenario-runner | Solicita reducir nodos | `fromNodes`, `toNodes`, `method` |
| `topology-changed` | metrics-collector | Cambia set de nodos observados | `previousNodes`, `currentNodes` |
| `elasticity-decision-recorded` | future controller | Controlador decide escalar | `reason`, `metric`, `threshold`, `decision` |

## Flujo de Datos Propuesto

```text
publisher/time-server/persistence/scenario-runner
  -> MQTT observability/events/<algorithm>/<eventType>
  -> web-monitor timeline + panels
  -> observability-subscriber
  -> InfluxDB measurement observability_events
  -> evidence exporter JSON/Markdown
```

### Responsabilidades

| Componente | Responsabilidad |
|------------|-----------------|
| Productores de eventos | Emitir hechos estructurados cerca de la decision real. |
| `config/index.js` | Centralizar topicos de observabilidad. |
| `observability-subscriber` futuro | Persistir eventos en InfluxDB sin bloquear algoritmos. |
| `web-monitor` | Visualizar estado actual, timeline y evidencia exportable. |
| `scenario-runner` futuro | Ejecutar escenarios con `scenarioId` y publicar eventos de control/evidencia. |
| Scripts legacy | Mantenerse hasta que el runner cubra la misma evidencia. |

### Topicos MQTT Propuestos

| Topico | Publicador | Consumidores | Retain | QoS | Uso |
|--------|------------|--------------|--------|-----|-----|
| `utp/sistemas_distribuidos/grupo1/observability/events/<algorithm>/<eventType>` | Servicios | monitor, subscriber, exporters | No | 0 o 1 | Eventos historicos append-only |
| `utp/sistemas_distribuidos/grupo1/observability/state/nodes/<nodeId>` | publishers, monitor de estado | monitor | Si | 1 | Ultimo estado conocido de nodo |
| `utp/sistemas_distribuidos/grupo1/observability/state/leader` | leader o observer | monitor | Si | 1 | Lider vigente derivado de lease |
| `utp/sistemas_distribuidos/grupo1/observability/state/scenarios/<scenarioId>` | scenario-runner | monitor, exporter | Si | 1 | Estado del escenario |
| `utp/sistemas_distribuidos/grupo1/observability/commands/scenario` | web-monitor | scenario-runner | No | 1 | Iniciar/cancelar escenario |
| `utp/sistemas_distribuidos/grupo1/observability/evidence/<scenarioId>` | exporter | monitor, reviewer | Si | 1 | Resumen exportable |

### Measurement InfluxDB Propuesto

Measurement: `observability_events`.

Tags:

- `algorithm`
- `event_type`
- `node_id`
- `scenario_id`
- `severity`

Fields:

- `event_id`
- `correlation_id`
- `causation_id`
- `summary`
- `data_json`

Timestamp:

- `emittedAt` cuando sea parseable.
- Hora de persistencia solo como fallback, con campo `persistedAt` dentro de `data_json`.

## UX del Visor

El visor debe permitir revisar un escenario sin abrir terminales.

### Topologia

- Mostrar broker, publishers, time-server, persistence-subscriber y futuros servicios de algoritmo.
- Distinguir `ONLINE`, `OFFLINE`, `FAILED`, `RECOVERING`, `PARTITIONED`.
- Resaltar lider vigente y lease restante.
- Mostrar edges por tipo de trafico: telemetria, eleccion, mutex, chaos, observabilidad.
- Permitir filtrar por `scenarioId`.

### Timeline

- Lista ordenada por `emittedAt`.
- Filtros por algoritmo, nodo, severidad y correlationId.
- Agrupacion por escenario.
- Cada item muestra `summary`, evento, nodo y campos clave.
- Click abre detalle JSON completo.
- Eventos relacionados se encadenan por `correlationId` y `causationId`.

### Inspector de Nodo

- Estado actual del nodo.
- Reloj fisico: drift, offset, ultimo RTT Cristian.
- Reloj logico: Lamport actual y vector clock.
- Eleccion: rol, term, electionId, votos vistos.
- Lease: `leaseUntil`, tiempo restante, lider observado.
- Mutex: estado local, holder/queue si es lider.
- WAL: ultimo append, estado restaurado, advertencia de alcance local.

### Paneles por Algoritmo

| Panel | Debe mostrar |
|-------|--------------|
| Relojes fisicos | Drift por nodo, RTT, offset, rechazos por RTT, rescates temporales. |
| Relojes logicos | Lamport por nodo, vector clocks, concurrencia detectada. |
| Causalidad | Paquetes aceptados/rechazados y razon. |
| Eleccion | Transiciones de rol, mensajes Bully/Ring, ganador, step-down. |
| Lease/quorum | Votos, rechazos, quorum alcanzado/no alcanzado, lease restante. |
| Mutex | Solicitudes, grants, releases, watchdog, cola. |
| WAL/recovery | Appends, replay, estado restaurado, limites cross-leader. |
| Chaos | Comandos, fallas, recuperaciones, particiones futuras. |
| Stress/Scaling | Throughput, latencia, drops, nodos activos, decisiones de escala. |

### Runner de Escenarios

- Boton para iniciar escenario predefinido.
- Genera `scenarioId` unico.
- Publica evento `scenario-started`.
- Ejecuta comandos controlados.
- Publica `scenario-step-started` y `scenario-step-completed`.
- Calcula resultado con criterios verificables.
- Publica `scenario-completed` con `passed`, `warnings`, `failedChecks`.

### Metricas

- Mensajes por segundo por topico/algoritmo.
- Latencia observada por correlationId cuando haya inicio/fin.
- Conteo de eventos por severidad.
- Tiempo hasta nuevo lider despues de fallo.
- Tiempo de recuperacion de nodo.
- Rechazos por barrera temporal, vector invalido, lease invalido o falta de quorum.

### Evidencia Exportable

Cada escenario debe exportar:

- `scenarioId`.
- Fecha/hora de inicio y fin.
- Version del contrato de eventos.
- Topologia observada.
- Secuencia de eventos relevantes.
- Checks de aceptacion con `pass/warn/fail`.
- Payloads clave: lease, quorum, WAL recovery, rejects.
- Comandos ejecutados.
- Riesgos o advertencias detectadas.

Formato minimo: JSON. Formato secundario: Markdown para entrega academica.

## Catalogo de Escenarios

### Chaos

| Escenario | Objetivo | Pasos | Aceptacion |
|-----------|----------|-------|------------|
| `chaos.kill-revive-node` | Ver recuperacion basica de publisher | KILL nodo, esperar offline, REVIVE, esperar online | Eventos `node-failed`, `node-recovered`, telemetria vuelve |
| `chaos.pause-leader-split-brain` | Validar lease/quorum contra lider viejo | Detectar lider, pausar contenedor mas de 5s, esperar nuevo lider, reanudar viejo | Nuevo lider con quorum; viejo emite `leader-stepped-down`; no hay grants sin lease |
| `chaos.future-packet` | Validar barrera temporal | Inyectar telemetria con timestamp futuro | Evento `time-barrier-rejected` o `time-barrier-rescued` con razon |
| `chaos.restart-leader-wal` | Validar WAL local | Generar cola, reiniciar lider, leer replay | Evento `wal-restored` con IDs restaurados |

### Stress

| Escenario | Objetivo | Pasos | Aceptacion |
|-----------|----------|-------|------------|
| `stress.telemetry-burst` | Medir ingestion de telemetria | Publicar N mensajes por segundo durante T segundos | No crash; drops y rechazos medidos |
| `stress.election-churn` | Medir estabilidad bajo fallas repetidas | Alternar fallas/recuperaciones de nodos | No hay dos leaders validos simultaneos segun lease observado |
| `stress.mutex-contention` | Medir cola y watchdog | Enviar requests concurrentes | Un holder por vez; cola observable; watchdog si holder no libera |

### Escalabilidad

| Escenario | Objetivo | Pasos | Aceptacion |
|-----------|----------|-------|------------|
| `scale.publishers-5-to-n` | Preparar crecimiento de topologia | Parametrizar participantes y lanzar mas publishers | Vector size y quorum se recalculan o el sistema rechaza configuracion invalida |
| `scale.monitor-high-cardinality` | Ver si el visor soporta mas nodos/eventos | Simular muchos nodos/eventos | UI mantiene filtros y timeline utilizable |

### Elasticidad

| Escenario | Objetivo | Pasos | Aceptacion |
|-----------|----------|-------|------------|
| `elasticity.scale-out-on-load` | Futuro controlador de escala | Aumentar carga y emitir decision de scale-out | Evento `elasticity-decision-recorded` con metrica y umbral |
| `elasticity.scale-in-on-idle` | Futuro scale-in controlado | Reducir carga y retirar nodos | Topologia cambia sin romper contrato observable |

## Fases de Implementacion

Cada fase debe poder revisarse como PR independiente. Si una fase supera unas 400 lineas cambiadas, dividirla por productor/consumidor.

### Fase 1: Contrato y Emisor Minimo

Estado: implementado como primer slice operativo.

Implementado:

- `config.topics.observability.all` y `config.topics.observability.events(algorithm, eventType)`.
- Helper `observability/events.js` para construir el sobre `observability-event/v1` y publicar sin romper el algoritmo principal si MQTT falla.
- Eventos iniciales desde `publisher`: `cristian-sync-accepted`, `cristian-sync-rejected`, `election-started`, `leader-elected`, `lease-renewed`, `leader-stepped-down`, `mutex-grant-rejected`, `mutex-granted` y `wal-restored`.
- `web-monitor` consume `observability/events/#` via catch-all y muestra un timeline acotado a 80 eventos.

Validacion rapida:

1. Ejecutar `docker compose up -d --build mqtt-broker time-server publisher-1 publisher-2 publisher-3 publisher-4 publisher-5 web-monitor`.
2. Observar MQTT con `docker compose exec mqtt-broker mosquitto_sub -t 'utp/sistemas_distribuidos/grupo1/observability/events/#' -C 5`.
3. Abrir `http://localhost:8080` y revisar el panel `Timeline Observable`.

Objetivo: introducir el bus de eventos sin cambiar comportamiento de algoritmos.

### Slice UX: Distributed Algorithms Cockpit

Estado: implementado como capa guiada del `web-monitor` sobre el timeline existente.

Implementado:

- Area prominente `Distributed Algorithms Cockpit` con selector de foco para Cristian, Lamport, vector clocks, Bully + quorum lease, mutex y WAL/recovery.
- Logica de dependencia solo en UI: mutex resalta Election + Lease y WAL opcional; WAL avisa que requiere mutex y reinicio del mismo coordinador; election/split-brain enfatiza quorum + lease + mutex fencing.
- Controles de carga `Normal`, `High` y `Stress` con significado conceptual de telemetria, presion mutex y volumen de eventos.
- Lanzadores de escenario para clock drift/Cristian, leader failover/Bully, mutex pressure y WAL recovery.
- Publicacion de intencion estructurada en `utp/sistemas_distribuidos/grupo1/observability/control/lab` con sobre `lab-control-intent/v1`.
- Gauges derivados de eventos existentes: lider observado, tasa de eventos por minuto, ultimo estado Cristian, grants/rejects mutex, restores WAL y foco activo.

Linea honesta de alcance:

- El cockpit filtra y guia observabilidad; los algoritmos siguen corriendo en el simulador.
- Los botones de carga y escenarios publican intencion de control, pero el `scenario-runner` automatico queda pendiente.
- Este slice no cambia semantica backend, quorum, lease, mutex ni WAL.

Siguiente backend runner:

- Consumir `observability/control/lab`.
- Traducir `load-profile-started` a cambios reales de tasa/presion si el simulador expone esos knobs.
- Traducir `scenario-intent-issued` a pasos verificables con `scenarioId`, eventos `scenario-*` y evidencia exportable.

PR recomendado:

- Agregar topicos `observability` en `config/index.js`.
- Crear helper pequeno para construir/publicar eventos desde Node.js.
- Emitir eventos solo para Cristian accepted/rejected y election role changes.
- Mantener logs existentes.

Criterios de aceptacion:

- `node --check` pasa para archivos modificados.
- `mosquitto_sub` puede observar eventos en `observability/events/#`.
- Cada evento contiene campos obligatorios del sobre v1.
- Si el helper falla, no detiene el algoritmo principal.
- El monitor actual sigue funcionando.

### Fase 2: Persistencia de Eventos

Objetivo: guardar eventos observables sin depender de logs.

PR recomendado:

- Agregar `observability-subscriber`.
- Persistir measurement `observability_events` en InfluxDB.
- Documentar consulta basica de evidencia.

Criterios de aceptacion:

- Evento publicado en MQTT aparece en InfluxDB.
- Payload invalido se rechaza con evento/log tecnico sin crash.
- Los tags permiten filtrar por `algorithm`, `event_type`, `node_id`, `scenario_id`.
- No se mezcla con `sensor_data`.

### Fase 3: Timeline del Visor

Objetivo: mostrar eventos normalizados en UI.

PR recomendado:

- `web-monitor` se suscribe a `observability/events/#`.
- Agrega timeline con filtros por algoritmo/severidad/nodo.
- Click muestra JSON completo del evento.

Criterios de aceptacion:

- Eventos desconocidos no rompen UI.
- Timeline se limita o virtualiza para evitar crecimiento infinito.
- Eventos de Cristian y eleccion se ven sin leer terminal.
- El grafo existente conserva comportamiento actual.

### Fase 4: Taxonomia Actual Completa

Objetivo: cubrir lo ya implementado antes de agregar algoritmos nuevos.

PR recomendado:

- Emitir eventos de Lamport, vector clocks, barrera temporal, quorum, lease, mutex, WAL y chaos KILL/REVIVE.
- Agregar validacion simple del sobre.

Criterios de aceptacion:

- `chaos-ultimate.sh` puede mapearse a eventos equivalentes.
- Split-brain drill produce eventos de pausa, nuevo lider, step-down y fencing.
- WAL recovery produce evento con IDs restaurados.
- Causal rejects indican razon concreta.

### Fase 5: Scenario Runner y Evidencia

Objetivo: reemplazar gradualmente grep de logs por escenarios con evidencia exportable.

PR recomendado:

- Crear runner para `chaos.future-packet` y `chaos.pause-leader-split-brain`.
- Generar `scenarioId`.
- Exportar reporte JSON y Markdown.

Criterios de aceptacion:

- Runner publica `scenario-started` y `scenario-completed`.
- Reporte incluye checks `pass/warn/fail`.
- Fallas reales producen salida no-cero.
- Evidencia incluye eventos, no solo logs.

### Fase 6: Paneles por Algoritmo

Objetivo: explicar los algoritmos, no solo listar eventos.

PR recomendado:

- Panel de relojes fisicos/logicos.
- Panel de eleccion/lease/quorum.
- Panel mutex/WAL.

Criterios de aceptacion:

- Cada panel tiene estado actual y ultimos eventos relevantes.
- Se puede abrir inspector de nodo y ver clocks, lease y WAL.
- El usuario puede entender por que se acepto/rechazo una decision.

### Fase 7: Stress, Escala y Elasticidad

Objetivo: preparar escenarios real-simulados de carga y crecimiento.

PR recomendado:

- Agregar eventos de stress samples.
- Agregar escenario `stress.mutex-contention`.
- Preparar contrato de `topology-changed` sin prometer scale-out automatico todavia.

Criterios de aceptacion:

- Reporte muestra throughput, latencia aproximada, drops/rejects.
- El visor filtra alto volumen sin quedar inutilizable.
- La topologia observada queda incluida en evidencia.

## Primer PR Recomendado

El primer PR debe ser el menor cambio valioso: **contrato de observabilidad + eventos minimos de Cristian y eleccion**.

Alcance exacto:

- Agregar `config.topics.observability.events(algorithm, eventType)` y `config.topics.observability.all`.
- Crear helper Node.js pequeno, por ejemplo `observability/events.js`, para construir el sobre v1 y publicar por MQTT.
- Emitir `cristian-sync-accepted`, `cristian-sync-rejected`, `role-changed`, `leader-elected` y `lease-renewed`.
- Agregar una seccion corta en `docs/TOPICS.md` que apunte a este documento.
- Verificar con `node --check` y `mosquitto_sub` manual.

No debe incluir:

- Nuevo dashboard grande.
- Persistencia de eventos.
- Scenario runner.
- Refactor del algoritmo de eleccion.
- Implementacion de algoritmos nuevos.

Valor:

- Establece el idioma comun del observatorio.
- Permite revisar eventos reales sin tocar todo el sistema.
- Reduce riesgo antes de expandir taxonomia.

## Riesgos y Tradeoffs

| Riesgo | Tradeoff | Mitigacion |
|--------|----------|------------|
| Mas eventos pueden aumentar ruido MQTT | Observabilidad compite con trafico pedagogico | Topicos separados, filtros en visor, sampling para stress |
| Eventos duplican informacion de logs | Durante migracion habra dos fuentes | Logs quedan como diagnostico; eventos son evidencia primaria nueva |
| Productores pueden bloquear si publicar observabilidad falla | Algoritmos no deben depender del observatorio | Helper fire-and-forget, errores aislados |
| JSON flexible puede degradar contrato | Cada algoritmo podria inventar campos | Sobre obligatorio y taxonomia documentada |
| InfluxDB con `data_json` limita queries profundas | Evita schema explosion al inicio | Tags para campos comunes; campos profundos quedan para export/evidencia |
| Visor puede crecer demasiado | UI monolitica actual en JS plano | PRs pequenos; timeline primero, paneles despues |
| WAL local puede interpretarse como replicado | Es una garantia falsa | Evento `wal-scope-warning` y documentacion visible |
| Quorum/lease puede parecer consenso fuerte | No es Raft/Paxos | Panel debe decir "lease/quorum pedagogico", no consenso fuerte |

## Como Habilita Algoritmos Futuros

| Futuro algoritmo | Que necesita del observatorio | Eventos reutilizables |
|------------------|------------------------------|----------------------|
| Berkeley | Mostrar propuesta de tiempo, offsets por nodo y promedio descartando outliers | `clock-drift-sampled`, `time-adjustment-proposed`, `time-adjustment-applied` |
| NTP | Mostrar estrato, delay, offset, dispersion y decision de sincronizacion | `ntp-sample-recorded`, `cristian-sync-rejected` como patron de rejection |
| Ring Election | Mostrar token/anillo, nodo iniciador, recorrido y ganador | `election-started`, `role-changed`, `leader-elected`, nuevos `ring-token-forwarded` |
| Token Ring / Ricart-Agrawala | Mostrar propiedad de token o permisos recibidos, request timestamp y entrada a seccion critica | `mutex-requested`, `mutex-granted`, `causal-order-observed` |
| Raft | Mostrar term, vote request, append entries, commit index y liderazgo | `quorum-vote-granted`, `quorum-vote-rejected`, `leader-elected`, nuevos `log-entry-replicated` |
| Paxos | Mostrar prepare/promise/accept/accepted y quorums | `quorum-check-sent`, `quorum-vote-granted`, nuevos `paxos-phase-*` |
| BFT | Mostrar propuesta, votos, commits y nodos maliciosos | `quorum-*`, `chaos-*`, nuevos `byzantine-behavior-detected` |
| Gossip | Mostrar propagacion, fanout, convergencia y nodos desactualizados | `topology-changed`, `stress-sample-recorded`, nuevos `gossip-message-forwarded` |
| Saga | Mostrar pasos, compensaciones, fallos y consistencia eventual | `scenario-*`, nuevos `saga-step-started`, `saga-compensation-completed` |

La regla para cualquier algoritmo nuevo: no se acepta como implementado si no trae eventos observables, panel o timeline minimo, escenario de validacion y evidencia exportable.

## Checklist de Revision

- [ ] El contrato de evento tiene campos obligatorios y ejemplos.
- [ ] Cada algoritmo actual tiene eventos definidos.
- [ ] El primer PR no mezcla contrato, UI grande y persistencia.
- [ ] Los criterios de aceptacion son verificables sin interpretar prosa.
- [ ] Los escenarios reemplazan progresivamente grep de logs por evidencia estructurada.
- [ ] Las limitaciones actuales siguen visibles para no vender garantias falsas.
