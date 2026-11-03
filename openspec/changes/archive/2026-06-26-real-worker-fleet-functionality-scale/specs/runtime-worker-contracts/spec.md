## ADDED Requirements

### Requirement: Runtime adapters are contract-probed before worker execution

Het systeem SHALL Codex en OpenCode runtime adapters proben voordat een real worker lease wordt uitgevoerd, zodat CLI drift niet pas tijdens een expensive worker run wordt ontdekt.

#### Scenario: Codex contract matches current CLI

- **WHEN** Djimitflo de Codex runtime contract probe uitvoert
- **THEN** verifieert Djimitflo dat `codex exec` JSONL output via `--json` ondersteunt
- **AND** verifieert Djimitflo dat de working directory via `--cd` wordt ingesteld
- **AND** slaat Djimitflo version, command, cwd flag, JSON flag, status en probe evidence op

#### Scenario: Codex contract drift blocks spawn

- **WHEN** de Codex CLI help output de vereiste flags niet bevat
- **THEN** markeert Djimitflo de runtime contract status als `drifted`
- **AND** weigert Djimitflo `/execute-worker` voordat een process wordt gespawned
- **AND** schrijft Djimitflo een actionable gate met de ontbrekende flags

#### Scenario: OpenCode contract matches current CLI

- **WHEN** Djimitflo de OpenCode runtime contract probe uitvoert
- **THEN** verifieert Djimitflo dat `opencode run` JSON output via `--format json` ondersteunt
- **AND** verifieert Djimitflo dat de working directory via `--dir` wordt ingesteld
- **AND** slaat Djimitflo version, command, cwd flag, JSON flag, status en probe evidence op

### Requirement: Runtime artifacts are operational data

Het systeem SHALL worker stdout, stderr, loop state, checkpoints en runtime artifacts onder een ignored runtime data root bewaren, niet in source directories.

#### Scenario: Default evidence root is under data directory

- **WHEN** de server zonder expliciete `LOOP_EVIDENCE_ROOT` draait
- **THEN** schrijft Djimitflo loop evidence onder `.data/agent-evidence/agentic-control-loop-fleet`
- **AND** schrijft Djimitflo geen runtime evidence onder `packages/server/agent-evidence`

#### Scenario: Explicit evidence root can override default

- **WHEN** `LOOP_EVIDENCE_ROOT` is gezet
- **THEN** gebruikt Djimitflo die absolute evidence root
- **AND** bewaart Djimitflo stdout/stderr artifact paths in worker lease metadata

### Requirement: Worker control artifacts are isolated from patch output

Het systeem SHALL loop work instructions en assignment packets in een ignored control directory bewaren zodat git diffs en status alleen relevante patch output tonen.

#### Scenario: Prepared worktree hides control files from git status

- **WHEN** Djimitflo een maker lease voorbereidt
- **THEN** schrijft Djimitflo work instructions naar `.djimitflo/LOOP_WORK.md`
- **AND** schrijft Djimitflo assignment packet naar `.djimitflo/ASSIGNMENT_PACKET.json`
- **AND** toont `git status --short` geen untracked root-level control files

#### Scenario: Review bundle still exposes control evidence

- **WHEN** een reviewer de loop review bundle opent
- **THEN** bevat de bundle paths naar work instructions en assignment packet
- **AND** blijven historical root-level packets uit oudere runs leesbaar

### Requirement: Runtime warnings are structured evidence

Het systeem SHALL runtime warnings uit stdout/stderr parsen naar gestructureerde lease metadata en gates.

#### Scenario: Advisory runtime warning is captured

- **WHEN** Codex stdout een plugin hook parse warning of skill context budget warning bevat
- **THEN** slaat Djimitflo deze op als `runtime_warnings`
- **AND** markeert Djimitflo low-risk runs met een advisory warning gate

#### Scenario: High-risk runtime warning blocks completion

- **WHEN** een high-risk loop runtime warning een trust boundary, policy, auth, secret, permission of capability raakt
- **THEN** markeert Djimitflo de warning gate als failed
- **AND** blijft completion geblokkeerd tot checker of human review de warning accepteert

### Requirement: Token efficiency is a first-class fleet metric

Het systeem SHALL echte runtime token usage gebruiken om worker efficiency te rapporteren en budgets te handhaven.

#### Scenario: Tokens per diff line are calculated

- **WHEN** een maker lease runtime usage en diff line count heeft
- **THEN** berekent Djimitflo `tokens_per_diff_line`
- **AND** bewaart Djimitflo deze metric op de lease of run summary

#### Scenario: Small worker exceeds token efficiency budget

- **WHEN** een low-risk worker meer tokens gebruikt dan de configured token efficiency threshold
- **THEN** markeert Djimitflo de run als budget-risk
- **AND** blokkeert Djimitflo nieuwe worker leases wanneer het harde token budget is bereikt
