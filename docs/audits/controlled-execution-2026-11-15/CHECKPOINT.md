# Controlled execution checkpoint — 2026-11-15

## Baseline and work context

- Repository: `djimit/djimitflo`; baseline `origin/main` `7758d153e415177de8e977721011c9675482934c`.
- Worktree: `/private/tmp/djimitflo-functional-improvements-20261114`; branch `codex/functional-improvements-20261114`.
- Frozen candidate reference: `ecfc85d22e1a68307d63eaed9ce4bbcb87927e89`; current product/test code head: `d099810991945a64b3ec6bbad76ef2070082609e`.
- Frozen denominator commit: `571a0ad39f5d6ed6eb587302242949fb513152cc`; scope is C1–C8, S1–S16, H1–H10. Lists were committed before tests.
- Draft PR #1272 hosted workflow `43779085303` passed all jobs at head `ff16c2a5c403c6216c771a49158a2a78add423c3`; independent `djimitflo-review` remained pending. PR remains open/draft. No merge/deploy is authorized.
- Primary user checkout contains unrelated changes and was not edited.

## Preflight outcome: GREEN (E2 ceiling reached)

- Node `v22.23.2`, npm `10.9.8`.
- `npm ci`: PASS, 779 packages; 0 reported vulnerabilities, one deprecated stub package warning.
- Shared and agent-catalog builds: PASS at `35e260dd5dce1e6dd11d365f5a3a61d1d850432e`.
- Focused tests: PASS, 2 files / 27 tests at `3bff1c0d14f224040df9d3c1daf357d80e5032dc`.
- Baseline reproduction: same two suites on baseline with only regression tests, test DB helper and additive migration overlaid: FAIL as expected, 10 failed / 17 passed. Candidate service code was not overlaid. Sanitized evidence is in `evidence/baseline-spawn-red.txt`.
- This is E2 test evidence. No server, real runtime, production, browser or live integration was run. E3–E5 claims remain blocked or unverified.

## Completed steps and commits

- `571a0ad39f5d6ed6eb587302242949fb513152cc`: freeze denominator before tests.
- `14b1472345840160e0a733fc2b6f9fbf8e7fe060`: record preflight install evidence.
- `35e260dd5dce1e6dd11d365f5a3a61d1d850432e`: record shared/catalog build evidence.
- `3bff1c0d14f224040df9d3c1daf357d80e5032dc`: record focused test evidence.
- `44838961a1bb8096996ebf39664b3e2da2d3565c`: complete initial evidence package; pushed to draft PR #1272.
- `b11b716c6b014d502d5edd6c7280d17667e2c837`: record provenance evidence limits.
- `df07cd90b1021e1550544087f5d38b8300367b7b`: pin ACE-001 interim test clock before the registered readout; tests only.
- `e3e5e4bb12e533e9743c2429ffa59d2814054b00`: record baseline reproduction and test-only ACE-001 fix.
- `8c3476471a1223df42e494bdbe84064ab6d18b72`: previous pushed evidence/checkpoint update.
- `e7baf39fdca9c7602cbf3644e7ffb11cc448c473`: nested-spawn reservation/idempotency/reconciliation and terminal projection candidate; red/green E2 only.
- `d099810991945a64b3ec6bbad76ef2070082609e`: deterministic WEB-001 route test clock; test-only.
- Static generated inventory commands were also run; route assurance reports inventory gaps documented in `REPORT.md`.

## Frozen scenarios and current outcomes

- S1: INCONCLUSIVE — prepared HTTP spawn is not normally dispatched; full route not run.
- S2: PASS at E2 for durable prepared receipt/status; not evidence of dispatch.
- S3/S4/S5/S6/S7/S9/S10/S11/S12/S13/S14/S15/S16: NOT_TESTED in this bounded iteration.
- S8: PASS at E2 for reservation versus measured/unknown use on covered nested-spawn tests; runtime provider metering remains unknown.
- See `scenarios.json` and `verification.json` for exact scope and limitations.

## WEB-001 fixture correction

