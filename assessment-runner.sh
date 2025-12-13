#!/bin/bash

# ==============================================================================
#  OPERATION ZERO DOWNTIME - SCRIPT DE EVALUACIÓN AUTOMATIZADA - PC03
# ==============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

TARGET_CONTAINER="publisher-1" # Nodo a probar
LEADER_CONTAINER="publisher-5" # Nodo que asumimos es Líder (mayor prioridad)

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}       INICIANDO PROTOCOLO DE EVALUACIÓN: WAR ROOM          ${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""

# ------------------------------------------------------------------------------
# BLOQUE 1: PRUEBA DE SNAPSHOTTING (LOG INFINITO)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}[TEST 1/3] Generando Carga Masiva (Log Infinito)...${NC}"

# 1. Inyectamos 500 entradas rápidas al WAL simulado
# Nota: Usamos mosquitto_pub desde el host o un contenedor
echo "   -> Inyectando 500 operaciones de Mutex en ráfaga..."
for i in {1..500}; do
   docker exec mqtt-broker mosquitto_pub -t "mutex/request" -m "{\"deviceId\": \"load-tester-$i\"}" &>/dev/null
done

echo "   -> Esperando procesamiento..."
sleep 5

# 2. Reiniciamos el nodo para forzar la lectura del WAL
echo "   -> Reiniciando nodo ${TARGET_CONTAINER}..."
START_TIME=$(date +%s%N)
docker restart ${TARGET_CONTAINER}
END_TIME=$(date +%s%N)

# 3. Medimos tiempo de recuperación
DURATION=$((($END_TIME - $START_TIME)/1000000)) # en ms
echo "   -> Tiempo de reinicio: ${DURATION}ms"

# 4. Validamos si usó Snapshot (buscando logs específicos)
if docker logs --tail 50 ${TARGET_CONTAINER} 2>&1 | grep -q "Snapshot loaded"; then
    echo -e "${GREEN}   [PASSED] Mecanismo de Snapshot detectado.${NC}"
else
    echo -e "${RED}   [FAILED] No se detectó carga de Snapshot. El WAL se leyó línea por línea.${NC}"
fi

if [ $DURATION -gt 5000 ]; then
    echo -e "${RED}   [FAILED] El reinicio fue demasiado lento (>5s). Optimización fallida.${NC}"
else
    echo -e "${GREEN}   [PASSED] Reinicio rápido (<5s).${NC}"
fi

# ------------------------------------------------------------------------------
# BLOQUE 2: EFICIENCIA DE ELECCIÓN (TORMENTA BROADCAST)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}[TEST 2/3] Simulando Caída del Líder (Broadcast Storm)...${NC}"

# 1. Se limpian los logs anteriores (mentalmente, usaremos --since)
CHECK_TIME=$(date --iso-8601=seconds)

# 2. Se ejecuta la eliminación del líder
echo "   -> Asesinando al Líder (${LEADER_CONTAINER})..."
docker stop ${LEADER_CONTAINER}
sleep 5

# 3. Se cuentan los mensajes de elección en un suscriptor espía (simulado por logs de otro nodo)
# Aquí buscamos si el estudiante implementó la lógica de "esperar aleatoriamente" o "verificar si ya hay elección"
MSG_COUNT=$(docker logs --since 10s publisher-2 2>&1 | grep "ELECTION" | wc -l)

echo "   -> Mensajes de 'ELECTION' detectados en la red: ${MSG_COUNT}"

if [ $MSG_COUNT -gt 20 ]; then
     echo -e "${RED}   [FAILED] Tormenta de Broadcast detectada (${MSG_COUNT} mensajes). Algoritmo ruidoso.${NC}"
else
     echo -e "${GREEN}   [PASSED] Tráfico de elección controlado (${MSG_COUNT} mensajes).${NC}"
fi

# Reactivar líder para la siguiente prueba
docker start ${LEADER_CONTAINER} > /dev/null
sleep 5

# ------------------------------------------------------------------------------
# BLOQUE 3: ATAQUE BIZANTINO (SEGURIDAD)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}[TEST 3/3] Lanzando Ataque Bizantino...${NC}"

# 1. Se ejecuta el script del atacante (requiere Node instalado localmente o vía docker)
# Asumimos que corremos node localmente para el test
if [ -f "chaos-attacker/attacker.js" ]; then
    echo "   -> Inyectando anomalías (5 segundos)..."
    timeout 5s node chaos-attacker/attacker.js > /dev/null 2>&1
else
    echo -e "${RED}   [ERROR] No se encuentra chaos-attacker/attacker.js${NC}"
fi

sleep 2

# 2. Se verifica defensas en los logs del suscriptor de persistencia o el coordinador
if docker logs publisher-1 2>&1 | grep -q "ATTACK_BLOCKED" || docker logs persistence-subscriber 2>&1 | grep -q "Vector Clock Anomaly"; then
    echo -e "${GREEN}   [PASSED] El sistema detectó y bloqueó la anomalía.${NC}"
else
    echo -e "${RED}   [FAILED] No hay logs de defensa. El sistema pudo haber aceptado datos corruptos.${NC}"
fi

echo -e "\n${BLUE}============================================================${NC}"
echo -e "${BLUE}                 FIN DE LA EVALUACIÓN                       ${NC}"
echo -e "${BLUE}============================================================${NC}"