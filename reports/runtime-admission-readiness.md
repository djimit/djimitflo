# Runtime admission readiness: before the 2026-12-31 legacy expiry

UX-16 part 1. Measured 2026-10-05 against prod (read-only) and origin/main.

## Why this matters

`packages/server/src/execution/runtime-admission.ts` records every registered executor as `LEGACY_ADMITTED` with
`expires_at: 2026-12-31T00:00:00Z` (`LEGACY_EXPIRY`, line 122). `checkAdmission()` runs before every dispatch. After that
date every legacy runtime is denied, unless it is re-assessed or `RUNTIME_ADMISSION_MODE=shadow` is set again. The stall
watch (`services/stall-watch.ts`, detector 6) warns 30 days ahead, on 2026-12-01.

The legacy migration list says what a re-assessment needs. These are the gates every runtime still has to pass:
- **G1:** licence evidence.
- **G2/G8:** pin and checksum.
- **G5:** network egress of child processes scoped.
- **G7:** structured events or diff-only evidence per run.
- **G10:** gym outcomes compared with the incumbent.

G5 is `NOT_PROVEN` for **every** runtime. Today only in-process fetch is guarded (`OUTBOUND_DENY_HOSTS`), not the CLI child
processes.

## Per runtime

"Leases" are `worker_leases` rows in the last 30 days (prod). "Probe" is the latest `runtime_contract_probes` row. "Observed"
is `<cli> --version` inside the prod container.

| Runtime | Admitted version | Observed | Probe | Leases 30 d (done / failed / cancelled) | Last completed | Evidence in the ledger | Recommendation |
|---|---|---|---|---|---|---|---|
| opencode | 1.18.10 | 1.18.10 ✓ | ok (05-10) | 292 (166 / 92 / 33) | 2026-10-05 | licence, pin, interface, lifecycle, evidence, gym PASS; supply chain NOT_PROVEN (no provenance attestation); containment NOT_PROVEN | **Re-assess before 2026-12-31.** Incumbent maker; only G5 egress plus supply-chain attestation remain |
| atomic | 0.6.5 | 0.6.5 ✓ | ok (01-10) | 16 (0 / 15 / 1), VPS gym/maker leases | none | licence, pin + sha256, supply chain, gym (475 gym outcomes / 83 % in 30 d on the workstation) PASS; interface NOT_PROVEN (plain text) | **Re-assess.** Interface gate: accept "diff is the evidence" as the G7 answer (it is how Djimitflo already scores it) |
| remote | unpinned | n/a (the host runs atomic) | none | 71 (21 / 37 / 13) | 2026-10-05 | gym PASS (remote:workstation); containment = the patch passes VPS gates | **Re-assess.** It is a transport, not a runtime: bind it to the host's atomic version, or record it as `version: transport` |
| codex | 0.146.0 | codex-cli 0.146.0 ✓ | ok (05-10) | 0 (0 in 90 d; last completed 2026-06-29) | 2026-06-29 | licence (Apache-2.0), pin PASS | **Retire as unused,** or keep and accept denial after expiry. No loop dispatches to it |
| claude | 2.1.282 | 2.1.282 ✓ | ok (04-10) | 0 | never | pin PASS | **Retire as unused,** unless the operator logs the CLI in (operator item O1) and wants it as a species |
| mock | unpinned | n/a | ok (06-29) | 3 (3 / 0 / 0) | 2026-09-08 | none needed (makes no real changes) | **Keep as test-only:** re-assess as `ADMIT` with `child_agents: NONE` and a "no real changes" note |
| hermes | unpinned | binary absent in the container | ok (09-09) | 5 (3 / 0 / 2) | 2026-09-08 | none | **Decide:** re-assess (pin + licence) only if Hermes is still wanted as an executor; otherwise retire. Its 5 leases are all from 08-09 |
| gemini | unpinned | binary absent | unavailable (06-29) | 0 | never | none | **Retire as unused** |
| editor (cline) | unpinned | binary absent | unavailable (06-29) | 0 | never | none | **Retire as unused** |
| pi | unpinned | binary absent (probe ok in June) | ok (06-29) | 0 | never | none | **Retire as unused,** unless sovereign mode (which forces `pi` for executors) is still planned |
| deep-agent | unpinned | n/a (registered only behind its flag) | none | 0 | never | own assurance hold (EVE-V) | **Leave on hold** with an explicit non-legacy `HOLD` record, so expiry changes nothing |
| openhuman | — | — | — | 0 | — | REJECT (2026-10-01 falsification) | No action (already rejected, never executes) |

"Retire" means: drop the `legacy(...)` record and the executor registration in one reviewed PR. Today a retired runtime
would fail at dispatch with `UNKNOWN_RUNTIME`, which is the same outcome as an expired admission, only explicit.

## Work for a re-assessment (opencode, atomic, remote)

1. **G5 egress:** run the CLI children with a network policy (the container already runs `--network host` for builds only).
   The minimum is an allowlist of the model endpoint and the git remote, with evidence of one blocked call per runtime.
   This is the gate that blocks all three.
2. **opencode supply chain:** no provenance attestation exists upstream. Record the npm integrity hash in the repo, as
   `atomic` does with sha256, and accept that as the G8 answer.
3. **atomic interface:** record "plain text plus diff-only evidence" as PASS for G7. Djimitflo already scores atomic by
   diff and checks only.
4. **remote:** bind the record to the workstation's atomic version, which the worker reports at claim time. Otherwise
   remote outcomes cannot be attributed to a version.
5. Write each re-assessment as a new, version-bound record with `expires_at` 12 months out and the triggers kept.

## Decisions for the operator

1. Re-assess opencode, atomic and remote before 2026-12-01 (the stall watch warns on that date). G5 egress scoping is the shared blocker.
2. Retire codex, gemini, editor and pi (0 leases in 90 days, no binary for three of them). Yes or no?
3. claude: retire, or log the CLI in (O1) and keep it as a candidate species?
4. hermes: still wanted as an executor? If not, retire.
5. mock: re-record as test-only `ADMIT`, so expiry does not break the demo and test path?
6. deep-agent: convert to an explicit `HOLD` record?
7. Fallback if the work slips: set `RUNTIME_ADMISSION_MODE=shadow` before 2026-12-31. Accept or reject that as the plan B.