- Original route test failed at baseline and pre-fix candidate: 1 failed, 10 passed. Fixture rows were dated 2026-11-08, but the HTTP route used current time and the service selects a rolling seven-day window.
- Commit `d099810991945a64b3ec6bbad76ef2070082609e` freezes Date in that route test to fixture `NOW` and restores real timers in `afterEach`; no application code changed.
- Corrected route test passed 11/11 on the candidate and on the detached baseline with only the fixed test file overlaid.
- Full local `npm run test -- --reporter=verbose`: PASS. Server 874 files passed / 2 skipped, 8202 tests passed / 1 expected failure / 23 skipped. Dashboard 561, MCP 91, ransomware 40, shared 23, Telegram 30, skill packages 6 tests passed.
- `npm run type-check`, `npm run build`, 25 Python poller tests and `npm run audit:ci`: PASS. `npm run lint`: PASS with one pre-existing warning in `github-pr-review-llm.test.ts:120`.
- Hosted exact-head CI run `43779085303` passed at `ff16c2a5c403c6216c771a49158a2a78add423c3`: Node 22/24 tests and gates, security scan, SBOM, mutation-test and fleet-auth-infra. `djimitflo-review` is still pending. No runtime, browser or production execution was performed.

## Hypotheses

- H1 BEVESTIGD: normal spawn intake prepares but does not dispatch; see `verification.json` and route/service source references.
- H2 GEWIJZIGD: candidate branch separates reservation from measured/unknown use; baseline red and candidate E2 green. No hard mid-call enforcement proven.
- H3 GEWIJZIGD: candidate branch projects nested lease settlement in normal LoopService; only focused E2 tests, no real worker lifecycle.
- H4 BEVESTIGD (E1): CLI-internal tools are not mediated by ToolBroker; executor isolation varies and protected runtime-admission changes are outside mandate.
- H5 NIET VERIFIEERBAAR: no same-hash selection→delivery→runtime-load→effect chain proven.
- H6 NIET VERIFIEERBAAR: no independent held-out selection/evolution claim proven.
- H7 GEWIJZIGD: poller diagnostics/Agent Commons work is tracked separately in #1231; current live pollers not probed.
- H8 NIET VERIFIEERBAAR: builder marks synthetic/source metadata at E1; propagation to exports was not tested.
- H9 NIET VERIFIEERBAAR: live DjimitSec lifecycle not run; its checkout is dirty and untouched.
- H10 BEVESTIGD as an evidence gap (E1): no net value conclusion from activity counts; no value/cost cohort measured here.

## CI follow-up

- Exact-head workflow `43707335553` at `8c3476471a1223df42e494bdbe84064ab6d18b72` failed on the WEB-001 route fixture; details and original baseline reproduction are recorded under CI-002. The test-only issue is fixed in `d099810991945a64b3ec6bbad76ef2070082609e`. Fresh hosted workflow `43779085303` passed all jobs at `ff16c2a5c403c6216c771a49158a2a78add423c3`.
- The prior ACE-001 failure at head `b11b716c6b014d502d5edd6c7280d17667e2c837` was fixed by pinning only the two pre-readout test calls to `STOP_BY - 1ms`; the corrected focused ACE-001 plus nested-spawn set passed 53/53. Product/evaluation code and experiment protocol were unchanged.

## Budget, blockers and next action

- Session budget supplied: no numeric wall-clock/token budget; contractual cap is M0 plus one M1 vertical improvement. Cost telemetry unavailable, so cost is not measured (not zero).
- The allowed M1 work is complete: nested spawn reservation/idempotency/reconciliation candidate is tested red/green at E2. H1 dispatch remains a separate normal-route gap; do not add an unapproved dispatch authority/flag.
- No operator decision is needed for local evidence packaging. Real runtime, production, UI, protected-path, experiment/holdout, merge and deploy are explicitly not authorized.
- Remaining action: obtain the independent `djimitflo-review` result for PR #1272. Runtime, production and UI proof remain outside the mandate.
- Resume: `cd /private/tmp/djimitflo-functional-improvements-20261114 && git status --short --branch && python3 -m json.tool docs/audits/controlled-execution-2026-11-15/verification.json >/dev/null`
