## Context

Djimitflo v0.5.8 draait op workstation (192.168.1.28:3001) als productie-grade control plane. De 5 machines in het netwerk draaien Hermes-Agent of OpenClaw als agent runtime, bereikbaar via Telegram bots op het lokale netwerk. UAMS (`:8000`) en Qdrant (`:6333`) draaien al op de workstation en worden gebruikt door andere pipelines. Djimitflo heeft al WebSocket broadcasting, JWT auth, task/evidence/approval infrastructure en een SQLite database.

Huidige gap: agents opereren volledig geïsoleerd. Geen command routing, geen gedeeld geheugen, geen cross-machine context.

## Goals / Non-Goals

**Goals:**
- Telegram als command bus: inkomende berichten → Djimitflo tasks
- Agent registry uitgebreid met machine metadata en bot koppeling
- Task output gesynchroniseerd naar UAMS + Qdrant na completion
- Semantic context injection bij nieuwe task dispatch
- Skills push vanuit workstation naar remote agents
- JSONL training dataset export uit approval signalen

**Non-Goals:**
- Externe Telegram toegang (lokaal netwerk only)
- Multi-tenant bot isolation (één owner: Dennis)
- Vervangen van bestaande Hermes/OpenClaw agent runtimes
- Real-time video/audio via Telegram
- Automatische model fine-tuning (alleen dataset export)

## Decisions

### D7: OKF als actieve kennislaag (aparte repo)

Keuze: `djimitflo-knowledge` als aparte git-repo met OKF bundle onder `okf/`, lokaal gemount in djimitflo als `./knowledge` (symlink of workspace mapping). OKF (Markdown + YAML frontmatter) is de canonical source van kennis (skills, services, agents, runs, memory). Qdrant en GraphStore zijn afgeleide runtime-indexen die altijd opnieuw op te bouwen zijn vanuit de OKF-bestanden.

Waarom: OKF formaliseert de LLM-wiki pattern tot een portable, diffable en agent/mensleesbare bundel. Dit geeft de workstation een bron van waarheid die onafhankelijk versioned en gedeeld kan worden, los van applicatiecode.

Impact: Nieuwe repo `djimitflo-knowledge`; Djimitflo schrijft en leest via tools (validate/index/rebuild) en exposeert toegang via MCP.

### D8: OKF runtime integreert met bestaande infra (Qdrant, GraphStore, MCP)

Keuze: Hergebruik bestaande infrastructuur op de workstation:
- Embeddings: Ollama `nomic-embed-text:latest` (768d)
- Vector store: Qdrant (nieuwe collectie `djimit_okf` voor OKF-chunks)
- GraphStore: bestaande SQLite `combined_graph.db` (nieuwe nodes/edges voor OKF Concepts)
- MCP: `fastmcp` stdio server met 5 tools (`okf_search`, `okf_get`, `okf_related`, `okf_reindex`, `okf_status`)

Commitbeleid: checkpoint-auto-commit (na validated run of dagelijks rollup), geen commits per task. High-risk wijzigingen vereisen handmatige review. Trust-levels in OKF frontmatter sturen contextprioriteit aan (`agent_generated` < `validated` < `approved`).

### D1: Telegram library — `node-telegram-bot-api` vs `grammy`

**Keuze**: `grammy` (moderne ESM-first, TypeScript-native, compositie via middleware)

Reden: Djimitflo gebruikt ESM + strict TypeScript. `node-telegram-bot-api` heeft polling-based event model dat slecht composable is. `grammy` heeft middleware pipeline vergelijkbaar met Express — past architecturaal beter.

Alternatief: `node-telegram-bot-api` — bekender maar CommonJS-first, geen ingebouwde type inference op handlers.

### D2: Telegram adapter als apart package vs service in server

**Keuze**: `packages/telegram/` als apart npm workspace

Reden: Separation of concerns — Telegram is een transport layer, niet core business logic. Apart package kan onafhankelijk worden getest, gedeployd of uitgeschakeld. Server importeert het als dependency.

Alternatief: Ingebouwd in `packages/server/src/services/` — simpeler maar vermengt concerns, moeilijker te isoleren bij problemen.

### D3: Bot-per-machine vs één centrale bot

**Keuze**: Bot-per-machine (6 bots), centraal beheerd vanuit één `TelegramGatewayService`

Reden: Elke machine heeft eigen identiteit in de swarm. Berichten van een bot zijn traceerbaar naar een specifieke machine. Approval flows kunnen machine-specifiek zijn. Één centrale bot zou machine context verliezen.

Alternatief: Één bot met `/machine <id>` prefix — simpeler maar verliest directe machine routing.

### D4: Memory sync — push vs pull

**Keuze**: Push na task completion (event-driven via existing task lifecycle)

Reden: Djimitflo heeft al een `execution_events` stream en WebSocket broadcast. `MemorySyncService` hookt in op `task:completed` event — geen polling, geen extra infra. UAMS en Qdrant schrijven zijn fire-and-forget met retry.

Alternatief: Pull-based cron job — eenvoudiger te implementeren maar vertraagd, mist real-time context voor lopende sessies.

### D5: Qdrant collection strategie

**Keuze**: Nieuwe collection `djimitflo_swarm`, gescheiden van bestaande collections

Reden: Bestaande Qdrant collections (knowledge bank, 18.888 chunks) hebben andere embedding dimensies en metadata schemas. Swarm collection heeft eigen schema: `{ task_id, machine_id, agent_type, timestamp, content }`.

Embedding model: `all-MiniLM-L6-v2` (al in gebruik in bestaande infrastructure).

### D6: Context injection — altijd of opt-in

**Keuze**: Opt-in via task flag `use_swarm_context: boolean` (default: true voor nieuwe tasks)

Reden: Sommige tasks zijn bewust context-vrij (bijv. security scans). Default true voor maximale swarm voordeel, maar override mogelijk.

## Risks / Trade-offs

**[Risk] Telegram polling blocked bij netwerkproblemen** → Mitigation: `grammy` heeft ingebouwde retry + graceful shutdown; heartbeat failure markeert bot als offline in agent registry zonder crash.

**[Risk] Qdrant schrijft trager dan task completion** → Mitigation: Memory sync is async fire-and-forget; task lifecycle wordt niet geblokkeerd. Failures worden gelogd als audit events.

**[Risk] Database migratie breekt bestaande agent rows** → Mitigation: Nieuwe kolommen zijn nullable met DEFAULT NULL — backwards compatible. Bestaande rows krijgen NULL waarden.

**[Risk] grammy ESM import conflicten met bestaande server bundle** → Mitigation: `packages/telegram/` als apart workspace isoleert de dependency tree. Server importeert via workspace protocol.

**[Risk] Skills push naar remote agents — agent weigert onbekende skill** → Mitigation: Skills worden als Telegram bericht gestuurd met instructie; agent besluit zelf of het de skill toepast. Geen force-install.

## Migration Plan

1. Database migratie: `ALTER TABLE agents ADD COLUMN ...` (nullable, non-breaking)
2. Deploy `packages/telegram/` workspace
3. Start `TelegramGatewayService` als onderdeel van server startup
4. Maak `djimitflo_swarm` Qdrant collection aan bij eerste sync
5. Rollback: verwijder Telegram package import uit server, migratie kolommen blijven (nullable, geen impact)

## Open Questions

- Welk approval model voor cross-machine tasks? (bijv. Eve-V stuurt task, workstation moet approveren — wie is approver?)
- Skills push: volledige SKILL.md als bericht of alleen naam + locatie pointer?
- Training dataset export: alleen approved tasks of ook denied met reason?
