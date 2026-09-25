## Architecture

### Positioning

Djimitflo wordt de agentic control-loop laag voor Codex/OpenCode. Ruflo blijft conceptuele inspiratie voor swarms, hooks en memory, maar de uitvoer gebeurt via Djimitflo adapters, bestaande policy services, OKF/Qdrant/GraphStore en geïsoleerde worktrees.

### Loop Stack

Een volwassen loop-run bestaat uit zes lagen:

1. Discovery-loop: vindt werk in repos, logs, docs, issues, CI en memory.
2. Planning-loop: vertaalt signalen naar taken met scope, constraints en acceptatiecriteria.
3. Execution-loop: laat maker agents werken in eigen worktrees/sandboxes.
4. Verification-loop: laat aparte checker agents en deterministic gates output controleren.
5. Memory-loop: schrijft beslissingen, failures, lessons en next steps naar OKF/Markdown/Qdrant/GraphStore.
6. Governance-loop: bepaalt autonomy level, approval, budget, escalation en stop.

Deze loops mogen gestapeld worden, maar execution blijft standaard closed-loop. Open loops zijn toegestaan voor discovery/research en moeten token/budget/time limits hebben.

### Loop Contract

Iedere loop moet minimaal dit contract hebben:

```yaml
loop:
  name: doc-drift-and-small-fix-loop
  mode: closed
  goal: measurable business or engineering outcome
  trigger: manual | scheduled | event | condition
  context_sources: [repos, docs, issues, logs, memory]
  actions_allowed: [read_only, propose, patch, pr]
  verification: [tests, lint, typecheck, reviewer_agent, policy_as_code, human_gate]
  state: [markdown, okf, qdrant, graphstore, audit_db]
  escalation:
    human_required_when: [...]
  stop_conditions: [...]
```

### /goals Lifecycle

`/goals` is de intention layer:

- create: registreer goal met constraints, risk, budget en acceptatiecriteria.
- decompose: maak plan slices en loop candidates.
- assign: kies fleet size, agent roles en worktree strategy.
- monitor: toon progress, blockers, evidence en next action.
- close: sluit goal alleen wanneer gates en stopcondities gehaald zijn.

### /loop Lifecycle

`/loop` is de execution-control layer:

- start: start een loop-run voor een goal of task.
- step: laat planner of maker de volgende actie voorstellen.
- run: voer toegestane acties uit.
- verify: run deterministic gates en checker agents.
- update-state: schrijf loop state en memory.
- decide-next: stop, retry, split, escalate of continue.

Een agent mag de volgende stap voorstellen. Djimitflo beslist via policy, gates en loop contract of die stap wordt uitgevoerd.

### Fleet Model

Agents zijn workers met leases:

- `planner`: decompositie en dependency ordening.
- `maker`: implementatie/research/doc patch.
- `checker`: maker-output review.
- `security_checker`: security/privacy/auth impact.
- `memory_curator`: state, decisions, risks, lessons.
- `governance_guard`: policy, budgets, escalation.

Fleet scaling werkt via bounded pools:

- max concurrent workers per loop.
- max worktrees per repo.
- max retries per task.
- max token/cost/time budget.
- backpressure wanneer gates falen.

### Maker / Checker

De maker mag zijn eigen werk niet definitief goedkeuren. Checker verdicts zijn verplicht, maar niet voldoende voor high-risk changes. Deterministic gates blijven doorslaggevend.

### Self-Learning

Loops mogen automatisch operational memory voorstellen, bijvoorbeeld "test X faalde door fixture Y". Engineering rules vereisen review. Policy/security rules vereisen human approval en audit.

### First Loop

De eerste loop is `doc-drift-and-small-fix-loop`:

- closed mode,
- low risk,
- detecteert docs drift, kleine lint/test failures en stale instructions,
- maakt patch of PR voorstel,
- nooit merge/deploy zonder approval.

Dit test fleet orchestration, maker/checker, state, gates en budget zonder productie-impact.

## Risks

- Unattended failure: een slechte loop produceert slechte output op schaal.
- Comprehension debt: agent-generated diffs kunnen sneller groeien dan begrip.
- Cost runaway: parallel workers en retries kunnen budget verbranden.
- Policy drift: self-learning kan governance langzaam verschuiven.
- False verification: LLM-checkers kunnen overtuigend maar fout zijn.

## Mitigations

- Closed loops als default; open loops alleen voor bounded discovery/research.
- Hard gates: tests, lint, typecheck, secret scan, security scan, diff threshold.
- Worktree isolation per maker task.
- Human approval voor auth, secrets, infra, policy, high-risk security en deploy.
- Audit trail voor iedere loop decision.
- Memory writes met trust levels: proposed, validated, approved.

## Rollback

Disable `agentic_control_loops_enabled`, stop active leases, preserve loop state and evidence, and leave existing task/executor behavior unchanged.
