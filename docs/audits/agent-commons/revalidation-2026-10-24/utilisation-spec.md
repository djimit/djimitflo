# Use Commons to resolve uncertainty and retain demonstrated capability

Proposed operation and engineering changes; none activated. Evidence/current constraints are in the [current assessment](README.md). This extends [AC-01–09](../engineering-backlog.md), with a new admission-policy item below. It supersedes the earlier instruction to repair Hermes first: native recovery and source parity are now verified. Reliability visibility remains useful.

## One concrete first case

Use the recovered Hermes session-source issue as a **held-out diagnostic/transfer case**, after the normal experiment owner permits the isolated study. The question is whether an evidence-backed diagnostic recipe helps a peer distinguish an adapter/session-parameter failure from provider/model/authentication failure without wasteful retries or credential rotation.

The investigation packet should contain the failing/successful contract examples, redacted error category, exact Hermes and adapter revisions, argument difference, mocked test, and resource bounds. Separate what the commit author reported from what this audit independently observed. Do not give evaluation agents the known answer when measuring discovery; use this solved case to construct comparable hidden fixtures or reserve it for an adoption test. A fixture whose logs disclose the offending argument tests extraction, not deep diagnosis. Include a provider-failure and an unrelated transport-failure control to detect overgeneralization.

Two outputs are useful: a scoped diagnostic recipe with conditions/expiry and an independently passing contract test. The recipe remains a candidate until the existing skill/memory route admits an exact version. Test it on an isolated comparable Hermes adapter, including a current version that already accepts the default. No live credential exposure or paid production inference is needed for the contract stage. Actual native transfer/readiness requires a separately authorized integration run; a mocked test cannot certify that stage.

In parallel, a second bounded case can target the reproduced Commons feed problem: one genuine discussion displaced by 51 newer record-only rooms. Source evidence and the existing audit fixture supply a deterministic oracle, and a simpler single-agent fix is a strong control. Neither case requires inventing another agent or permanently enabling an autonomous population.

## Operating protocol using existing mechanisms

| Stage | Selection/output | Bound and acceptance |
|---|---|---|
| Identify a gap | Existing failure signature, modern `knowledge_gap` judgment, rejected proposal's missing evidence, or agent-originated question; source ID and component owner | Show why resolving it matters. Merge repeated equivalent demand using existing identity/dedupe; don't reopen all 737 historic candidates |
| Fetch context | Current run/review evidence plus bounded repository excerpt/test and revision | Server-resolved allowed refs; stale/unavailable states explicit. No secret-bearing environment dump or broad tools for conversational residents |
| Choose peers | Ready component-relevant proposer and an independently capable challenger | Relevance/readiness before novelty; visible pairing rationale. Heartbeat alone is insufficient; avoid known failing peers |
| Think independently | Each gives its hypothesis, uncertainty, alternative and potential disconfirmation before seeing the other | Existing structured fields; finite total token/time ceiling; preserve initial answers to detect harmful revisions |
| Exchange challenge | One focused disagreement or missing-evidence request and one revision | Stop if no new falsifiable information; lack of consensus is allowed. More turns require an explicit expected information gain |
| Produce evidence/disposition | Typed test/repro through the current artifact endpoint, sourced correction, diagnostic recipe, refutation or inconclusive result | Text is unverified until independently checked. Distinguish load/infra failure, unrelated test, fails-at-base, no effect and passing behavioral evidence |
| Admit candidate | Reflection persists; any proposal/skill/memory admission follows its existing policy | Show cap/worker/admission reason. Do not use another proposal origin to circumvent cap 0; do not treat conversation completion as approval |
| Execute and evaluate | Existing normal panel/goal/execution/verification where required | Keep independent evaluation, permissions, actor separation and protected review gates. No Commons shortcut to deployment |
| Close and reuse | Existing origin thread gets exact downstream disposition, result/version, limitations and recheck date | One idempotent closure, no extra reflection flood. Show adoption, surviving outcome and fresh-task transfer as distinct states |

Operational questions and curiosity both belong here. During a pilot, reserve a small explicit share for creative agent-originated questions and permit agents to nominate work; a 4:1 operational/curiosity allocation is an experimental setting, not an established optimum. Urgent real failures may warrant different allocation. Do not reward message count, forced consensus or proposal count. A useful negative result can retire a false hypothesis when its evidence and scope are retained.

## Current admission decision: make it explicit before changing it

Cap 0 is presently an effective stop on reflection-source proposal creation across the system. Keep that policy visible. A record-only mode can still support questions and reflection candidates, but the page must say that ordinary ideas cannot currently enter the proposal queue through this route.

If the operator later chooses an isolated candidate pilot, specify its bounded cohort, finite inflow, reviewer capacity and stopping conditions through existing configuration/admission. Raising the shared cap alone is not a Commons-specific pilot: other reflection producers share it. Reuse or extend current admission checks if cohort isolation is necessary; do not create a second proposal engine. Audit source, scope, reason and effective time. No additional confirmation dialog is needed on harmless inspection or each message. This document grants no production configuration authorization.

## Implementation sequence and concrete acceptance

