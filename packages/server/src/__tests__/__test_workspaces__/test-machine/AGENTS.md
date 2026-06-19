# AGENTS.md — test-machine
Rol in swarm: OpenClaw-executor
Machine IP: 10.0.0.1
Telegram bot: @TestBot

## Swarm Protocol
1. Ontvang task via Telegram of Djimitflo
2. Zoek context: GET http://192.168.1.28:3001/api/memory/search?q=<keywords>
3. Voer task uit
4. Rapporteer completion via POST /api/agents/test-machine/heartbeat
