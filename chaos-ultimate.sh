#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BASE_TOPIC="utp/sistemas_distribuidos/grupo1"
LEASE_TOPIC="$BASE_TOPIC/election/lease"
MUTEX_REQUEST_TOPIC="$BASE_TOPIC/mutex/request"
PUBLISHERS="publisher-1 publisher-2 publisher-3 publisher-4 publisher-5"

cleanup_paused_publishers() {
  local paused
  for container in $PUBLISHERS; do
    paused=$(docker inspect -f '{{.State.Paused}}' "$container" 2>/dev/null || true)
    [ "$paused" = "true" ] && docker unpause "$container" >/dev/null 2>&1 || true
  done
}

trap cleanup_paused_publishers EXIT

fail() {
  echo -e "${RED}  FALLO: $1${NC}"
  exit 1
}

warn() {
  echo -e "${YELLOW}  ALERTA: $1${NC}"
}

ok() {
  echo -e "${GREEN}  EXITO: $1${NC}"
}

device_to_container() {
  case "$1" in
    sensor-001) echo "publisher-1" ;;
    sensor-002) echo "publisher-2" ;;
    sensor-003) echo "publisher-3" ;;
    sensor-004) echo "publisher-4" ;;
    sensor-005) echo "publisher-5" ;;
    *) return 1 ;;
  esac
}

