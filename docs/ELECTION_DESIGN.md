# Diseno de eleccion de lider, lease y quorum

Este documento describe el contrato tecnico implementado para la eleccion de lider del laboratorio. La garantia final contra split-brain queda pendiente de prueba de stress real en Phase 4.6.

## Objetivo

Demostrar por que la sincronizacion, los leases y el quorum son necesarios para coordinar recursos compartidos en sistemas distribuidos reales-simulados.

El sistema debe soportar cinco publishers. Cualquier publisher puede ser candidato, pero solo un lider con lease vigente y quorum puede otorgar acceso al recurso compartido.

## Invariantes obligatorios

| Invariante | Regla |
|------------|-------|
| Estado unico | Cada nodo esta exactamente en uno de estos estados: `FOLLOWER`, `CANDIDATE`, `LEADER`. |
| Quorum minimo | Con 5 nodos, un candidato necesita al menos 3 votos validos para ser lider. |
| Lease vigente | Un lider solo coordina mientras su lease local y el lease retenido no esten expirados. |
| Mutex protegido | Un nodo que no es `LEADER` con lease vigente no puede otorgar `mutex/grant`. |
| Voto unico | Cada nodo vota como maximo una vez por termino. |
| Lider viejo | Un lider pausado o reiniciado debe validar lease antes de volver a coordinar. |
| Fuente observable | El topico retenido de lease es la fuente observable del liderazgo vigente. |

## Estados

| Estado | Puede solicitar votos | Puede renovar lease | Puede otorgar mutex | Condicion de salida |
|--------|-----------------------|---------------------|--------------------|---------------------|
| `FOLLOWER` | No | No | No | Lease expirado o ausencia de lider valido. |
| `CANDIDATE` | Si | No | No | Gana quorum, pierde quorum o observa lease valido. |
| `LEADER` | No | Si | Si | Lease local expira, observa lease valido superior o pierde conectividad. |

## Topicos activos

Todos los topicos activos de eleccion deben vivir dentro del namespace del proyecto.

| Topico | Publicador | Suscriptores | Payload minimo |
|--------|------------|--------------|----------------|
| `utp/sistemas_distribuidos/grupo1/election/quorum/check` | `CANDIDATE` | publishers | `{ "term": number, "electionId": string, "candidateId": string, "candidatePriority": number }` |
| `utp/sistemas_distribuidos/grupo1/election/quorum/ack` | `FOLLOWER` | candidato | `{ "term": number, "electionId": string, "candidateId": string, "voterId": string }` |
| `utp/sistemas_distribuidos/grupo1/election/lease` | `LEADER` | publishers, monitor | `{ "term": number, "electionId": string, "leaderId": string, "priority": number, "issuedAt": number, "leaseUntil": number }` |
| `utp/sistemas_distribuidos/grupo1/election/coordinator` | `LEADER` | publishers, monitor | `{ "type": "VICTORY", "term": number, "electionId": string, "coordinatorId": string, "priority": number }` |

Los topicos legacy sin namespace `election/lease`, `election/quorum_check` y `election/quorum_ack` fueron retirados del codigo activo en Phase 4.2. Si reaparecen, deben considerarse una regresion de contrato.

## Reglas de voto

1. Un nodo rechaza solicitudes con payload incompleto o termino invalido.
2. Un nodo no vota por si mismo.
3. Un nodo no vota dos veces en el mismo termino.
4. Un nodo no vota por un candidato si observa un lease vigente de mayor o igual prioridad.
5. Un candidato solo cuenta votos que coincidan con su `term`, `electionId` y `candidateId`.
6. Los votos se cuentan por `voterId` unico.
7. Si no se alcanza quorum antes del timeout, el nodo no puede entrar a `LEADER`.

## Reglas de lease

1. Duracion: 5000 ms.
2. Renovacion: cada 2000 ms.
3. Publicacion: mensaje retenido en el topico de lease.
4. Un lease expirado se ignora.
5. Un lider que observa un lease valido de otro nodo debe registrar `stepping down`.
6. Un lider pausado debe revalidar lease al volver antes de coordinar.

## Proteccion contra split-brain

La proteccion se basa en dos barreras:

