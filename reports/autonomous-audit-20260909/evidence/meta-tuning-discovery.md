# Independent discovery: Self-Driving tuning chain

Status: two reproduced defects; product source unchanged by this investigation. Local in-memory SQLite only, with explicitly synthetic observations. No provider, production, merge or deployment action.

## 1. Real cognitive episodes never reach tuning (P1)

UI `SelfDrivingDashboard.tsx:66` posts `/meta/tuning/run`, which invokes `MetaOrchestrationService.runAutoTuning()`. It identifies goal types from the actual episode table, then calls `getLoopTuning()`.

`meta-orchestration-service.ts:176–213` reads `recorded_at`, `status`, and `cost_dollars`. The actual `CognitiveLoopClosureService` creates and writes `completed_at`, `outcome`, and `metrics_json`. The SQL error is caught as though there were no history. Consequently real accumulated evidence always produces the low-confidence fallback, never an active recommendation under the normal confidence threshold.

Actual executable fixture: actual service-created schema, twenty distinct successful recorded episodes. Result: `evaluated:1, applied:0`, default concurrency 2 and confidence 0.3. Existing `loop-services.test.ts:204` creates a different synthetic schema with the erroneous column names, so its green application test cannot detect this production contract mismatch.

Minimum repair: use canonical recorded episode fields and distinct loop identities; parse recorded metrics; distinguish an absent optional subsystem from a corrupt schema. Preserve advisory/noncausal semantics and existing bounded parameter/explicit goal precedence. Add real-schema cross-service regression with fixed success/failure cohorts and replay control; replace incompatible fake-schema fixtures.

## 2. An active tuned token limit is skipped at the worker result gate (P1)

`LoopService.getTokenBudget():1277` resolves an active meta limit when there is no explicit goal limit. But `LoopService.evaluateTokenBudget():1293` delegates to `LoopBudgetService.evaluateTokenBudget():200`, which reads only the goal budget again. The effective resolved limit is lost.

Actual separate fixture: persisted active meta limit 1,000 tokens; `getTokenBudget` returns `{maxTokens:1000,source:'meta'}`. Evaluating a synthetic worker usage of 2,000 tokens returns a skipped gate, `exhausted:false`, and `{source:'none'}`. This path is consumed by the real worker executor at line 140; its gate contributes directly to failed/completed classification. No worker process was launched for the reproducer.

Minimum repair: pass the effective resolved budget into the existing budget evaluator (or resolve it once at the existing data-access seam), preserving the direct service's default behavior and explicit goal priority. Assert actual 999/1000/1001 usage, unknown usage, explicit goal override, and cumulative lease usage. No second budget store or gate weakening.

## Proof and ownership proposal

`meta-tuning-discovery-probe.log` contains the actual JSON output and bounded fixture labels. No causal quality improvement is established; these are two operational connection failures.

Proposed owned implementation files only after parent authorization: `meta-orchestration-service.ts`, `loop-budget-service.ts`, the one `LoopService.evaluateTokenBudget` delegation, and a new focused real-schema test file plus corrected existing tuning fixtures. Parent currently owns LoopService, so no source edits have been made.

Positive boundary: the current UI reports the returned applied count rather than unconditionally displaying success; active tuning already has durable storage and audit records, and explicit operator budgets take precedence. The fix can reuse these existing seams.