detect_leader_device() {
  local payload
  local parsed_leader
  payload=$(docker exec mqtt-broker timeout 3 mosquitto_sub -C 1 -t "$LEASE_TOPIC" 2>/dev/null || true)

  if [ -n "$payload" ] && command -v node >/dev/null 2>&1; then
    parsed_leader=$(printf '%s' "$payload" | node -e '
      const fs = require("fs");
      try {
        const lease = JSON.parse(fs.readFileSync(0, "utf8"));
        const id = lease.leaderId || lease.coordinatorId;
        if (id && Number(lease.leaseUntil) > Date.now() - 1000) console.log(id);
      } catch (_) {}
    ' 2>/dev/null)
    if [ -n "$parsed_leader" ]; then
      echo "$parsed_leader"
      return
    fi
  fi

  return 1
}

wait_for_leader_device() {
  local timeout_seconds="${1:-20}"
  local deadline=$((SECONDS + timeout_seconds))
  local leader
  local container

  while [ "$SECONDS" -lt "$deadline" ]; do
    leader=$(detect_leader_device)
    if [ -n "$leader" ] && container=$(device_to_container "$leader"); then
      if docker logs "$container" --tail 120 2>&1 | grep -q "lease renewed: leader=$leader"; then
        echo "$leader"
        return 0
      fi
    fi
    sleep 1
  done

  return 1
}

wait_for_stable_leader_device() {
  local timeout_seconds="${1:-30}"
  local stability_seconds="${2:-4}"
  local deadline=$((SECONDS + timeout_seconds))
  local first_leader
  local second_leader

  while [ "$SECONDS" -lt "$deadline" ]; do
    first_leader=$(wait_for_leader_device 5 || true)
    if [ -z "$first_leader" ]; then
      sleep 1
      continue
    fi

    sleep "$stability_seconds"
    second_leader=$(wait_for_leader_device 5 || true)
    if [ "$first_leader" = "$second_leader" ]; then
      echo "$first_leader"
      return 0
    fi
  done

  return 1
}

wal_queue_count() {
  local container="$1"
  local device="$2"
  docker exec "$container" sh -c "test -f /usr/src/app/publisher/wal_${device}.log && grep -c '|QUEUE|' /usr/src/app/publisher/wal_${device}.log || true" 2>/dev/null | tr -d '[:space:]'
}

wait_for_wal_queue_append() {
  local leader_device="$1"
  local leader_container="$2"
  local before_count="$3"
  local timeout_seconds="${4:-10}"
  local deadline=$((SECONDS + timeout_seconds))
  local current_count

  while [ "$SECONDS" -lt "$deadline" ]; do
    current_count=$(wal_queue_count "$leader_container" "$leader_device")
    current_count=${current_count:-0}
    if [ "$current_count" -gt "$before_count" ]; then
      echo "$current_count"
      return 0
    fi
    sleep 1
  done

  return 1
}

publish_mqtt() {
  docker exec mqtt-broker mosquitto_pub -t "$1" -m "$2"
}

publisher_logs() {
  local tail_lines="${1:-180}"
  for container in $PUBLISHERS; do
    docker logs "$container" --tail "$tail_lines" 2>&1
  done
}

echo -e "${YELLOW}INICIANDO PROYECTO UTP: PROTOCOLO DE EVALUACION${NC}"
echo "Requiere broker, persistence-subscriber y 5 publishers activos."
sleep 2

echo -e "\n${YELLOW}[FASE 1] Integridad temporal y causalidad auditable${NC}"
echo "   -> Inyectando telemetria futura en namespace canonico..."
publish_mqtt "$BASE_TOPIC/sensor-001/telemetry" '{"deviceId":"sensor-001","processId":1,"vectorIndex":0,"temperatura":"1000.00","humedad":"0.00","timestamp":"2050-01-01T00:00:00.000Z","lamport_ts":1,"vector_clock":[1,0,0,0,0],"sensor_state":"CHAOS_TEMPORAL_TEST"}'
sleep 2

if docker logs persistence-subscriber --tail 120 2>&1 | grep -q "Rejected future packet from sensor-001"; then
  ok "La barrera temporal detecto el paquete futuro con identidad causal auditable."
else
  fail "No se encontro el log 'Rejected future packet from sensor-001'."
fi

echo -e "\n${YELLOW}[FASE 2] Liderazgo, lease y split-brain${NC}"
LEADER_DEVICE=$(wait_for_leader_device 20)
if [ -z "$LEADER_DEVICE" ]; then
  warn "No se pudo leer lider vigente por lease/logs; usando fallback sensor-005 para demo."
  LEADER_DEVICE="sensor-005"
fi

LEADER_CONTAINER=$(device_to_container "$LEADER_DEVICE") || fail "Lider desconocido: $LEADER_DEVICE"
echo "   -> Lider detectado: $LEADER_DEVICE ($LEADER_CONTAINER)"
echo "   -> Pausando lider por mas que el lease de 5s..."
docker pause "$LEADER_CONTAINER" >/dev/null
sleep 7

NEW_LEADER_DEVICE=$(wait_for_leader_device 20)
docker unpause "$LEADER_CONTAINER" >/dev/null
sleep 4

if [ -n "$NEW_LEADER_DEVICE" ] && [ "$NEW_LEADER_DEVICE" != "$LEADER_DEVICE" ]; then
  ok "Nuevo lider observado: $NEW_LEADER_DEVICE."
else
  warn "No se pudo confirmar cambio de lider automaticamente; revisar logs de election/lease."
fi

if docker logs "$LEADER_CONTAINER" --tail 160 2>&1 | grep -q -E "stepping down|LEADER->FOLLOWER"; then
  ok "El lider anterior registro degradacion al recuperar conectividad."
else
  warn "No se encontro 'stepping down'/'LEADER->FOLLOWER' en $LEADER_CONTAINER."
fi

if publisher_logs 180 | grep -q -E "won election with|lease renewed|grant rejected"; then
  ok "Logs actuales cubren eleccion, lease o fencing de mutex."
else
  fail "No se encontraron logs actuales de eleccion/lease/fencing."
fi

echo -e "\n${YELLOW}[FASE 3] WAL local y cola de mutex${NC}"
LEADER_DEVICE=$(wait_for_stable_leader_device 35 4)
if [ -z "$LEADER_DEVICE" ]; then
  fail "No se detecto lider estable con lease local vigente para generar cola WAL."
fi
LEADER_CONTAINER=$(device_to_container "$LEADER_DEVICE") || fail "Lider desconocido: $LEADER_DEVICE"
echo "   -> Lider/coordinador para WAL: $LEADER_DEVICE ($LEADER_CONTAINER)"
echo "   -> Generando solicitudes reales en $MUTEX_REQUEST_TOPIC..."

BEFORE_QUEUE_COUNT=$(wal_queue_count "$LEADER_CONTAINER" "$LEADER_DEVICE")
BEFORE_QUEUE_COUNT=${BEFORE_QUEUE_COUNT:-0}

for requester in sensor-001 sensor-002 sensor-003 sensor-004 sensor-005; do
  [ "$requester" = "$LEADER_DEVICE" ] && continue
  publish_mqtt "$MUTEX_REQUEST_TOPIC" "{\"deviceId\":\"$requester\"}"
done

AFTER_QUEUE_COUNT=$(wait_for_wal_queue_append "$LEADER_DEVICE" "$LEADER_CONTAINER" "$BEFORE_QUEUE_COUNT" 12) || \
  fail "No se confirmo append QUEUE en WAL de $LEADER_CONTAINER antes del reinicio."
echo "   -> WAL confirmo cola local: QUEUE $BEFORE_QUEUE_COUNT -> $AFTER_QUEUE_COUNT."
echo "   -> Reiniciando el contenedor del lider para probar recuperacion local de WAL..."
docker restart "$LEADER_CONTAINER" >/dev/null

if ! wait_for_leader_device 20 >/dev/null; then
  warn "No se confirmo lider estable tras reiniciar $LEADER_CONTAINER; se validara igualmente el log local de recuperacion WAL."
fi

if docker logs "$LEADER_CONTAINER" --tail 160 2>&1 | grep -q -E "\[WAL\] Estado restaurado.*ids=\[[^]]+\]"; then
  ok "WAL local restauro estado e imprimio IDs de cola."
else
  fail "No se encontro log WAL con IDs restaurados en $LEADER_CONTAINER."
fi

echo -e "\n${YELLOW}EVALUACION TITAN COMPLETADA${NC}"
