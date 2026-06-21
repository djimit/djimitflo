# pi-loop-runtime Specification

## Purpose
TBD - created by archiving change add-pi-loop-runtime. Update Purpose after archive.
## Requirements
### Requirement: Pi is a selectable loop runtime

Het systeem SHALL `'pi'` ondersteunen als een `runtime` in de `LoopService`-fleet, op gelijke voet met `codex`/`opencode`/`claude`/`gemini`/`editor`/`mock`. Een loop-run kan `runtime: 'pi'` aanvragen; de uitvoering gebeurt one-shot per worker-lease als een extern child-process, zonder persistente worker of RPC-transport.

#### Scenario: Pi runtime is available when binary present

- **WHEN** de Pi binary beschikbaar is (`PI_BIN_PATH` of `pi` op PATH)
- **AND** een loop-run vraagt `runtime: 'pi'`
- **THEN** slaagt `assertRuntimeAvailable('pi')`
- **AND** wordt een maker-lease met `runtime: 'pi'` aangemaakt in de eigen worktree

#### Scenario: Pi runtime fails fast when absent

- **WHEN** de Pi binary niet beschikbaar is
- **AND** een loop-run vraagt `runtime: 'pi'`
- **THEN** faalt `assertRuntimeAvailable('pi')` met `RUNTIME_UNAVAILABLE`
- **AND** wordt er geen lease of worktree aangemaakt

### Requirement: Pi runtime command builds a headless sovereign invocation

Het systeem SHALL `buildRuntimeCommand('pi', worktreePath, prompt, skipPermissions)` bouwen naar `pi --mode json -p --no-session --no-approve --no-context-files --no-extensions --no-skills --offline --tools <PI_TOOLS> --provider <PI_PROVIDER> --model <PI_MODEL> <prompt>`, gespawnd met `cwd = worktreePath`.

#### Scenario: Pi runs cwd-scoped in the lease worktree

- **WHEN** een maker-lease met `runtime: 'pi'` wordt uitgevoerd
- **THEN** draait Pi met `cwd` gelijk aan de lease-worktree
- **AND** zijn Pi's bestandstools (read/ls/edit/write) beperkt tot die worktree
- **AND** valt het artifact in de worktree, niet in een bovenliggende map

#### Scenario: Sovereign run has zero external egress

- **WHEN** `PI_OFFLINE=1`, `PI_TELEMETRY=0` en `PI_SKIP_VERSION_CHECK=1` zijn ingesteld
- **THEN** maakt de Pi-runtime geen externe API-aanroepen tijdens de loop-run
- **AND** wordt het model lokaal via Ollama geserveerd

### Requirement: Risk control via tools allowlist and djimitflo approval, not Pi permissions

Het systeem SHALL risicobeheer voor de Pi-runtime doen via de `PI_TOOLS`-allowlist (standaard zonder `bash`) en djimitflo's goedkeuringsgate vóór de lease, NIET via Pi-eigen permission-popups (Pi heeft die niet).

#### Scenario: Low-risk run excludes bash

- **WHEN** een low-risk Pi-maker-lease wordt uitgevoerd
- **THEN** staat `PI_TOOLS` `bash` niet toe
- **AND** vereisen high-risk runs (inclusief `bash`) djimitflo-goedkeuring vóór de lease

### Requirement: Shared Pi args and event mapping

Het systeem SHALL de Pi-argumentenbouw (`buildPiArgs`) en de NDJSON→event-mapping (`mapPiEvent`) centraliseren in één gedeelde module, gebruikt door zowel de manuele `PiExecutor` als de loop-runtime-adapter, zodat de twee paden niet uit elkaar lopen.

#### Scenario: Both paths use the same mapping

- **WHEN** de manuele `executeTask`-pas of de loop-runtime-adapter Pi aanroept
- **THEN** gebruiken beide dezelfde `buildPiArgs`- en `mapPiEvent`-implementatie
- **AND** produceren ze identieke executor-flags en event-mapping

### Requirement: Token usage and trace evidence for Pi leases

Het systeel SHALL Pi's `message.usage` (input/output/totalTokens) uit de stdout parsen naar de worker-lease-runtimemetrics (`usage_source: 'runtime_stdout'`) en de NDJSON-events door de loop-event/trace-afhandeling leiden, identiek aan codex/opencode.

#### Scenario: Completed Pi lease records usage and spans

- **WHEN** een Pi-maker-lease succesvol voltooit
- **THEN** staat tokengebruik op de worker-lease
- **AND** zijn er trace-spans voor spawn en voltooiing/falen
- **AND** zijn diff-snapshot, risicoclassificatie en audit-trail gevuld zoals bij codex/opencode

