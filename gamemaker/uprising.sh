#!/bin/bash
# gamemaker/uprising.sh

COORDINATOR="publisher-2" # Quien inicia la saga
SABOTEUR="publisher-3"    # Quien fallará (El traidor)

echo "   [BEETEE] Hackeando el sistema de transmisión..."
echo "   -> Iniciando 'Operación: Derribar Presa' (Saga ID: SINS-001)..."

# 1. Marcar tiempo
START_TIME=$(date +%s)

# 2. Iniciar la Saga via MQTT (El estudiante debe tener este topic)
docker exec mqtt-broker mosquitto_pub -t "cmd/saga/start" -m '{"sagaId": "SINS-001", "steps": ["hack_grid", "blow_dam"]}'

# 3. El momento dramático: Matar al nodo encargado del paso 2 justo cuando empieza
sleep 1
echo "   -> ¡BOMBARDEO EN EL DISTRITO 3! Matando al nodo ${SABOTEUR}..."
docker stop ${SABOTEUR}

# 4. Esperar compensación
echo "   -> Esperando que el Coordinador detecte el fallo y ordene retirada (5s)..."
sleep 5

# 5. Verificar Logs: Buscamos palabras clave de compensación
echo "   -> Analizando daños..."
if docker logs --since 10s ${COORDINATOR} 2>&1 | grep -qE "COMPENSATION|ROLLBACK|UNDO|ABORT"; then
    echo "   [OK] Retirada exitosa. El sistema volvió a estado consistente."
    docker start ${SABOTEUR} > /dev/null
    exit 0
else
    echo "   [FAIL] Desastre. La mitad de la operación se ejecutó y la otra no. Estado corrupto."
    docker start ${SABOTEUR} > /dev/null
    exit 1
fi