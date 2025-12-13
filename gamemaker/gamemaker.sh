#!/bin/bash
# gamemaker.sh - "May the odds be ever in your favor"

# Colores del Distrito
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo -e "${CYAN}"
echo "   (  )   THE UTP GAMES: DISTRIBUTED SYSTEMS EDITION"
echo "    \/    ---------------------------------------------"
echo "    ()    SISTEMA DE VALIDACIÓN 'NOS VEMOS v1.0'"
echo "   (  )   "
echo -e "${NC}"

echo -e "${YELLOW}[SNOW]: Bienvenidos, Tributos. Habéis codificado duro. Ahora veremos si vuestra arquitectura sobrevive a la Arena.${NC}"
echo -e "${YELLOW}[SNOW]: Si el sistema falla, sonará el cañón.${NC}"
sleep 2

SCORE=0

# ----------------------------------------------------------------
# RONDA 1: EL RASTREO (Gossip Protocol)
# ----------------------------------------------------------------
echo -e "\n${CYAN}>>> INICIANDO RONDA 1: EL RASTREO (Discovery & Gossip)${NC}"
echo "   Objetivo: Demostrar que los nodos se encuentran sin configuración estática."

node gamemaker/arena-tracker.js
if [ $? -eq 0 ]; then
    echo -e "${GREEN}   * VICTORIA: Los tributos se han aliado. El mapa está completo.${NC}"
    SCORE=$((SCORE + 1))
else
    echo -e "${RED}   ☠ CAÑÓN: Un tributo está solo y perdido. Fallo de Gossip.${NC}"
    echo "   (Consejo: Revisa si tu 'merge' de listas está funcionando)"
fi
sleep 2

# ----------------------------------------------------------------
# RONDA 2: LA NIEBLA (Partición de Red & Quorum)
# ----------------------------------------------------------------
echo -e "\n${CYAN}>>> INICIANDO RONDA 2: LA NIEBLA (Split-Brain & Quorum)${NC}"
echo "   Objetivo: Sobrevivir a la pérdida de comunicación sin corromper datos."

bash gamemaker/sector-disaster.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}   * VICTORIA: El sistema resistió la partición. No hubo corrupción.${NC}"
    SCORE=$((SCORE + 1))
else
    echo -e "${RED}   ☠ CAÑÓN: El líder entró en pánico. Datos inconsistentes detectados.${NC}"
fi
sleep 2

# ----------------------------------------------------------------
# RONDA 3: EL LEVANTAMIENTO (Saga Transaccional)
# ----------------------------------------------------------------
echo -e "\n${CYAN}>>> INICIANDO RONDA 3: EL ASALTO (Distributed Transactions)${NC}"
echo "   Objetivo: Ejecutar una operación compleja. Si un distrito falla, todos deben retroceder."

bash gamemaker/uprising.sh
if [ $? -eq 0 ]; then
    echo -e "${GREEN}   * VICTORIA: El Capitolio ha caído. La transacción fue atómica.${NC}"
    SCORE=$((SCORE + 1))
else
    echo -e "${RED}   ☠ CAÑÓN: La rebelión fue aplastada. Estado inconsistente (Zombie Transaction).${NC}"
fi

# ----------------------------------------------------------------
# VEREDICTO FINAL
# ----------------------------------------------------------------
echo -e "\n------------------------------------------------------------"
if [ $SCORE -eq 3 ]; then
    echo -e "${GREEN} RESULTADO: VICTORIA TOTAL. ERES EL SINSAJO.${NC}"
    echo " Has demostrado maestría en sistemas distribuidos."
elif [ $SCORE -eq 2 ]; then
    echo -e "${YELLOW} RESULTADO: SOBREVIVIENTE.${NC}"
    echo " Has ganado los juegos, pero con heridas graves. Revisa tu código."
else
    echo -e "${RED} RESULTADO: MUERTE EN LA ARENA.${NC}"
    echo " Tus algoritmos no fueron lo suficientemente fuertes. Inténtalo el próximo ciclo."
fi
echo -e "------------------------------------------------------------\n"