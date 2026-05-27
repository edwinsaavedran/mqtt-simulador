# Sincronizacion de reloj

Phase 2 implementa sincronizacion fisica con Cristian mejorado y una compuerta temporal antes de persistir telemetria.

## Contrato Cristian

| Flujo | Topico | Payload |
|-------|--------|---------|
| Solicitud | `utp/sistemas_distribuidos/grupo1/time/request` | `{ "deviceId": string, "t1": number }` |
| Respuesta | `utp/sistemas_distribuidos/grupo1/time/response/<deviceId>` | `{ "deviceId": string, "t1": number, "serverReceivedAt": number, "serverTime": number }` |

El publisher calcula `RTT = Date.now() - t1` al recibir la respuesta. Si `RTT < 0` o `RTT > 500 ms`, descarta la sincronizacion y conserva su offset actual.

## Drift local

`CLOCK_DRIFT_RATE` modifica el reloj local simulado del publisher de forma lineal. La unidad es milisegundos extra por segundo real transcurrido: `CLOCK_DRIFT_RATE=500` significa que el reloj simulado avanza 500 ms adicionales por cada segundo real.

```text
simulatedTime = startTime + elapsedRealMs + (elapsedRealMs / 1000 * CLOCK_DRIFT_RATE) + clockOffset
```

La telemetria usa `simulatedTime` en `timestamp`. Cristian solo ajusta `clockOffset` cuando la respuesta pasa la validacion de RTT.

## Compuerta temporal de persistencia

`persistence-subscriber` valida cada paquete antes de escribirlo en InfluxDB:

| Condicion | Resultado |
|-----------|-----------|
| JSON invalido | Rechazo con log tecnico, sin crash |
| `timestamp` invalido | Rechazo con log tecnico |
| `abs(messageTime - localTime) > 2000 ms` | Rechazo, salvo rescate causal Lamport/vector |
| Paquete futuro fuera de rango | Log con texto `Rejected future packet` para validacion PC03 |

## Rescate causal acotado

La excepcion "reloj logico adelantado y vector consistente" se aplica solo cuando el `deviceId` puede mapearse de forma auditable a un indice vectorial derivado de `ELECTION_PARTICIPANTS`. Si el rescate se acepta, `persistence-subscriber` fuerza el timestamp a la hora local antes de escribir en InfluxDB.

Las reglas completas de mapeo, Lamport, vector clock y rescate estan documentadas en [`docs/CAUSALITY.md`](CAUSALITY.md).
