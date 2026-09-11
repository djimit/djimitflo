# G68–G71 local integration checkpoint

Existing services repaired without new dependencies, migrations or control planes (Ponytail). No production deployment, merge, push or paid provider execution. Mission remains incomplete.

## Executed chain

`lifecycle-http-proof.mjs` uses the disposable localhost3187 server and file-backed audit SQLite. API-created agent `3daccc84-a269-484b-9f09-4ff24bbcc52a` stays pending despite an active heartbeat, is later retired with an actual archive and canonical audit, and rejects reactivation. The final browser shows offline plus its retirement timestamp/reason. Separate still-pending fixture `1444dcde-c9c1-4fe5-854d-65b6f0daeb98` proves the pending card remains renderable on the final build.

Task `ab1015d2-0f63-45d2-ac53-b607e3452588`: actual REST creation → pending summary with no start → execution approval HOLD → browser pending/configured-not-executed → changed description → old decision cannot start changed task → new approval → same requester rejected409 → distinct disposable approver credential → MockExecutor completes → current summary and review render completed. Two approvals have different execution-input hashes; 15 persisted execution events, 11 canonical audit rows including retirement, zero real file changes. The mock's1500 tokens/tool messages are synthetic, not provider consumption or filesystem work. The third approver token was minted for an existing synthetic local identity; this is software identity separation, not independent human review.

After rebuilding and restarting the owned local server, `lifecycle-http-proof.mjs verify` checks HTTP state against read-only SQLite, both input-bound approved rows, unchanged materialized-summary identity, unchanged archive identity and canonical terminal audit. `lifecycle-browser-proof.mjs` joins the captured browser/HTTP evidence with executable assertions. Final proof: `lifecycle-browser-proof.json`.

Post-capacity policy/governance/status/hold changes are separately proven by actual-engine SQLite/semaphore adversarial tests in `queue-admission-revalidation.md`, not by this earlier mock execution. That execution predates the final queue revalidation patch; rereading it does not retroactively prove that patch ran.

## Evidence and harness failures

- Successful held render: `browser-lifecycle-review-held-snapshot.log` and visually inspected `output/playwright/lifecycle-review-held.png` in the audit worktree.
- Successful final captures: `browser-lifecycle-agent-pending-final.log`, `browser-lifecycle-agent-final.log`, `browser-lifecycle-review-final.log`; final screenshots are visually inspected.
- Successful database joins: `lifecycle-http-setup.json`, `lifecycle-http-before-restart.json`, `lifecycle-http-after-restart.json`.
- Early browser text extractions failed because the CLI sandbox lacks the Node `URL` global; those logs are retained and are not proof. A first pending snapshot captured loading only. The final extractions use `page.url()` and awaited DOM state. A retirement wait incorrectly expected a literal retired badge; actual UI correctly renders offline and a separate retirement line.
- First API harness incorrectly expected202 for an approval HOLD (actual200), leaving one extra disposable pending task/agent. A later harness used nonexistent PATCH `/agents/:id` (404 HTML); the actual `/agents/:id/status` is verified409. An attempted same-requester decision was correctly rejected409. These interrupted probes are not counted as completed runs; `lifecycle-http-complete.json` is intentionally not authoritative.
- Browser console has documented Playwright `data:,` CSP refusals and the unauthenticated initial refresh401. Restart briefly disconnects WebSocket. No zero-error blanket claim.
- The existing completion hook wrote one synthetic task concept under local `/Users/dlandman/djimitflo-knowledge/okf/tasks/ab1015d2-0f63-45d2-ac53-b607e3452588.md`. Existing background UAMS sync attempted its default LAN endpoint and received ECONNREFUSED; Qdrant/Ollama were refused. No external success is evidenced. The final server also explicitly sets UAMS_URL to refused localhost. These secondary integrations are not certified by task completion.

## Gates and scope

Full build/typecheck/lint pass; root tests pass2656 with20skipped, recorded in `lifecycle-*-final.log`. Source-aligned scoped mutation in `approval-range-mutation-final.log` kills71/71, not whole-repository coverage. The earlier64-mutation run used a shifted line range and is not equivalent coverage. Four standalone assurance files execute11passing checks; route inventory runs separately. `assurance-lifecycle.json` remains BLOCKED on real OpenMythos corpus/evaluation prerequisites and dirty/dependency-refused local identity; contract and read-only integration probes pass their stated properties. OpenMythos cache/provenance fixes do not supply missing certification evidence.

Additional G70 review corrected historical/manual approval aggregation and a browser-discovered synthetic audit timeline issue; see `evidence-summary-review.md`. Final rebuilt-browser review has13derived trail entries instead of15, and the HTTP/SQLite proof asserts exactly two grant entries at the corresponding canonical decision timestamps. The 11canonical audit rows also include the separate retirement record; these different scopes are not contradictory counts. Required capability matrices remain scoped and do not claim every screen/control or provider verified.