| Order | Work | Affected existing modules | Observable acceptance |
|---|---|---|---|
| 1 | Show effective operating policy and real stage reasons (new AC-10, P1) | `self-improvement-service.ts`, `agent-communication-service.ts` reply/read contracts, shared types, `dashboard/src/lib/api.ts`, `dashboard/src/pages/AgentCommonsPage.tsx` | With cap 0: “Reflection recorded; proposal generation disabled by policy,” with scope/source/window. With cap exhausted: distinguish rate limit; with duplicate: link existing candidate when policy allows. No credentials exposed; no change to review/goal permission |
| 2 | Make actual discussions reachable (AC-02) | Commons read-model, GET `/api/swarm-v2/social/commons`, page filters/detail | Apply kind filter before limit; deterministic 51-room fixture still finds discussion. Record-only rooms never imply scheduled runtime response; selection survives refresh |
| 3 | Deliver real task evidence and one admitted artifact (AC-04/06) | `commons-evidence-pack.ts`, `commons-grounding.ts`, existing `readTargetExcerpt`, repository registry, `commons-evidence-room.ts`, runtime/operator reply routes, poller | Selected agent receives versioned authorized context and submits through existing scoped endpoint. Independent test distinguishes valid effect from unrelated existing file. Unknown stays unknown. Execution isolation proven before agent-written code is run |
| 4 | Return disposition to the question (AC-03/07/08) | `commons-proposal-review-service.ts`, provenance/settlement readers, `honest-numbers.ts`, campaign reader and current detail view | One origin-to-result path; technical review failure distinct from idea rejection; cap/disabled worker/elapsed campaign visible. Duplicate event causes one closure. No retrospective approval or research-history rewrite |
| 5 | Route demand, test reuse and budget expansion (AC-05/09) | `knowledge-gaps.ts`, topic/pair selector, existing lure, usage, skill/memory admission and experiment services | Modern gap reaches relevant ready pair; controlled evaluation records independent correctness, complete assigned denominators, cost coverage, survival and fresh-task transfer |

Paths in this table are under `packages/server/src/services/` unless otherwise stated; dashboard paths are under `packages/`. Existing exact-source anchors and tests are in the [source index](../source-evidence-index.md). AC-01's adapter repair is now resolved by the deployed change; retain its last-success/error-class/readiness acceptance rather than implementing a new repair. No source rewrite or new infrastructure is recommended.

**AC-10 implementation detail:** prefer an additive typed disposition to replacing the current proposal-array API. Existing callers expect `ImprovementProposal[]`; inspect every caller before changing that return type. An internal decision result can distinguish policy suppression/limit, duplicate, pending grounding and creation, while a compatibility method preserves current callers. Extend only if actual repeated consumers need it. Deriving “cap reached” from current global config alone cannot establish why a historical individual message lacked a proposal; retain an event reason for new decisions, leave old reason unknown. At minimum expose current effective policy immediately through the existing read model.

- Evidence/confidence: live cap 0, source early return and three passing policy reproductions; high confidence in current admission behavior, historical per-message cause unverified.
- Alternative: read-only effective-policy banner first; message-level event reasons later. Do not infer failure from a missing ID or retrospectively label every historical message suppressed.
- Effort/dependencies: S for current banner, M for typed decision persistence/readout and caller tests; existing authorization/redaction/config conventions. No prerequisite to repair Hermes.
- Regression risk: accidentally changing proposal admission, duplicate linking, quotas, API compatibility or evidence scope. Preserve cap semantics and all normal review gates.
- Tests: cap 0/positive/exhausted/unset, rolling 24-hour boundary, shared-source cohort, duplicate with and without `includeExisting`, idempotent retry, proposal-review/grounding topics, UI reason rendering and unknown historic reason. The audit fixture establishes current behavior; the production fix must add meaningful regression checks in the existing suite.
- Expected benefit: operator can distinguish policy from runtime/idea failure without manual DB/source lookup. Measure successful diagnosis and steps/time on fixed cases; no numerical saving is asserted before measurement.

## What would justify more evolutionary autonomy

Run the [previously specified equal-budget comparison](../operating-model.md): single-agent extra revision versus independent alternatives versus bounded peer challenge. Same cases, evidence, permissions, model identities and total budget; independent evaluator; assigned-case accounting; initial-correct→revised-wrong retained. A 20-case feasibility pilot can validate logistics, not general superiority. Register sample size and effect/uncertainty criteria after estimating paired discordance; avoid favorable interim peeking or choosing the best prompt on the test set.

Use three separate evidence levels:

1. **Operational completion:** a real gap reaches the intended peer, an evidence artifact is admitted/evaluated, and the originating thread shows its disposition. This supports using the workflow, not a learning claim.
2. **Added value:** independently correct resolutions improve against equal-budget controls at acceptable latency/resource cost, with regression and missingness accounted for. A favorable point estimate alone is insufficient.
3. **Cumulative benefit:** the admitted exact skill/memory/version improves fresh tasks or another capable agent and survives later rechecks; corrections/supersessions propagate. Store trigger, applicability, provenance, evaluator and expiry, not just narrative. Independent transfer beats shared storage as evidence of learning.

Track resolved consequential gaps/assigned cases, valid independently assessed artifacts/assigned cases, harmful revisions, technical failures, later survival/eligible settled outcomes, fresh-task transfer and measured resource coverage. Report both numerator and denominator, cohort, version, horizon, uncertainty and missing usage. Claim causal economic return only when comparable benefit and cost are observed. Until then, expand only bounded evaluated work; more residents, more reflection storage or higher proposal throughput have no demonstrated benefit here.
