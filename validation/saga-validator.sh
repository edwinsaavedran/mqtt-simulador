#!/bin/bash
# saga-validator.sh

COORDINATOR="publisher-5" # Quien orquesta
NODE_A="publisher-1"      # Recurso 1 (Giroscopio)
NODE_B="publisher-2"      # Recurso 2 (Propulsor) - EL QUE FALLARÁ

echo -e "\n [SAGA] Iniciando Prueba de Transacción Distribuida con Fallo..."

# 1. Limpiar logs (conceptualmente, marcamos timestamp)
START_TIME=$(date +%s)

# 2. Disparar la Saga (Trigger externo via MQTT)
# El estudiante debe haber implementado un endpoint/topic para iniciar la saga
echo "   -> Solicitando Operación: ROTATE_SATELLITE..."
docker exec mqtt-broker mosquitto_pub -t "cmd/saga/rotate" -m '{"target": "90deg", "id": "tx-999"}'ss

# 3. Esperar un instante y ASESINAR al Nodo B justo cuando debería recibir la orden
sleep 1
echo "   ->  Simulando fallo catastrófico en Nodo B (Propulsor)..."
docker stop $NODE_B

# 4. Esperar a que el Coordinador reaccione (Timeout + Compensación)
echo "   -> Esperando timeout y compensación del Coordinador (5s)..."
sleep 5

# 5. Verificar Logs en el Nodo A (¿Recibió la orden de deshacer?)
# Buscamos "UNLOCK" o "COMPENSATE" o "ROLLBACK"
echo "   -> Auditando Nodo A (Giroscopio) para ver si revirtió..."

if docker logs $NODE_A --since 10s 2>&1 | grep -qE "UNLOCK|COMPENSATE|ROLLBACK"; then
    echo -e " [PASS] SAGA EXITOSA: La compensación se ejecutó automáticamente."
else
    echo -e " [FAIL] DATA CORRUPTION: El Nodo A quedó bloqueado y el Nodo B murió. Estado inconsistente."
    echo "      (Esperaba ver logs de 'UNLOCK' o 'COMPENSATE' en $NODE_A)"
fi

# Restaurar entorno
docker start $NODE_B > /dev/null