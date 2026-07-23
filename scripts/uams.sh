#!/bin/bash
# UAMS CLI — structurele fix voor MacBook toegang tot workstation UAMS
#
# Gebruikt SSH exec in plaats van HTTP tunnel.
# Elke query wordt via SSH naar de workstation gestuurd.
#
# Gebruik:
#   ./scripts/uams.sh health
#   ./scripts/uams.sh search "governance" 5
#   ./scripts/uams.sh stats

set -euo pipefail

WORKSTATION="djimit@192.168.1.28"
API_KEY="${RESEARCH_AGENT_API_KEY:-djimit-local-research-agent-key-2026}"
UAMS_URL="http://localhost:8000/memory"

case "${1:-help}" in
    health)
        ssh -o ConnectTimeout=5 "$WORKSTATION" \
            "curl -s $UAMS_URL/health"
        ;;
    
    search)
        QUERY="${2:-governance}"
        LIMIT="${3:-5}"
        ssh -o ConnectTimeout=10 "$WORKSTATION" \
            "curl -s -X POST $UAMS_URL/search \
            -H 'Content-Type: application/json' \
            -H 'Authorization: Bearer $API_KEY' \
            -d '{\"query\": \"$QUERY\", \"limit\": $LIMIT}'"
        ;;
    
    stats)
        ssh -o ConnectTimeout=5 "$WORKSTATION" \
            "curl -s $UAMS_URL/stats"
        ;;
    
    *)
        echo "Gebruik: $0 {health|search|stats}"
        echo ""
        echo "Voorbeelden:"
        echo "  $0 health"
        echo "  $0 search governance 10"
        echo "  $0 stats"
        exit 1
        ;;
esac
