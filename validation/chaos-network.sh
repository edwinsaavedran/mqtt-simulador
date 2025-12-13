#!/bin/bash
# chaos-network.sh

NETWORK_NAME="mqtt-simulador_default" # Ajustar según el nombre real de la red docker
VICTIM="publisher-1"

echo -e "\n [CHAOS] Iniciando Simulación de Partición de Red..."

# 1. Aislar al nodo víctima
echo "   -> Desconectando ${VICTIM} de la red (Simulando corte de fibra)..."
docker network disconnect $NETWORK_NAME $VICTIM

echo "   -> La víctima está aislada. El clúster debería detectar la ausencia en 10s (Gossip/Failure Detector)."
echo "   -> Esperando 15 segundos..."
sleep 15

# 2. Verificación Manual (Logs de otros nodos)
echo "   -> Auditando logs de los sobrevivientes..."
if docker logs publisher-2 2>&1 | grep -qE "SUSPECT|DEAD|NodeDown"; then
    echo -e " [PASS] El clúster detectó la caída del nodo."
else
    echo -e " [FAIL] El clúster no se dio cuenta de la partición (Fallo en Gossip/Heartbeat)."
fi

# 3. Curación (Heal)
echo "   -> Reconectando ${VICTIM}..."
docker network connect $NETWORK_NAME $VICTIM

echo "   -> Esperando convergencia (10s)..."
sleep 10

# 4. Verificación de Sincronización
if docker logs $VICTIM 2>&1 | grep -qE "SYNC|MERGE|TopologyUpdated"; then
    echo -e " [PASS] El nodo víctima se reintegró y sincronizó."
else
    echo -e " [WARN] No se detectaron logs explícitos de resincronización."
fi