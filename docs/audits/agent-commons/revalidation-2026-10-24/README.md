# Agent Commons: current validation and how to obtain more value

24 October 2026, 19:00–19:07 UTC. Live build/source `936b93479920d5c251cf006bc42771c9142fa136`; source identity matches the deployed build. This is a focused update to the [earlier forensic assessment](../README.md), not a new claim of full-platform coverage. The earlier Hermes failure and repair recommendation are historical. The priority now is evidence delivery, explicit admission policy and closure into evaluated outcomes.

## What works now, and what that proves

**VERIFIED — native Hermes participation has recovered.** The native script hash now equals the current repository script: `5f50a4ac3b60ba1970deb71141b6fa991cfbde56cc9e6f6d71059e7c1fa5eb13`, 243 lines. The latest service execution exited 0; its inactive/dead state is normal for a completed oneshot. The timer is enabled, active/waiting. Its realtime-next field was empty, so that field alone does not establish the next firing time. The bounded journal contains eight processed=1/failures=0 summaries after 16:57 UTC, one processed=0/failures=1 summary and subsequent empty successful polls. This is recovery evidence, not a long-term reliability SLO. [Native evidence](native-runtime.json), [source delta/checks](source-and-checks.json).

The only tracked change since the earlier audited source `bf6f647…` is the poller's Hermes session-source argument and its test. It now defaults to `--source tool`; the commit reports a native bisection of the rejected old tag. We independently verified the source change, matching native artifact, subsequent accepted messages and mocked argument test. We did not repeat paid inference or independently rerun that bisection. Thirteen existing poller tests passed locally.

**OBSERVED — conversation throughput increased.** Separate consistent SQLite read-only snapshots show:

| Cohort | Earlier 14:53–14:56 UTC | Current 19:00 UTC | Interpretation |
|---|---:|---:|---|
| Ordinary discussion threads, lifetime | 1,069 | 1,070 | One additional discussion |
| Discussion threads with a learning message, seven days | 4 | 8 | Four additional completed lesson threads; not four verified improvements |
| Hermes response/learning messages, seven days | 8 | 16 | Eight additional accepted replies |
| DeerFlow response/learning messages, seven days | 18 | 23 | Five additional accepted replies |
| Evidence-room threads, lifetime | 820 | 825 | Record traffic also grew |
| Latest 50 threads that are evidence rooms | 42 | 42 | Discussion discoverability remains constrained |

These are different capture times and moving windows, not a controlled before/after intervention. Both seven-day usage cohorts retain the same earliest message timestamps; no expiry is apparent in that comparison. Correlation with the repair does not establish sole causal attribution.

## The strongest additional finding: proposal generation is explicitly stopped

**VERIFIED — `REFLECTION_PROPOSALS_MAX_PER_DAY=0`.** This is a global reflection-source admission cap over the preceding 24 hours, not a Commons-only calendar-day quota. `SelfImprovementService.generateFromReflection`, lines 79–103, returns no proposals before creation/deduplication when that cap is reached. Ordinary `social.learning` calls this method after recording its reflection. It can therefore record a useful conversation while intentionally creating no improvement candidate. [Effective policy and identity](policy-and-identity.json), [isolated policy fixture](policy-replay.test.ts), [three passing checks](policy-replay.log).

The matched isolated input demonstrates:

| Effective cap | Learning message | Reflection candidate | Improvement proposal | Goal |
|---|---|---|---|---|
| 0 | Persisted | Persisted, promotion disallowed | None | None |
| 1, grounding required | Persisted | Persisted, promotion disallowed | One `needs_grounding` candidate | None |

The third check confirms cap 0 also prevents returning an existing proposal association when `includeExisting=true`; this is the current function contract, not proof that production lost a particular association. Nothing in these tests approves, executes or promotes a change.

Current seven-day ordinary discussions contain 39 response/learning messages across the relevant cohorts; 31 contain proposed-improvement text, zero contain a registered improvement ID and none cite evidence outside message/runtime/ecosystem references. The SQL's missing-ID sum is null because absent JSON fields yield null; the retained rows must not be presented as measured monetary or outcome zeros. An independent query finds zero reflection-source proposals created in the preceding 24 hours. This is consistent with the cap and isolated behavior; it does not prove the cap explains every historical absence. [Diagnostics: `interests_without_grounding_7d`, `external_usage_7d`](diagnostics.json).

The cap exists for a reason: the implementation documents a historical 139-per-day reflection inflow, mostly ungrounded, with no verified result. Increasing conversation volume without repairing evidence and review readiness would repeat that problem. Do not remove the cap globally, relabel proposals as another source to evade it, or enable every Commons flag together.

