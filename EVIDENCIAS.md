# Evidencias de cumplimiento

Este archivo resume como reproducir y adjuntar evidencias para la entrega del simulador MQTT de Sistemas Distribuidos. El flujo principal usa `chaos-ultimate.sh` porque valida los topicos y logs activos del codigo actual.

## Preparacion

1. Levantar servicios:

```bash
docker compose up -d --build
```

2. Confirmar que hay cinco publishers y servicios base:

```bash
docker ps --format '{{.Names}}' | grep -E 'publisher-[1-5]|mqtt-broker|time-server|persistence-subscriber'
```

3. Ejecutar validacion integrada:

```bash
bash chaos-ultimate.sh
```

## Fase 1: tiempo, Lamport y relojes vectoriales

| Requisito PDF | Evidencia esperada |
|---------------|--------------------|
| Publicadores con identidad auditable | `docker logs publisher-1 --tail 80` muestra telemetria con `deviceId`, `processId`, `vectorIndex`, `lamport_ts` y `vector_clock`. |
| Barrera temporal mayor a 2s | `chaos-ultimate.sh` publica en `utp/sistemas_distribuidos/grupo1/sensor-001/telemetry` un mensaje con timestamp `2050-01-01T00:00:00.000Z`. |
| Rechazo temporal o excepcion causal documentada | `docker logs persistence-subscriber --tail 120` debe mostrar `Rejected future packet from sensor-001`. Si el mensaje cumple progreso Lamport/vectorial, tambien puede aparecer `Temporal rescue accepted`, que corresponde a la excepcion causal implementada. |
| Cristian con descarte por RTT | `docker logs publisher-1 --tail 120` debe incluir sincronizacion aceptada o descartes cuando el RTT excede el umbral de 500 ms. |

Comando directo de evidencia temporal:

```bash
docker exec mqtt-broker mosquitto_pub \
  -t 'utp/sistemas_distribuidos/grupo1/sensor-001/telemetry' \
  -m '{"deviceId":"sensor-001","processId":1,"vectorIndex":0,"temperatura":"1000.00","humedad":"0.00","timestamp":"2050-01-01T00:00:00.000Z","lamport_ts":1,"vector_clock":[1,0,0,0,0],"sensor_state":"CHAOS_TEMPORAL_TEST"}'
```

## Fase 2: eleccion, quorum y split-brain

| Requisito PDF | Evidencia esperada |
|---------------|--------------------|
| Cinco participantes de eleccion | `docker compose config | grep ELECTION_PARTICIPANTS` muestra `sensor-001` a `sensor-005`. |
| Quorum 3/5 | Logs de publishers muestran `[ELECTION] won election with 3 votes`. |
| Lease de 5s y renovacion de 2s | Logs muestran `[ELECTION] lease renewed` y el payload retenido en `utp/sistemas_distribuidos/grupo1/election/lease` incluye `leaseUntil`. |
| Sin mayoria no hay lider valido | En escenarios de particion sin quorum no debe aparecer `won election with 3 votes`; los grants quedan protegidos por `[MUTEX] grant rejected: no valid leadership`. |
| Recuperacion ante split-brain | `chaos-ultimate.sh` pausa el lider detectado, espera mas de 5s, busca nuevo lease y verifica `stepping down` o `LEADER->FOLLOWER` al reanudar el lider anterior. |

Comandos utiles:

```bash
docker exec mqtt-broker timeout 3 mosquitto_sub -C 1 -t 'utp/sistemas_distribuidos/grupo1/election/lease'
for container in publisher-1 publisher-2 publisher-3 publisher-4 publisher-5; do
  docker logs "$container" --tail 200
done | grep -E 'won election with|lease renewed|stepping down|grant rejected|LEADER->FOLLOWER'
```

## Fase 3: exclusion mutua y WAL

| Requisito PDF | Evidencia esperada |
|---------------|--------------------|
| Solicitud real de mutex | `chaos-ultimate.sh` publica solicitudes JSON en `utp/sistemas_distribuidos/grupo1/mutex/request`. |
| Grants protegidos por lider vigente | El lider procesa `mutex/request`; nodos sin liderazgo registran `grant rejected`. |
| Recuperacion WAL | Tras reiniciar el contenedor lider, el log muestra `[WAL] Estado restaurado. Queue: <n> ids=[...]`. |
| IDs restaurados | El arreglo `ids=[...]` en el log permite auditar que solicitudes de cola fueron reconstruidas. |

Comando directo para generar cola:

```bash
for sensor in sensor-001 sensor-002 sensor-003 sensor-004 sensor-005; do
  docker exec mqtt-broker mosquitto_pub \
    -t 'utp/sistemas_distribuidos/grupo1/mutex/request' \
    -m "{\"deviceId\":\"$sensor\"}"
done
```

## Alcance actual del WAL

El WAL es local por contenedor (`publisher/wal_<DEVICE_ID>.log`). Esto cubre recuperacion cuando el mismo publisher/coordinador reinicia y conserva su filesystem de contenedor. No garantiza transferencia automatica de cola hacia otro lider despues de un cambio de liderazgo; para eso haria falta WAL compartido, snapshot replicado o consenso sobre el estado del mutex.

Para esta entrega, la evidencia valida el alcance pedagogico actual: recuperacion local del coordinador y documentacion explicita de la limitacion cross-leader.

## Checklist de entrega

- [ ] Adjuntar salida de `bash chaos-ultimate.sh`.
- [ ] Adjuntar logs de `persistence-subscriber` con `Rejected future packet`.
- [ ] Adjuntar logs de publishers con `won election with`, `lease renewed` y `stepping down` o `LEADER->FOLLOWER`.
- [ ] Adjuntar logs WAL con `ids=[...]`.
- [ ] Declarar la limitacion: WAL local no transfiere cola entre lideres.
