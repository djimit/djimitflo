# Target UX and information architecture

Preserve useful operating flows, existing route bookmarks and authorization. Current grouping already distinguishes Operate/Improve/Knowledge/Fleet/Govern/Lab.37 navigation destinations plus contextual views impose recall cost, but a rename or page deletion is not justified without task-use evidence. Consolidate repeated information around operational entities; keep experimental/mocked/draft capabilities explicit.

| Existing entry point | Target job / contextual relationships | Change justified by evidence |
|---|---|---|
| Cockpit | What needs attention? → exact goal/run/integration/experiment and last update | Retain high-level summary, show measurement scope/freshness; no universal green roll-up |
| Goals & Loops + Tasks/Review | What happened and why? → originating proposal/panel, execution/review/events/config/model/artifacts/outcome | Typed deep links and saved selected entity,≤2transitions to recorded cause; correct terminal semantics |
| Fleet + Agents + runtime contracts | What exists, available and executed? → host/service/version/capability/skill/use evidence | Keep agent versus process/runtime distinct, crosswalk existing identities rather than merge counts |
| Knowledge | Which evidence/memory/skills are used and useful? → source/version/retrieval/execution/controlled effect | Add installed/admitted/used distinction using current registries; relabel observational fitness; fix overflowing table |
| Evolution | What changed, did it help, did it survive? → current experiment registry/ledger, protocol/arm/CI/decision, trial/settlement and source | Existing API fields are missing in UI. Expose them here, not a disconnected experiments dashboard |
| Usage + Observability | Where are failures/cost? → consumer/run/lease/tool/integration evidence and coverage | Add contextual bounded evidence drill-down and scope, not another log store |
| Configuration | Which values actually apply? → env/default/DB/run source and activation timing | Extend current task-area/default catalog at resolver, link from run/integration; no settings migration |
| Governance/Audit/Authority | Which policy/approval/evidence authorized it? | Preserve distinct authority records, compatible evaluation cohorts and canonical filters/export |
| Lab | What is experimental, draft or advisory? | Retain unsupported execution/mock/disclaimer states; connect operationally useful evidence into main entities before collapsing navigation |

Common rendering contracts, reused only where there is repetition: entity link with typed ID/name; result authority (reported/independently checked); capability state ladder; metric with n/window/as-of/missingness; effective setting provenance; evidence/review excerpt with source and next/previous. Existing components/hooks take precedence over new wrappers. Loading is unknown, not zero; preserve shell and last-good value with explicit stale/error. Missing artifact edge is explicit, not inert “View Artifact.”

An operator can start at a failed goal, follow its originating proposal and specialist evidence, inspect actual selected config/model/skill version, read execution/tool/reviewer evidence, then see PR/experiment/verification and survival. Follow explicit recorded IDs only; missing relationships remain UNKNOWN. Integration detail links current health/history/config and impacted capabilities, while a skill links installation/admission and actual measured invocations.

Acceptance is task-based: reproduce the seven journeys in06 with unfamiliar operators, count actions/context switches/dead ends, time diagnosis and validate answer correctness. Paired task ordering should be counterbalanced; improvements must reduce friction without hiding uncertainty, weakening controls or losing existing task completion. Keyboard focus, accessible table scrolling,200%zoom and narrow desktop/mobile need direct verification before redesign acceptance. No speculative visual mockup is needed to implement the first links and truthful labels.
