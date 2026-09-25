# Real Worker Fleet Functionality And Scale

## Why

De echte Codex worker-run bewees dat Djimitflo nu werkelijk workers kan spawnen, stdout/stderr artifacts kan bewaren, runtime token usage kan parsen, checkpoints kan schrijven en trace spans kan vastleggen. De volgende stap is volledige fleet-functionaliteit: zichtbaar maken wat er draait, wat klaarstaat, wat blokkeert, hoeveel capaciteit beschikbaar is, welke worker waar waarde levert en hoe veel bounded work veilig parallel kan worden uitgevoerd.

- Codex CLI contract drift brak de eerste live run (`--format json --dir` versus `--json --cd`), dus runtime capability moet zichtbaar zijn.
- Een kleine README-fix gebruikte meer dan 200k tokens, dus token efficiency moet een schaalmetric worden.
- Runtime artifacts schreven aanvankelijk naar source-local `packages/server/agent-evidence`, dus evidence moet als operationele data worden beheerd.
- Maker execution werkt, maar checker execution en auto-closure zijn nog niet volledig gesloten, dus de worker pipeline moet end-to-end zichtbaar worden.
- Runtime warnings uit Codex verschijnen wel in logs, maar zijn nog geen gestructureerde telemetry.
- Assignment/control files staan als untracked files in worker worktrees en vervuilen patch review.
- Swarm status moet onderscheid maken tussen registered agents, prepared leases, queued work, running workers, blocked gates en echte capaciteit.

Deze change maakt van de real-worker bridge een schaalbare, inzichtelijke, budgetbewuste worker fleet.

## What Changes

- Voeg een runtime contract harness toe voor Codex/OpenCode adapters met help/probe validation, capability metadata en drift-failures voordat leases worden uitgevoerd.
- Voeg een dedicated low-context worker profile toe zodat kleine low-risk tasks niet honderdduizenden tokens verbranden.
- Voeg een checker worker execution bridge toe, gescheiden van maker execution en read-only by contract.
- Isoleer loop control artifacts onder een ignored `.djimitflo/` control directory in worker worktrees.
- Parse runtime warnings uit stdout/stderr naar lease metadata, gates en dashboard telemetry.
- Voeg auto-verify loop closure toe: deterministic checks, checker verdict, security checker enforcement en `ready_for_human_merge` status.
- Voeg worker pools, queue depth, capacity limits, throughput metrics en bottleneck reporting toe.
- Maak een Fleet Cockpit in het dashboard: topology, budgets, queue, workers, artifacts, gates en next safe actions.
- Verbind backlog -> goals -> loops -> prepared leases -> running workers -> checker -> ready-for-human-merge.
- Voeg een `/goals` batch plan toe zodat de hele verbetering als geordende goals kan worden geregistreerd, gedecomposeerd en daarna gecontroleerd uitgevoerd.

## Out Of Scope

- Geen automatische merge, push of deploy.
- Geen unattended high-risk policy/security/autonomy mutation.
- Geen automatische promotion van runtime lessons naar durable memory zonder review.
- Geen afhankelijkheid op Ruflo runtime; Ruflo blijft inspiratie, Djimitflo voert uit via Codex/OpenCode adapters.
- Geen claim van schaal zonder actuele resource-, queue- of runtime-evidence.

## Success Criteria

- A real Codex worker and a real OpenCode worker can be probed with current CLI contracts before execution.
- A small doc worker run stays under a configured low-risk token budget or escalates before burning excessive budget.
- Maker output can be checked by an independent checker worker through `/execute-checker`.
- Completion cannot bypass deterministic checks, checker verdict, high-risk security checker gates or human merge approval.
- Runtime evidence lands under ignored runtime data paths, not source directories.
- Dashboard shows runtime contract status, warning count, tokens per successful worker and tokens per diff line.
- Dashboard shows fleet topology, queue depth, capacity, running/prepared/blocked workers, throughput and bottleneck reasons.
- Workstation resource signals produce recommended concurrency per runtime.
- Backlog items can become goals, loop-runs and prepared leases in batches without uncontrolled worker spawn.
- OpenSpec validates strictly.
