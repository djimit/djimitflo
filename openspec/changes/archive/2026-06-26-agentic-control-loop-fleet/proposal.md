## Why

Djimitflo is bedoeld als control plane voor Codex, OpenCode en andere Djimit agents. Ruflo is waardevolle inspiratie voor swarm-denken, maar Ruflo zelf is voor Claude en moet geen runtime-dependency of bron van waarheid worden binnen Djimitflo.

De huidige bottleneck is niet "er bestaat geen coordinator"; de bottleneck is dat Djimitflo werk nog te veel als enkele agent-run modelleert. Voor echte throughput moet Djimitflo veel agents tegelijk kunnen spinnen, ze via meetbare goals laten samenwerken, maker/checker scheiden, state bewaren en de volgende stap automatisch bepalen binnen governance-grenzen.

De Loopcraft/Loop Engineering analyse wijst de juiste richting: vervang losse prompts door ontworpen control loops. Een loop doet discovery, planning, execution, verification, memory update en governance escalation. Djimitflo moet dit expliciet ondersteunen als **Agentic Control Loop Framework**.

## What Changes

- **Nieuw**: standaard loop contract met `goal`, `trigger`, `context_sources`, `actions_allowed`, `verification`, `state`, `escalation` en stopcondities.
- **Nieuw**: `/goals` lifecycle waarmee grote doelen worden gedecomponeerd naar loop-runs, taken en agent assignments.
- **Nieuw**: `/loop` lifecycle waarmee agents zelf de volgende stap voorstellen, uitvoeren, verifiëren en state updaten totdat stopcondities bereikt zijn.
- **Nieuw**: fleet orchestration voor tientallen tot honderden Codex/OpenCode workers met leases, budgets, worktree isolation, maker/checker separation en backpressure.
- **Nieuw**: project-local loop skills die discovery, planning, execution, verification, memory en governance orkestreren.
- **Nieuw**: deterministic quality gates als doorslaggevende verifier; LLM-reviewers zijn aanvullend, niet beslissend.

## Non-Goals

- Geen Ruflo runtime-integratie in fase 1.
- Geen auto-merge, auto-deploy of unattended production mutation.
- Geen self-learning policy updates zonder human approval.
- Geen open-ended "verbeter alles" loops zonder meetbare stopconditie.
- Geen claim dat meer agents automatisch betere output geven; throughput wordt begrensd door gates, budgets en review.

## Success Criteria

- Een operator kan een goal aanmaken via API/CLI/dashboard met meetbare acceptatiecriteria.
- Djimitflo kan dat goal omzetten naar een loop plan met maker/checker agents.
- Een closed loop kan meerdere Codex/OpenCode workers parallel starten in aparte worktrees.
- Elke loop-run heeft state op disk/OKF plus database events, zodat hij hervatbaar en auditable is.
- Verification gebruikt tests, lint, typecheck, security checks en reviewer verdicts, met harde stopcondities.
- Agents mogen de volgende stap voorstellen via `/loop`, maar governance bepaalt of die stap uitgevoerd mag worden.
- De eerste implementatiekandidaat is `doc-drift-and-small-fix-loop`, niet brede auto-ship automation.
