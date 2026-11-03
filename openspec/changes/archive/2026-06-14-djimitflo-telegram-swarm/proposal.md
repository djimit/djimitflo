## Why

Djimitflo is een volwaardige agent control plane maar opereert geïsoleerd — de 5 machines (workstation, Mac Mini, Eve-V, MacBook, DeerFlow) met hun Hermes/OpenClaw agents communiceren niet met elkaar en hebben geen gedeeld geheugen. Door Telegram als command bus en UAMS/Qdrant als geheugenlaag toe te voegen, ontstaat een functionerende swarm die gezamenlijk leert, taken uitwisselt en output deelt.

## What Changes

- **Nieuw**: `packages/telegram/` — TelegramGatewayService die 6 bots beheert en inkomende commando's vertaalt naar Djimitflo tasks
- **Nieuw**: Agent registry uitbreiding — `telegram_bot_id`, `machine_ip`, `agent_type`, `last_seen` kolommen in `agents` tabel
- **Nieuw**: Bot heartbeat endpoint `POST /api/agents/:id/heartbeat`
- **Nieuw**: `MemorySyncService` — schrijft task output naar UAMS en Qdrant (`djimitflo_swarm` collection) na completion
- **Nieuw**: Context injection bij task dispatch — top-3 Qdrant resultaten als context prefix
- **Nieuw**: `POST /api/memory/search` endpoint voor semantic search over swarm outputs
- **Nieuw**: Skills distributie `POST /api/agents/:id/skills` — push OpenCode skills naar remote agents via Telegram
- **Nieuw**: `/api/exports/training` — JSONL training dataset uit approved/denied tasks
- **Modificatie**: `agents` routes uitgebreid met heartbeat + machine awareness
- **Modificatie**: WebSocket broadcast gefilterd op machine scope voor cross-bot delivery

## Capabilities

### New Capabilities

- `telegram-gateway`: Telegram bot adapter — 6 bots, per-machine config, command routing (`/task`, `/status`, `/approve`, `/memory`, `/research`)
- `swarm-memory`: Cross-machine geheugenbus via UAMS + Qdrant; embed + store na task completion; semantic search endpoint
- `context-injection`: Automatische context prefill bij task dispatch o.b.v. Qdrant similarity search
- `skills-distribution`: Push skills vanuit workstation naar remote agents via Telegram berichten
- `swarm-training`: Feedback loop via approval signalen; JSONL training dataset export

### Modified Capabilities

- `agent-registry`: `agents` tabel uitgebreid met machine metadata en Telegram koppeling

## Impact

- **Code**: nieuw `packages/telegram/` workspace; `packages/server/src/services/memory-sync-service.ts`; routes `agents.ts`, `memory.ts`, `exports.ts` uitgebreid
- **Dependencies**: `node-telegram-bot-api` (of `grammy`) toegevoegd aan server workspace
- **Database**: migratie voor `agents` tabel nieuwe kolommen
- **Infra**: UAMS `http://192.168.1.28:8000`, Qdrant `192.168.1.28:6333` — al beschikbaar op workstation
- **Geen breaking changes** voor bestaande API consumers
