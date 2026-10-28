# Committee review: navigation and operational journeys

Reviewed 2026-10-26; source pinned to `38be63d520bb5fef89be99458cf3b562098224c3`.
Independent source review, not a live or visual audit. No production request, interaction, screenshot, deployment or mutation was performed by this reviewer. References below are source lines at that SHA. Runtime prevalence and task-completion times remain unverified.

## Verdict

The strongest AgenticOS improvement is to preserve the operator's selected mission, run and evidence across the existing screens. DjimitFlo already has a useful read-only mission detail, provenance projection, tab component, execution timeline and exception-oriented cockpit. A new galaxy dashboard or OS abstraction would duplicate these foundations. The immediate problem is that context and actionable evidence do not consistently survive navigation.

## Existing strengths to retain

- `Layout.tsx:14–65`: navigation intentionally follows September operator telemetry; five primary groups contain 20 destinations, with 17 experimental destinations under Lab. This is evidence against replacing the entire sidebar based only on architectural taste. Re-test actual journeys before promoting Lab features.
- `Layout.tsx:102–103,136,217–218`: skip link, labelled main navigation and current-page semantics already exist.
- `OperatorCockpitPage.tsx:258–269`: command strip, partial-data notice, stale snapshot warning and NeedsYou entry point already support exception-based operation. Build on them.
- `MissionDetailPage.tsx:11–42,62–143`: mission detail distinguishes planning from execution, types recorded participation/delegation/verification/agreement relationships, exposes missing reuse evidence, links runs, displays token coverage and makes absent outcome measures explicit. Do not create another mission-detail page.
- `AgentCommonsPage.tsx:35–38,703`: constellation edges explicitly mean co-participation, not communication or learning; reflections are labelled candidates requiring review. Retain that semantic restraint.
- `TabbedPage.tsx:6–9,17–45`: URL-backed tabs, browser history and keyboard roving focus exist and should be reused rather than recreated.

## Confirmed source-level findings

| Priority | Finding and evidence | Operational effect / confidence |
|---|---|---|
| P1 | Commons proposal handoff uses `/compliance#improvement-inbox-title` (`AgentCommonsPage.tsx:701`); `/compliance` redirects to a freshly constructed `/governance?tab=assurance` (`App.tsx:111`). The target no longer carries the hash. | The intended review section is not preserved by this redirect. Routing behavior follows source; actual browser scrolling still needs verification. |
| P1 | MissionControl summary uses `mission?.swarm_truth.* ?? 0` (`SwarmMissionControlPage.tsx:297–301`); health counters do likewise (`346–360`). | Before the main source returns, or if it fails, unknown counts render as zero. Source-confirmed rendering risk; no claim production source currently fails. |
| P1 | Swarm error notice lists names and says “check logs for details” with no destination (`SwarmOverviewPage.tsx:478–485`). Agents card only links current running task, not failed task history (`AgentsPage.tsx:182–186`). | Failure diagnosis reaches a source-level navigation dead end. Need a recorded execution/failed task association; do not infer the current task caused the error. |
| P1 | Timeline renders a cursor-styled “View Artifact” `div` when an `artifact_id` exists, but no link or handler (`ExecutionTimeline.tsx:122–128`). | Advertised evidence access is not implemented in this component. Do not fabricate an artifact download endpoint; first identify actual authorized retrieval contract. |
| P2 | Swarm agent cards are clickable `div`s with only `onClick` (`SwarmOverviewPage.tsx:332–335`). | No native link keyboard activation, open-in-new-tab or link semantics. Source-confirmed accessibility defect; use a React Router Link. |
| P2 | Agents list card heading is plain text (`AgentsPage.tsx:168`); governance section is displayed only when `agentId` exists (`53`). | The detail route exists (`App.tsx:105`) but cannot be reached from its own list card. Swarm Overview can reach it. Add an explicit agent-name detail link. |
| P2 | `TabbedPage.tsx:16` replaces all query parameters with just the selected tab. | Future/current entity filters carried in other URL parameters are discarded when changing tab. Preserve unrelated parameters; define explicitly whether hash stays meaningful across tabs. |
| P2 | Commons selected thread/view/focus live in local state (`AgentCommonsPage.tsx:141,249–250`). | A selected investigation cannot be reproduced by sharing a URL; evidence references and runtime run IDs are rendered as text (`705`). Establish a supported permalink before adding more visualization. |
| P2 | Swarm Overview initial agents/tasks and discussions/notes errors are console-only (`SwarmOverviewPage.tsx:123–154`); respective state starts as empty arrays (`116–119`). | Empty sections may mask failed reads even though other page sources use LoadErrorNotice. Missing/empty/error must be distinguishable per source. |

## Source-reconstructed journeys (not timed usability tests)

1. **Investigate a mission:** expand Lab → Mission Control → mission title → run. At least four selections from collapsed Lab to run; MissionControl already links to `/swarm-mission-control/missions/:id` and mission detail links `?run=`. Goal, relationship and provenance evidence remain largely textual. Measure browser success before changing sidebar placement.
2. **Investigate a failed agent:** Lab → Swarm → error notice. Notice provides no contextual action; choosing a matching agent elsewhere reaches a detail card whose current-task link does not enumerate failed executions. Result: recorded-history join is the missing step, not another global logs screen.
3. **Review a Commons proposal:** Knowledge → Agent Commons → relevant thread → Open review-inbox. Existing link targets a redirect and loses the requested section. Repair context at source.
4. **Inspect a tool artifact:** task detail → execution event → View Artifact. The final control is inert in ExecutionTimeline. A successful task page or nonempty artifact ID does not prove evidence can be retrieved.

## Three implementation specifications

### 1. Preserve contextual handoffs (P1; small)

