# Memory and knowledge effectiveness

Storage, retrieval, use and causal improvement are four different measurements. Current memory holdout and ACE data allow a bounded analysis; historical quality/usefulness reports do not establish learning.

| Mechanism | Store / retrieval / controls | Evidence and uncertainty |
|---|---|---|
| Engineering rules | SQLite promoted candidates; assignment-context selects≤3, deduplicates/truncates300chars, sealed content hash, last14d or positive fitness; goal-hash holdout |27promoted rules; actual access/injection records. Raw verified−maker-failure fitness favors popular/exposed rules, not causal marginal value |
| Episodic/semantic candidates |238 candidate rows, type/status/sensitivity/review/promotion; memory_access_log964reads/21 candidates/226 callers | Historical promotion_status can differ from current status (30rejected engineering rows previously promoted); retrieval filters currentpromoted, so not automatic unsafe retrieval defect |
| Central SQLite memory |927central_memories; confidence/string matching;0relations/0proactive/0vector_memories in sampled tables | Different mechanism from central PostgreSQL/Qdrant; confidence is not independent validity |
| SEGML fleet bridge | category/Beta rank; retrieveRelevant ignores query and updates access metadata | Table0, no production retrieval caller found beyond tests in source search; dormant, not proven semantic search. Don't invoke its read-looking method during read-only audit |
| PostgreSQL central memory |157memories,1553 episodes,32 skills; types include semantic,procedural,working,decisions,architecture; canonical CLI queues projections | Most observed usage historical June–August;694pending projection events unprocessed in retained metadata. Owner/current lifecycle unresolved, not proven current global knowledge outage |
| Qdrant |24 collections incl shared_memory old1536dim33 points/new768dim793; large KB60618 and skills1195; other384/1dim stores | Metadata/auth verified; no points/content exported, no relevance/embedding compatibility test. Shared storage≠shared useful knowledge |
| KB/expert retrieval |1313 pages/4539 units/2265 claims; panel hits; ACEfactor assignment |90d2619 runs,112maker-attributable,2430unattributed. “Unused” means no qualifying attribution, not necessarily no retrieval elsewhere |
| Native Hermes/OpenClaw memory | mounted state/profile/files and central adapter records | Cross-agent availability/policy/version not fully mapped; no blanket claim of shared context |

## Memory holdout audit

Existing randomized rule withholding rate.3 is stable by goal hash. Since8October retained settled cohort rules55verified/18regressed versus holdout28/3, n73/31; rates75.3%/90.3%, difference−14.98pp. Independent Fisher recomputation p=.1101977373 agrees with existing reader.104 distinct qualifying goals/runs,0observedcrossover; all one lane. No observed retry duplicate explains this snapshot. Assigned138 includes infra, non-maker failure, fallback, no-change and unsettled exclusions. The report estimates a conditional settled eligible population, not all-assigned ITT.

Registered EXP3 includes attribution/stratification and one-sided harm rules; original sample267/115 for15pp was amended19October to30/arm and27October stop. Lower target increases uncertainty; not detecting benefit does not show equivalence. Current dashboard should display protocol amendment, exclusions and registered decision rather than infer “memory harmful” from the point estimate. Do not change active rule selection while this protocol remains live.

Knowledge “no value” for3 rules uses observed rate below baseline with≥5uses; intervals overlap the pooled baseline, task selection differs. Relabel as association, show sample/exposure/uncertainty and point to holdout.737of964 accesses are concentrated on three rules; popularity can reinforce the same raw fitness ranking. This is a candidate feedback bias, not independently demonstrated contamination.

## Retrieval quality and temporal validity

ACE103 outcomes, target50/cell, interim R−.168/S−.033;111delivery assignments reported factor adherence but relevance/faithfulness not independently measured. The system cannot infer useful retrieval from successful injection. Required offline evaluation: immutable query/task set, relevance labels, recall@k/precision/nDCG as applicable, source/version/time validity, contradiction/obsolete evidence rejection and independent downstream answer/task scores. Then paired retrieval-on/off with same model/tools/budget, including retrieval latency/token overhead. Report null labels/missingness honestly.

No poisoning/secret extraction, model inference or new controlled trial was run. Retention/deletion and every native memory store remain incompletely audited. Proposed comparisons in [18](18-controlled-experiments.md) reuse current experiment/admission infrastructure; no new memory database is justified.
