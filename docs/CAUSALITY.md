# Causalidad y relojes logicos

Phase 3 usa relojes Lamport y vectoriales para auditar orden causal entre los cinco publishers activos. La fuente de identidad es `ELECTION_PARTICIPANTS`; el orden vectorial se deriva ordenando los `deviceId` de forma deterministica.

## Mapeo vectorial

Con la topologia actual de `docker-compose.yml`:

| Indice | deviceId | Prioridad |
|--------|----------|-----------|
| 0 | `sensor-001` | 10 |
| 1 | `sensor-002` | 20 |
| 2 | `sensor-003` | 30 |
| 3 | `sensor-004` | 40 |
| 4 | `sensor-005` | 50 |

Reglas de mapeo:

1. `config.topology.getElectionParticipants()` parsea `ELECTION_PARTICIPANTS` con formato `deviceId:priority`.
2. Los participantes se ordenan por `deviceId` para evitar depender del orden textual de la variable.
3. `config.topology.getVectorIndex(deviceId)` devuelve el indice 0-based usado por `vector_clock`.
4. Si un publisher no aparece en `ELECTION_PARTICIPANTS`, no publica telemetria porque el indice causal no es auditable.

## Payload de telemetria

Cada publisher publica:

```json
{
  "deviceId": "sensor-001",
  "processId": 1,
  "vectorIndex": 0,
  "temperatura": "22.10",
  "humedad": "55.20",
  "timestamp": "2026-05-26T00:00:00.000Z",
  "lamport_ts": 1,
  "vector_clock": [1, 0, 0, 0, 0],
  "sensor_state": "IDLE"
}
```

`processId` queda como metadato operativo heredado de Compose. El orden causal usa `deviceId` y `vectorIndex` derivado desde la topologia.

## Reglas Lamport

| Evento | Regla |
|--------|-------|
| Envio de telemetria en publisher | `lamportClock = lamportClock + 1` antes de publicar |
| Recepcion en persistence-subscriber | `lamportClock = max(local, received) + 1` antes de persistir |

## Reglas vectoriales

| Evento | Regla |
|--------|-------|
| Envio de telemetria en publisher | Incrementa solo `vector_clock[vectorIndex]` antes de publicar |
| Recepcion en persistence-subscriber | Valida longitud, enteros no negativos, metadata del emisor y fusiona con maximo por componente |

Un vector se rechaza si:

1. No es un arreglo.
2. Su longitud no coincide con la cantidad de publishers activos.
3. Contiene valores no enteros o negativos.
4. El `deviceId` no puede mapearse a un indice.
5. `vectorIndex`, si viene en el payload, no coincide con el indice derivado desde `deviceId`.

## Rescate temporal

`persistence-subscriber` conserva la compuerta temporal de 2000 ms. Si `abs(messageTime - localTime) > 2000`, solo persiste el paquete si se cumplen todas estas condiciones:

1. `receivedLamportTS > previousLamportClock`.
2. El `deviceId` tiene un indice vectorial auditable.
3. El vector es valido y `receivedVectorClock[senderIndex] > localVectorClock[senderIndex]`.

Cuando el rescate se acepta, el timestamp fisico se fuerza a la hora local de persistencia antes de escribir en InfluxDB. El log esperado contiene:

```text
[UTP-DEFENSE] Temporal rescue accepted for <deviceId>: skew=<ms>ms, lamport=<n>, vectorIndex=<i>. Timestamp forced to local persistence time.
```

Si alguna condicion falla, el paquete se rechaza y no se escribe en la base.

## Limitaciones

El reloj vectorial de persistencia representa el maximo observado de los publishers, no un sexto proceso participante. Esto mantiene el vector en cinco posiciones y evita mezclar el suscriptor de persistencia con los sensores que generan causalidad del laboratorio.