**Scope:** `AgentCommonsPage.tsx` proposal link, `TabbedPage.tsx` query updates and their existing test files. Inspect git history before edits. Do not touch review authority or promotion logic.

**Intervention:** target the existing Assurance tab directly, preserving the review-inbox anchor; use a copied URLSearchParams and update only the tab parameter. Keep browser back behavior. No new routes, services or dependencies.

**Alternative:** repair the legacy redirect generically to preserve hash. This helps old external links but has broader routing scope; still fix the current caller to its canonical route.

**Acceptance:** proposed Commons message links to canonical existing inbox; keyboard tab switching preserves an unrelated context parameter; browser back restores previous tab; direct old bookmark behavior is specified. Verify that the target inbox actually has the expected anchor and that async mounting does not defeat scrolling.

**Benefit / risk:** fewer lost-context handoffs; tab query behavior change may affect callers depending on reset, so grep every caller and test them. Do not claim a measured time saving before paired journey tests.

### 2. Make every summary honest during partial failure (P1; small to medium)

**Scope:** `SwarmMissionControlPage.tsx` summary and health strips, `SwarmOverviewPage.tsx` per-source load errors, existing `LoadErrorNotice` and house format helpers. Existing useful cockpit stale/unknown patterns are the model.

**Intervention:** missing mission counters render unknown; actual numeric zero stays zero. Source failure is distinct from valid empty. Retain last successful data with stale status when available and expose refresh. Avoid converting unknown execution rows to healthy empty arrays without status.

**Alternative:** hide summaries until data arrives; less code but loses diagnostic visibility after failure.

**Acceptance:** first load has no fabricated zeros; simulated main-source rejection displays unknown and an accessible error; valid empty response renders 0; partial auxiliary failure leaves main read usable; refresh recovery clears only that source's error.

**Benefit / risk:** prevent false “nothing running / no issue” interpretations. Risk is accidental loss of known-zero semantics or hiding partial data. Tests should exercise missing, valid empty, stale and recovery separately.

### 3. Complete the failure-to-evidence journey (P1/P2; medium)

**Scope:** existing `AgentsPage.tsx`, `SwarmOverviewPage.tsx`, task detail and `ExecutionTimeline.tsx`; inspect authorized task/artifact contracts before wiring. Extend MissionDetailPage for mission context rather than making a second entity screen.

**Intervention:** semantic agent-name links; failure notice links to matching agent detail; show recorded recent failed task/run associations with source and time. Artifact rows become a real authorized link/action when retrieval exists, otherwise explicitly “artifact reference recorded; retrieval unavailable”. Maintain selected entity in URL and back navigation. Read-only diagnostics must never release an agent, rerun a proof or promote memory.

**Alternative:** send users to a globally filtered observability page. Use only if a working entity filter already exists; a generic logs destination is insufficient.

**Acceptance:** keyboard-only navigation reaches agent detail; a known failed task opens its own recorded execution, not an unrelated current task; unauthorized evidence remains denied; missing association reads unknown; artifact affordance either retrieves actual evidence or clearly declares its limitation. Measure unaided journey completion and time against the old route; target at least 90% completion and fewer context resets, with no claims until observed.

**Benefit / risk:** operator diagnosis becomes a linked investigation. Principal risk is wrong attribution or unauthorized artifact exposure, so join explicit identifiers only and keep existing server authorization.

## Target navigation principle

Keep the current primary groups while measuring their use. Present mission status, blockers, responsible role, next safe action and proof above implementation inventory on MissionControl. Place capacity planning, proof creation, knowledge synchronization and other mutations under clear existing action sections, with read-only status first. Keep agents, specialist committees, nested agents and swarms as distinct roles/relationships grounded in recorded assignments—not as separate mandatory navigation silos.

Use the existing mission → run → evidence structure as the AgenticOS work surface. A future graph is a selectable projection of recorded typed edges with a table alternative; it is never proof of collaboration value. Measure verified outcome quality, latency, token coverage and energy coverage alongside delegation overhead before expanding swarm participation.

## Limits

No live browser, keyboard execution, responsive capture, contrast measurement, backend invocation or production data validation was performed by this reviewer. Step counts are source-reconstructed selections, not observed operator measurements. Recommendations are grounded in source at the pinned SHA and require browser verification and normal project tests before release.

## Bounded corrections verified locally

Following coordinator authorization, implementation specification 1 was partially implemented in the existing components: TabbedPage preserves unrelated repeated query parameters, and the Commons proposal link targets the canonical Assurance tab plus inbox anchor. This is a functional correction, not a visual redesign or a change to authorization/review gates.

- Read `git log -p --follow` for all four touched files and grepped both production TabbedPage callers (GovernanceHubPage, AuditHubPage).
- Before the source fix, the updated/new tests produced exactly two failures: lost `run=r1` after selecting a tab, and the old Commons proposal target; 18 tests passed.
- After the source fix: `npm run test -w @djimitflo/dashboard -- src/components/AppShell.test.tsx src/pages/AgentCommonsPage.test.ts src/UX25b.test.tsx src/pages/AuditPage.test.tsx src/pages/CompliancePage.test.tsx src/pages/GovernanceScorecardPage.test.tsx` → **6 files, 31 tests passed**.
- The new tab test exercises click, Home key selection/focus, repeated `tag` filters, and two backward history transitions. Commons existing test preserves the candidate-not-promoted meaning and only exposes the link for proposed registered improvements.
- The inbox anchor exists in `components/ImprovementInbox.tsx:50` and CompliancePage mounts it, but actual browser anchor scrolling after lazy mounting remains unverified. Full suite/typecheck/lint/CI are coordinator responsibilities; no commit, merge or deployment was performed here.