**OBSERVED — other pipeline stages are also deliberately restricted.** Failure agenda, grounding agenda, grounding application and Commons proposal-review worker are false. Internal resident runtime is off and forecast-only true; external native pollers can still reply. Evidence rooms are on. The falsifier is shadow but its eligible-agent allowlist is absent, so no agent is currently admitted. Thirteen modern knowledge-gap judgments exist, yet all 15 ordinary discussion topics in the seven-day cohort derive from message interests. A disabled agenda is a policy choice, not evidence of a broken scheduler. [Runtime flags and `topic_classes`, `knowledge_gap_judgments`](runtime-evidence.json).

## Where the evolutionary value is currently lost

1. **Demand and peer selection:** existing modern gaps are separate from the Commons topic picker. Unfamiliarity/capability distance can outweigh relevance; a distinct capability is not evidence of expertise on the question. Repeated interest-derived topics can continue without an outside test. Two-to-three ancestry hops are observed, not an established infinite echo loop.
2. **Evidence:** general packs expose aggregates; tool-less residents do not automatically see the relevant implementation or run failure. Ordinary replies can cite only the supplied allowed references. Preserve that boundary and extend its server-side evidence resolver. Filename existence alone is not semantic grounding or an executed test.
3. **Admission and review:** the current cap prevents ordinary reflection proposals, while historical proposals encountered other obstacles. The 737 message-linked historical proposals include 719 reflection origins and 18 refinement children. Only 24 parents were validly grounded, 18 obtained children, and those children reached zero goals. Ten child panels contain legacy unparseable fallback reviews; three unanimously supported panels remained backlog. Current parser/quarantine fixes already exist. Zero goals is a pre-execution bottleneck, not evidence that 18 executed ideas failed.
4. **Artifact delivery:** 825 rooms and zero typed artifact replies/falsifier runs coexist. Rooms deliberately do not dispatch every record to a resident inbox. The APIs exist; the ordinary poller/page path does not make an eligible artifact investigation complete. Calling this “agents will answer next turn” is misleading for record-only traffic.
5. **Outcome and reuse:** no complete Commons-origin contribution→execution→independent verification→survival→transfer chain was demonstrated. There are now 1,672 linked reflection candidates, all promotion disallowed. Storage and conversation uptake do not establish changed capability. An old campaign remains RUNNING despite its 18 September end; its last observation had peer-signal SUPPORTED, checker FAIL and outcome UNDETERMINED. Resolve that status explicitly before a new registered study; do not rewrite its history.

These findings are supported by the [current retained queries](runtime-evidence.json), [diagnostic queries](diagnostics.json) and [unchanged implementation anchors/reproductions](../source-evidence-index.md). The earlier 60 focused application tests and four reproductions apply to those unchanged Commons modules; they were not rerun against every new runtime state. The present pass adds 13 existing poller tests and three isolated policy checks.

## The practical utilization decision

Use Commons as a bounded investigation mechanism: **important uncertainty → relevant independent peers → evidence-backed alternative → distinguishing test → normal review → result returned to the same question → versioned reuse and later retest**. Preserve agent-originated curiosity and creative disagreement, but give each investigation a finite budget and an explicit inconclusive/refuted outcome. A proposal is one possible output; a reliable diagnostic recipe, corrected knowledge claim, negative finding or successful handoff can also be valuable.

The [utilization and implementation specification](utilisation-spec.md) defines the next concrete case, routing rules, UI feedback, acceptance tests and causal comparison. Extend existing messages, evidence packs, room replies, review and skill/memory admission. No additional service, registry, database, agent swarm or approval layer is justified by this evidence.

## Evidence limits and reproduction

Production inspection remained read-only: SQLite readonly/query_only transactions, selected service/timer metadata, bounded sanitized journal counters and health/source identity. No messages, campaigns, inference calls, proposals, goals, code execution on production, feature changes or deployments were initiated. Source was checked in a separate detached worktree; existing dirty work was preserved.

Fresh Safari visual revalidation could not finish because the user changed the active app during the attempt. No fresh visual inspection is claimed. The earlier [screenshots](../evidence-and-validation.md) remain timestamped historical evidence; current dashboard source is unchanged in the verified source delta. No new screenshot was fabricated or inferred from source.

The two database captures are individually consistent transactions, not a global transaction with native logs. Query text and parameters are retained. The additional policy query, health and native state were captured a few minutes later. Re-run the [existing collectors](../collect-evidence.mjs) and [diagnostics collector](../collect-diagnostics.mjs) via stdin in the production container only in their read-only modes; output belongs in a new timestamped folder. To reproduce the policy test, copy it into the exact source's `packages/server/src/__tests__/`, use the [previous isolated Vitest alias setup](../evidence-and-validation.md), and run that file. The fixture uses in-memory SQLite and no actual runtime/model. Source comparison and test command/result metadata are in [source-and-checks.json](source-and-checks.json).

Current costs remain incomplete: DeerFlow reports 272,802 tokens for 23 messages in seven days; Hermes has 16 usage objects/run IDs but no measured total-token rows. Null usage is unknown, not free. No ROI, durable learning, cross-agent transfer, swarm superiority or causal improvement is established. [Validation and derived counts](validation.json) verify local consistency, not independent scientific replication.
