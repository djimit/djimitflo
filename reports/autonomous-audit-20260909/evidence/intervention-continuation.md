# Operator intervention — executable continuation evidence

The existing UI invoked four configuration routes outside its common pending/error wrapper. The service returned a nonexistent injected claim ID, claimed validation without an independent gate, erased pause metadata, resumed unrelated crash recovery, and overwrote measured verification gates. The initial real SQLite/service/HTTP suite failed all16assertions (`intervention-chain-red.log`); five new UI assertions failed (`intervention-ui-red.log`).

## Corrected existing boundaries

- Pause is explicitly **quiescent admission pause**, not CLI checkpoint/drain. Prepared/running leases and nonterminal/recovery-held tasks cause409 without changing state. All eligible runs retain metadata and prior status. Goal/run pause state and canonical audit commit atomically. Resume releases only the owned operator pause, preserves terminal runs and never dispatches or fabricates requeued work.
- Start, continue/retry/split, worker/reviewer execution, verification, generic recovery and nested spawning honor the server-owned pause. Ordinary goal CRUD cannot erase pause ownership. Generic task dispatch and canonical worker-task identity receive independent engine tests; see the routing report for final evidence.
- Inject returns the ID actually stored by the existing claim service, with authenticated operator and audit provenance. The claim is proposed, not independently validated. Audit failure prevents both storage and knowledge-bus publication.
- `/override` now records **advisory operator intent** separately in run metadata and canonical audit. It never changes measured gate statuses or starts/stops workers. The UI says this explicitly; cancelling any prompt submits nothing.
- Configuration-role controls reuse existing pending/error/refresh behavior. User-visible notices identify the persisted claim and exact operation semantics. Selected paused goals cannot start new loops; paused runs cannot dispatch/verify. Browser starts select the newly created run, with stale review responses ignored.

## Actual local browser chain

Disposable repository `/private/tmp/djimitflo-intervention-tRVXLY`, baseline4526234, no remote. Goal `e94af657-12e4-479d-b796-6fe3eb6d453e`; run `50617d01-1ffb-4c10-a0e0-d53ce0b45d31`.

Browser created the goal and discovered an actual README TODO, paused admission, injected proposal `6a39c274-529b-49c2-abc8-466098e4e8d3`, and recorded gate advice. `intervention-read-proof.mjs` independently reads SQLite and asserts the returned claim identity, proposed/unverified status, real authenticated audit actor, unchanged original gates/risk/contract, and zero tasks/leases. Captured results: `intervention-paused-db.json`, `intervention-paused-after-restart.json` and `intervention-resumed-db.json`. Actual server restart preserved pause; browser Resume restored planning/goal-running and returned requeued0; reload confirmed admission enabled with no alert. Browser create/start/pause/inject/advice/reload/resume logs preserve the interactions. This is not provider execution or a completed implementation loop.

## Test scope

`npm test --workspace=@djimitflo/server -- operator-intervention-chain.test.ts g22-23-24-services.test.ts operator-intervention-g58.test.ts`:35passed (`intervention-chain-green.log`).

`npm test --workspace=@djimitflo/dashboard -- GoalsLoopsPage.test.tsx`:19passed at the scoped checkpoint (`intervention-ui-green.log`), then20passed including new-run selection in the final full dashboard97test suite (`continuation-tests-final.log`). Component tests establish wiring, cancellation and error handling; browser plus SQLite establish the scoped operation effects.

The initial cancellation red used an overly broad button-name selector and also matched a run card. That instrumentation failure is retained, not presented as causal proof. After correcting the selector, a deliberate one-line mutation reintroduced the default-proceed behavior in audit source only: the targeted test failed because cancellation incorrectly continued to a third prompt (`intervention-cancel-mutation-red.log`). The mutation was immediately restored with apply_patch; the full20test component suite passes (`intervention-ui-final.log`). The running server bundle was never changed by this mutation probe.

Existing G58 request-queue helpers are not upgraded to an operational human-review queue by these changes. Active-worker graceful drain/checkpoint and automatic requeue remain unavailable; the API rejects them instead of claiming success. No external provider, promotion, merge or deployment occurred.
