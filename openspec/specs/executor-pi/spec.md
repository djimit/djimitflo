# executor-pi Specification

## Purpose
TBD - created by archiving change add-pi-executor. Update Purpose after archive.
## Requirements
### Requirement: Pi executor is a pluggable TaskExecutor

Het systeem SHALL een `PiExecutor` leveren die de bestaande `TaskExecutor`-interface implementeert (`kind`, `start`, `canExecute`) en een `ExecutionSession` retourneert met `events`, `result` en `cancel`, identiek aan het Codex/OpenCode-patroon. Pi wordt als extern child-process gespawnd; djimitflo krijgt geen runtime-afhankelijkheid op Pi.

#### Scenario: Pi task routes to PiExecutor

- **WHEN** een taak met `executorKind: 'pi'` wordt uitgevoerd
- **THEN** leidt de execution engine de taak naar `PiExecutor`
- **AND** wordt de Pi binary gespawnd met de working-directory van de taak-worktree

#### Scenario: Cancellation terminates the child

- **WHEN** `cancel()` wordt aangeroepen op een lopende Pi-sessie
- **THEN** stuurt de executor SIGTERM naar het child-process
- **AND** volgt na de grace period een SIGKILL indien nodig
- **AND** wordt de sessiestatus `cancelled`

### Requirement: Pi events map into the shared execution event model

Het systeem SHALL Pi-uitvoer mappen naar `ExecutionEventCreateInput` met `ExecutionEventType` en `LogLevel`. Wanneer Pi gestructureerde (ND)JSON levert, gebruikt de executor een JSON-mapper; anders valt hij terug op de bestaande heuristic parser met een `EVIDENCE WARNING` event, conform het Codex-voorbeeld.

#### Scenario: Structured output is mapped

- **WHEN** Pi NDJSON regels met herkenbare event-types produceert
- **THEN** mapt de executor die naar `TASK_STARTED`, `TOOL_CALL`, `LOG`, `TOOL_RESULT`, `TASK_COMPLETED` of `TASK_FAILED`
- **AND** wordt een `tool_name` gevuld voor tool-events waar beschikbaar

#### Scenario: Non-JSON output degrades gracefully

- **WHEN** Pi geen geldige JSON produceert
- **THEN** schakelt de executor over naar heuristic parsing
- **AND** emit hij een `EVIDENCE WARNING` event met `parsing_mode: heuristic_fallback`

### Requirement: Sovereign local-model runs with zero API egress

Het systeem SHALL Pi-configuraties ondersteunen die een lokaal Ollama-model gebruiken op de workstation, zodat een sovereign run geen externe API-egress vereist. De binary, time-out, permission-bypass en output-format worden via omgevingsvariabelen gestuurd (`PI_BIN_PATH`, `PI_EXECUTION_TIMEOUT_MS`, `PI_SKIP_PERMISSIONS`, `PI_OUTPUT_FORMAT`).

#### Scenario: Local model run completes without external egress

- **WHEN** een Pi-taak wordt uitgevoerd met een lokaal Ollama-model op de workstation
- **THEN** completeert de run zonder externe API-aanroepen
- **AND** worden diff-snapshot, risicoclassificatie en audit-trail gevuld zoals bij andere executors

#### Scenario: Permission bypass is explicit and warned

- **WHEN** `skipPermissions` actief is via optie of `PI_SKIP_PERMISSIONS`
- **THEN** emit de executor een `SECURITY OVERRIDE` warning event
- **AND** blijft djimitflo's policy-engine de autoritatieve approval-laag

### Requirement: Instruction precedence is enforced

Het systeem SHALL ervoor zorgen dat Pi's eigen AGENTS.md/instructie-lading de workspace- en project-instructielagen niet overschrijft, conform de DjimIT-instructievoorrang: workspace `AGENTS.md` > project `AGENTS.md`/`CLAUDE.md` > djimitflo-taakinjectie > tool-defaults.

#### Scenario: Governance instructions are not overridden by Pi

- **WHEN** Pi zijn eigen instructiebestanden laadt tijdens een run
- **THEN** blijft de workspace-/project-governance leidend
- **AND** legt de audit-trail vast welke instructieset van kracht was

### Requirement: Pi executor is independently removable

Het systeem SHALL de Pi-integratie verwijderbaar houden door `PiExecutor` uit te schrijven en `'pi'` uit de betreffende union-literals en `pi_path` uit de config te halen, zonder dat andere executor-gedrag verandert.

#### Scenario: Rollback restores prior behavior

- **WHEN** de Pi-executor en de bijbehorende type/config-toevoegingen worden terugge draaid
- **THEN** vertonen Codex/OpenCode/Claude/Gemini ongewijzigd gedrag
- **AND** bestaan er geen verweesde verwijzingen naar `'pi'`

