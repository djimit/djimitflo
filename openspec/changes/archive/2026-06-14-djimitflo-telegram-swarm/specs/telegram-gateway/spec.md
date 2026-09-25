## ADDED Requirements

### Requirement: TelegramGatewayService beheert 6 bots

Het systeem SHALL een `TelegramGatewayService` bieden die tegelijk polling start voor alle geconfigureerde bots. Elke bot heeft een `machineId`, `agentType` (Hermes/OpenClaw/DeerFlow) en `hostIp`.

#### Scenario: Alle bots starten bij server startup

- **WHEN** de server opstart en `TELEGRAM_BOTS_CONFIG` is geconfigureerd
- **THEN** start de service polling voor elke bot en logt "Bot <name> online op <machineId>"

#### Scenario: Bot offline bij netwerkfout

- **WHEN** een bot 3 opeenvolgende polling-fouten krijgt
- **THEN** markeert de service de bot als `offline` in de agent registry en logt een audit event

### Requirement: Inkomend `/task` commando maakt Djimitflo task aan

Het systeem SHALL een inkomend `/task <prompt>` bericht vertalen naar een `POST /api/tasks` call met `created_by` gelijk aan het `machineId` van de afzendende bot.

#### Scenario: Succesvol task aanmaken via Telegram

- **WHEN** een gebruiker `/task analyseer de git diff op workstation` stuurt via Djimit2_bot
- **THEN** maakt het systeem een task aan met `prompt = "analyseer de git diff op workstation"`, `created_by = "workstation"` en stuurt de task ID terug als Telegram bericht

#### Scenario: Lege task prompt geweigerd

- **WHEN** een gebruiker `/task` stuurt zonder prompt
- **THEN** antwoordt de bot met "Gebruik: /task <beschrijving van wat de agent moet doen>"

### Requirement: `/status` commando rapporteert machine status

Het systeem SHALL op `/status` de huidige agent status van de afzendende machine retourneren inclusief laatste heartbeat, actieve tasks en agent type.

#### Scenario: Status opvragen

- **WHEN** een gebruiker `/status` stuurt via DjimitMacMini_bot
- **THEN** antwoordt de bot met machine IP, agent type, laatste heartbeat timestamp en aantal actieve tasks

### Requirement: `/approve <id>` commando keurt een task goed

Het systeem SHALL `/approve <taskId>` accepteren en de bijbehorende approval request in Djimitflo goedkeuren met `decided_by = machineId`.

#### Scenario: Geldige approval via Telegram

- **WHEN** een admin-user `/approve abc123` stuurt
- **THEN** keurt het systeem de open approval request voor task `abc123` goed en bevestigt via Telegram

#### Scenario: Onbekend task ID

- **WHEN** een gebruiker `/approve onbekend-id` stuurt
- **THEN** antwoordt de bot met "Geen openstaande approval gevonden voor id: onbekend-id"

### Requirement: `/memory <query>` zoekt in swarm geheugen

Het systeem SHALL `/memory <query>` vertalen naar een `GET /api/memory/search?q=<query>` call en de top-3 resultaten als Telegram bericht retourneren.

#### Scenario: Geheugenzoektocht

- **WHEN** een gebruiker `/memory typescript ESM configuratie` stuurt
- **THEN** antwoordt de bot met maximaal 3 resultaten: source machine, timestamp en excerpt van maximaal 200 tekens

### Requirement: `/research <topic>` dispatcht naar DeerFlow

Het systeem SHALL `/research <topic>` ontvangen op Djimitflowbot en een DeerFlow research pipeline starten via `http://192.168.1.28:2026`.

#### Scenario: Research gestart

- **WHEN** een gebruiker `/research EU AI Act compliance vereisten 2026` stuurt via Djimitflowbot
- **THEN** start het systeem de DeerFlow pipeline en antwoordt "Research gestart: <topic>. Resultaten worden gebroadcast na completion."

### Requirement: Websocket broadcast naar relevante bots

Het systeem SHALL Djimitflo WebSocket events (task status updates, approval requests) doorsturen als Telegram berichten naar de bot van de machine die de task aanmaakte.

#### Scenario: Task completion bericht

- **WHEN** een task met `created_by = "macmini"` de status `completed` bereikt
- **THEN** stuurt het systeem een Telegram bericht via DjimitMacMini_bot met task ID en samenvatting
