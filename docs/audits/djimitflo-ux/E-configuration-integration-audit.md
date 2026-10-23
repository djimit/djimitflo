# E. Configuration and integration audit

## Configuration

Production exposes a read-only Runtime configuration page grouped by environment-variable prefix. It is broad and useful for existence checks, but not yet an operator configuration experience.

Confirmed problems:

- No consistently visible source (`environment`, DB, default, runtime override), effective-value precedence or activation mode.
- No distinction between startup-only, scheduler-next-tick, request-time and redeploy-required values.
- Duplicate/contradictory entries exist in the runtime environment file (for example repeated `PORT`, `DB_PATH`, model and leaderboard keys). The file also contains an old `DJIMITFLO_COMMIT_SHA` that does not match the running image/deploy ledger. The UI must use running artifact identity, not blindly present this file as effective provenance.
- Common operator intents—model routing, budgets, schedulers, retries/timeouts, repositories, knowledge and integrations—are hidden inside alphabetical prefixes.
- Secrets must remain masked. This audit never recorded values; only names and nonsecret settings were inspected.

Recommended smallest extension: keep the current endpoint and add metadata per key: source, effective/overridden, default, sensitive, mutable, takes-effect, owner area and validation. Add task filters and an Advanced/raw view; do not create a second config store.

## Integration status

| Integration | Evidence | State | Gap |
|---|---|---|---|
| Event bus | Cockpit HTTP 200, ~6 ms; event outbox tables/config present | CONNECTED, capability health UNKNOWN | Last publish/consume success and backlog absent from service row |
| Agent registry | HTTP 200, ~5 ms; registry tables/config | CONNECTED | Last sync and drift not shown in same context |
| Ollama/LiteLLM | Primary endpoint HTTP 200, ~8 ms; model calls and routing records | CONNECTED; workload health mixed | Probe does not prove inference/model availability |
| Ollama Cloud | HTTP 200, ~1.1 s; usage page has activity/error history | CONNECTED, DEGRADED evidence | Show last successful inference, error rate and retry state |
| NVIDIA API | HTTP 200, ~1.1 s; old timeout visible in Usage | CONNECTED, historical DEGRADED | Status row hides historical failure and capability probe |
| TypeSafe/jev | `reachable (404)` and Usage timeout history; semantic routing rejected by JC-001 | DEGRADED / capability rejected | 404 must not be styled as healthy; link judgment evidence |
| Qdrant read/write | HTTP 200, ~8 ms; knowledge/vector tables/config | CONNECTED | Collection/read/write canary and freshness absent |
| UAMS | HTTP 200, ~8 ms | CONNECTED, operational capability UNKNOWN | State purpose and last successful business operation |
| GitHub | 117 loop PRs, settlement states and Dependabot lane populated | CONNECTED | Webhook freshness, rate limits and last API failure should be summarized |
| Telegram | One allowlisted identity visible; polling/config evidence exists | CONFIGURED | Delivery success/failure and lease owner not colocated |
| Frontier Experts | Page/data exists; scheduler flag observed disabled | DISABLED scheduler | UI should say why disabled and last successful run |
| Agent Commons | UI/data exists; proposal-review flag observed disabled | PARTIALLY DISABLED | Separate social connectivity from review automation |
| Federation | Route module fails before capability UI | FAILED in browser | Cannot assess peers until asset delivery is repaired |

An HTTP response proves transport reachability only. Integration cards should implement the state ladder `CONFIGURED → CONNECTED → HEALTHY`, plus `DEGRADED`, `FAILED`, `DISABLED`, `UNKNOWN`, each with the evidence and timestamp that justified it.
