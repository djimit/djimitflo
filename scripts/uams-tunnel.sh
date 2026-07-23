#!/bin/bash
# UAMS SSH Tunnel — structurele fix voor MacBook toegang tot workstation UAMS
# 
# Dit script zet een SSH tunnel op naar de workstation zodat UAMS
# bereikbaar is via localhost:8000 op de MacBook.
#
# Gebruik:
#   ./scripts/uams-tunnel.sh start   # Start de tunnel
#   ./scripts/uams-tunnel.sh stop    # Stop de tunnel
#   ./scripts/uams-tunnel.sh status  # Check tunnel status
#   ./scripts/uams-tunnel.sh test    # Test UAMS verbinding

set -euo pipefail

TUNNEL_PID_FILE=".uams-tunnel.pid"
WORKSTATION="djimit@192.168.1.28"
LOCAL_PORT=8000
REMOTE_PORT=8000

case "${1:-status}" in
    start)
        if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
            echo "Tunnel draait al (PID: $(cat "$TUNNEL_PID_FILE"))"
            exit 0
        fi
        
        echo "Start SSH tunnel naar workstation UAMS..."
        ssh -f -N -L ${LOCAL_PORT}:localhost:${REMOTE_PORT} "$WORKSTATION"
        
        # Find the tunnel PID
        sleep 1
        TUNNEL_PID=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}.*${WORKSTATION}" | head -1)
        echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
        echo "Tunnel gestart (PID: $TUNNEL_PID)"
        
        # Test verbinding
        sleep 1
        if curl -s --connect-timeout 3 http://localhost:${LOCAL_PORT}/memory/health > /dev/null 2>&1; then
            echo "UAMS bereikbaar via localhost:${LOCAL_PORT}"
        else
            echo "⚠️  UAMS nog niet bereikbaar — tunnel duurt mogelijk langer"
        fi
        ;;
    
    stop)
        if [ -f "$TUNNEL_PID_FILE" ]; then
            PID=$(cat "$TUNNEL_PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                kill "$PID"
                echo "Tunnel gestopt (PID: $PID)"
            else
                echo "Tunnel draait niet meer (PID: $PID)"
            fi
            rm -f "$TUNNEL_PID_FILE"
        else
            # Try to find and kill any matching tunnel
            PID=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}" | head -1)
            if [ -n "$PID" ]; then
                kill "$PID"
                echo "Tunnel gestopt (PID: $PID)"
            else
                echo "Geen actieve tunnel gevonden"
            fi
        fi
        ;;
    
    status)
        if [ -f "$TUNNEL_PID_FILE" ] && kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
            echo "Tunnel draait (PID: $(cat "$TUNNEL_PID_FILE"))"
        elif pgrep -f "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}" > /dev/null 2>&1; then
            echo "Tunnel draait (PID: $(pgrep -f "ssh.*-L ${LOCAL_PORT}:localhost:${REMOTE_PORT}"))"
        else
            echo "Tunnel draait niet"
        fi
        
        # Test UAMS
        if curl -s --connect-timeout 3 http://localhost:${LOCAL_PORT}/memory/health > /dev/null 2>&1; then
            echo "UAMS bereikbaar"
        else
            echo "UAMS niet bereikbaar"
        fi
        ;;
    
    test)
        echo "Test UAMS verbinding..."
        
        # Via tunnel (localhost)
        echo -n "  Via localhost: "
        if curl -s --connect-timeout 3 http://localhost:${LOCAL_PORT}/memory/health 2>&1 | head -1; then
            echo "✅ OK"
        else
            echo "❌ Niet bereikbaar"
        fi
        
        # Direct via workstation (SSH)
        echo -n "  Via SSH: "
        if ssh -o ConnectTimeout=3 "$WORKSTATION" "curl -s http://localhost:${REMOTE_PORT}/memory/health" 2>&1 | head -1; then
            echo "✅ OK"
        else
            echo "❌ Niet bereikbaar"
        fi
        ;;
    
    *)
        echo "Gebruik: $0 {start|stop|status|test}"
        exit 1
        ;;
esac
