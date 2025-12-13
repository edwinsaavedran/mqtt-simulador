#!/bin/bash
# gamemaker/sector-disaster.sh

LEADER="publisher-5" # Asumimos que este suele ser el líder por prioridad
FOLLOWER="publisher-1"

echo "   [GAME MAKER] Activando trampa en el Sector 5..."
echo "   -> Cortando comunicaciones de ${LEADER} (Simulando fallo de red)..."

# AISLAMIENTO
docker network disconnect mqtt-simulador_default ${LEADER}

echo "   -> Esperando reacción de los Tributos (10s)..."
# Barra de progreso visual
for i in {1..10}; do echo -ne "▓"; sleep 1; done; echo ""

# VERIFICACIÓN 1: ¿Eligieron nuevo líder?
echo "   -> Auditando logs del Sector 1..."
if docker logs --since 15s ${FOLLOWER} 2>&1 | grep -qE "ELECTION_WIN|NEW_LEADER|TERM_UPDATE"; then
    echo "   [OK] El Distrito se reorganizó. Nuevo líder electo."
else
    echo "   [FAIL] Pánico en los distritos. Nadie tomó el mando."
    docker network connect mqtt-simulador_default ${LEADER}
    exit 1
fi

# VERIFICACIÓN 2: ¿El viejo líder detectó su soledad?
# Debe haber hecho 'Step Down' al perder quorum
echo "   -> Verificando al líder exiliado..."
if docker logs --since 15s ${LEADER} 2>&1 | grep -qE "STEP_DOWN|QUORUM_LOST|DEMOTED"; then
    echo "   [OK] El viejo líder aceptó su destino y dimitió."
else
    echo "   [FAIL] ¡SPLIT BRAIN! El viejo líder sigue creyéndose rey en su soledad."
    docker network connect mqtt-simulador_default ${LEADER}
    exit 1
fi

# RESTAURACIÓN
echo "   [GAME MAKER] Retirando la niebla..."
docker network connect mqtt-simulador_default ${LEADER}
exit 0