1. **Quorum**: sin 3 votos no hay liderazgo.
2. **Lease**: sin lease vigente no hay coordinacion.

Esto no reemplaza consenso fuerte tipo Raft/Paxos. Es una simulacion pedagogica controlada para demostrar por que la coordinacion distribuida necesita mayoria, expiracion y fencing.

## Logs esperados

| Evento | Log esperado |
|--------|--------------|
| Inicio de eleccion | `[ELECTION] election started` |
| Voto concedido | `[ELECTION] vote granted` |
| Quorum alcanzado | `[ELECTION] won election with 3 votes` |
| Lease renovado | `[ELECTION] lease renewed` |
| Lider degradado | `[ELECTION] stepping down` |
| Mutex bloqueado por falta de liderazgo | `[MUTEX] grant rejected: no valid leadership` |

## Plan de implementacion

1. Introducir estados `FOLLOWER`, `CANDIDATE`, `LEADER` sin cambiar mutex.
2. Migrar topicos de eleccion al namespace del proyecto.
3. Implementar voto unico por termino y conteo por `voterId`.
4. Implementar lease retenido con expiracion.
5. Conectar `canGrantMutex()` al estado `LEADER` y lease vigente.
6. Agregar prueba manual de split-brain: pausar lider, elegir nuevo lider, reanudar lider viejo y verificar `stepping down`.

## Criterios de aceptacion

- `node --check` pasa para todos los servicios modificados.
- Con cinco publishers, solo un nodo publica lease vigente.
- Si se pausa el lider por mas de 5 segundos, otro nodo gana con al menos 3 votos.
- Al reanudar el lider viejo, este no otorga mutex y registra `stepping down`.
- El monitor o logs muestran lider actual, termino y lease vigente.
- La documentacion de topicos coincide con el codigo.

## Estado de implementacion

| Fase | Estado |
|------|--------|
| 4.1 Estados `FOLLOWER` / `CANDIDATE` / `LEADER` | Implementado |
| 4.2 Topicos de eleccion en namespace del proyecto | Implementado |
| 4.3 Payload formal de voto y conteo por `voterId` unico | Implementado |
| 4.4 Lease formal con `issuedAt` y `leaseUntil` | Implementado |
| 4.5 Reglas de voto contra lease vigente y fencing final de mutex | Implementado |
| 4.6 Prueba de stress split-brain con `docker pause` / `docker unpause` | Pendiente |

## Garantias implementadas en Phase 4.5

Un nodo rechaza votos si conserva un lease observado vigente para otro lider. Esto evita que un candidato pueda conseguir apoyo mientras la mayoria aun reconoce un liderazgo no expirado.

El mutex queda protegido por fencing local: `mutex/request` y `mutex/release` solo se procesan si el nodo es `LEADER`, mantiene `isCoordinator=true` y su lease local no expiro. Si no se cumple, el evento se rechaza con log tecnico.

Estas reglas cierran la ruta principal de split-brain dentro del modelo pedagogico. La garantia final debe comprobarse con prueba de stress real en Phase 4.6.

## Cooldown post-recuperacion

Despues de un `stepDown`, el nodo espera `3000 ms` antes de iniciar otra eleccion. El objetivo no es seguridad, sino estabilidad operativa: reduce churn cuando un nodo de mayor prioridad vuelve despues de una pausa y acaba de reconocer que su lease local expiro.

Durante este cooldown el nodo puede observar leases y votos, pero no inicia una nueva candidatura por expiracion local. Esto evita oscilaciones inmediatas sin impedir que el sistema elija lider si no hay lease valido.

## Alcance del WAL de mutex

El WAL del mutex vive en el filesystem local de cada publisher (`publisher/wal_<DEVICE_ID>.log`). Por eso recupera cola y holder cuando reinicia el mismo contenedor que estaba actuando como coordinador, pero no replica automaticamente esa cola hacia otro lider durante un cambio de liderazgo.

La garantia actual es suficiente para demostrar recuperacion local del coordinador. La transferencia de cola entre lideres queda fuera del alcance implementado y requeriria WAL compartido, snapshot replicado o consenso sobre el estado del recurso.
