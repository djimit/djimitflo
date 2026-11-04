# Independent critical UX and implementation review

Date: 2026-10-26. Source pinned to `38be63d520bb5fef89be99458cf3b562098224c3`.
Role: independent checker within the operator-requested design committee.

## Evidence boundary

This is a source inspection, not a visual or authenticated production audit. No browser was controlled, production action invoked, new credentials accessed, or application source changed by this reviewer. Source statements below are verified against files at the pinned commit. Runtime manifestation, actual viewport geometry, screen-reader behavior and operator task times remain unverified. Suggested new tests are acceptance specifications, not passing results.

## Main judgment

The highest-value AgenticOS improvement is continuity of an investigation: selecting an agent, execution or candidate should retain its identity while the operator moves between execution, evidence, memory, configuration and cost. Several existing primitives already support this direction. Replacing the platform with an all-entity graph would add complexity before repairing fundamental state and context problems.

The existing system has meaningful accessibility foundations worth preserving: `Layout.tsx:103` provides a skip link, `Layout.tsx:197` provides a focusable main target, navigation exposes `aria-current` at line 218, CSS globally supports reduced motion (`styles/index.css:96–99`) and focus indication (`101–105`), and `TabbedPage.tsx:14–45` implements linked tab/panel IDs, roving tab order and arrow/Home/End handling. `UX25b.test.tsx` exercises these behaviors and muted-text contrast. None of this establishes full accessibility compliance.

## Findings and bounded specifications

### C1 — P1: Refresh does not refresh all Mission Control information

**Observed in source:** `SwarmMissionControlPage.tsx:85–96` fetches knowledge events, the learning curve and current mission executions in mount-only effects. The page refresh handler at `103–134` fetches four different sources: mission control, capabilities, claims and knowledge runtime. Its toolbar invokes that handler at `279`. A successful click can therefore update one part of the page while leaving the execution and learning panels on their initial snapshots. Mount-only `loadErrors` accumulate and have no success path that clears the failed section.

**Root cause:** fragmented fetching lifecycle; confirmed by call sites. Actual production staleness duration was not measured.

**Smallest intervention:** include the three existing read endpoints in the same refresh lifecycle, with section-named failure results and a monotonically increasing request sequence. Preserve the last good value on failure and explicitly mark it stale. Reuse the stale-response pattern in `hooks/useResource.ts:14–33`; do not invent a query framework. No new endpoint or mutation is needed.

**Dependencies/risk:** refresh also runs after existing mutations, so call count increases. Retain existing action authorization and do not invoke these mutations to test refresh in production. Test fixtures must return the extra three reads. Avoid serializing unrelated requests or clearing valid data when one source fails.

**Acceptance:** all seven relevant reads occur on initial load and manual refresh; a second execution record and learning cohort replace first-read values; a failed learning request displays its source name and preserves prior data; successful retry clears that source error; a delayed old response cannot overwrite a newer response. Measure read freshness and repeat refresh-to-current-value latency. Expected benefit: fewer false diagnoses caused by mixed snapshots; magnitude requires measurement.

### C2 — P1: Closed mobile navigation remains keyboard-focusable in source

**Observed:** `Layout.tsx:113` hides the mobile sidebar by transform only (`-translate-x-full`), while keeping its links mounted. Neither inertness nor an equivalent visibility mechanism removes them from keyboard traversal. The open button at `191` has no expanded state or controlled-region ID; no Escape handling or focus return is implemented in the component. Desktop navigation must remain available independently of mobile open state.

**Root cause:** visual-only drawer state, confirmed in source. Exact browser/screen-reader manifestation requires a real narrow viewport.

**Smallest intervention:** use the installed Radix dialog component or existing project dialog conventions for a correctly labelled mobile drawer while preserving the desktop sidebar. Alternatively use breakpoint-aware hidden/inert state plus focus containment/restoration if that is demonstrably smaller. Do not add a dialog dependency or hide desktop links when mobile state is false. Close on route change as today (`73`).

**Acceptance:** at 375px, tab from the closed trigger never reaches offscreen navigation; open exposes expanded state, moves focus into the drawer and prevents background tab traversal; Escape closes and restores trigger focus; choosing a route closes the drawer without dropping focus into hidden content. At desktop width, all permitted navigation remains available. Resize across the breakpoint while open and closed. Existing `AppShell.test.tsx:20–49` covers approval badges, not this drawer flow; add a real-browser keyboard check because JSDOM does not model CSS tab visibility reliably.

**Risk/effort:** small-to-medium, depending on existing dialog composition. Highest regression risk is a desktop sidebar accidentally made inert or a duplicate nav landmark. Benefit: reliable keyboard operation, particularly on narrow/zoomed screens.

### C3 — P1 prerequisite for contextual UI: Tab selection discards unrelated URL state

**Observed:** `components/TabbedPage.tsx:16` calls `setParams({ [param]: id })`, replacing all search parameters. A route such as `?agent=agent-1&trace=trace-1&tab=logs` becomes only `?tab=trace` when switching. Existing tests validate `?tab=` and keyboard movement, not retention of independent context.

**Root cause:** replacing the query instead of cloning and changing one key; confirmed. Not every current consumer uses additional parameters, so current business impact varies. This is a concrete blocker to extending the component for an entity inspector.

**Smallest intervention:** use `setParams(previous => { const next = new URLSearchParams(previous); next.set(param,id); return next; })`, keeping existing browser-history semantics. Inspect every `TabbedPage` caller before editing, including aliased imports. Do not introduce a central routing abstraction.

**Acceptance:** given repeated unrelated query keys and an encoded value, mouse and keyboard switching change exactly the selected tab parameter; Back restores prior tab; selected entity and filters remain unchanged. Test in `UX25b.test.tsx` or adjacent existing tab tests with a location probe. Verify IDs remain unique if two instances coexist.

**Risk/effort:** small; callers may have relied accidentally on clearing filters. Explicit resets belong to those callers, not silent shared behavior. Benefit: preserves investigation context and shareable links.

### C4 — P2: Initial load is presented as an empty agent inventory

`AgentsPage.tsx:20–24` performs REST fallback when the store is empty but tracks no loading state. Its rendering at `40–42` immediately says “No agents configured” or “Agent not found” before the fetch settles. On failure, an alert is added but the same definitive absence message remains.

Use the existing loading/error/last-good-data pattern. Distinguish loading, failed retrieval, confirmed empty and missing requested ID. Acceptance: defer the API response and assert no definitive empty message; reject and assert unavailable plus retry; resolve an empty list and assert the empty message; resolve an unmatched ID and assert not found. Do not treat a transport error as proof that no agents exist.

### C5 — P2: Commons has incomplete tab semantics and graph interaction

`AgentCommonsPage.tsx:382–385` uses `role=tablist/tab` without the roving tabindex, tab/panel wiring or arrow/Home/End behavior already implemented by `TabbedPage`. Its capability input at `350–355` has a placeholder but no explicit associated label. The clickable SVG groups at `625` have no keyboard role or handler. However, the agent buttons at `358–374` provide an alternative selection path and the pair table at `349` provides a textual graph explanation; do not claim the whole feature is inaccessible solely from SVG groups.

Prefer an ordinary labelled segmented filter if changing thread kind is a filter rather than a distinct tab panel, or reuse the established tab interaction pattern if it is a tab. Label the search input. Keep the agent list as the primary accessible navigation and make graph interactivity equivalent only if the graph remains a primary control. Avoid introducing a second independent keyboard navigation system without need.

### C6 — P2: Missing status token can undermine intended visual semantics

`AgentCommonsPage.tsx:103,422,487,532,551,703` uses `status-success` utilities. `styles/index.css:5–31` defines active and completed status tokens but no `--color-status-success`. This means these named color utilities have no matching theme token in the inspected stylesheet. Actual compiled output and contrast were not inspected. Either use the existing semantic completed/success accent token consistently or add one intentional alias and verify emitted CSS. Do not rely on color alone: existing status text must remain.

## AgenticOS target: one contextual workspace, bounded graph

1. Keep an operator's selected entity in the URL and use real persisted IDs. Build on current routes rather than new top-level destinations for every entity type.
2. Put task outcome, current execution state, last observation time and next admissible action before registry volume or visual animation.
3. Provide three related views over the same selection: execution timeline, actors/authority, and evidence/learning. On mobile use stacked sections or existing accessible tabs instead of shrinking an unreadable graph.
4. Use an explicit edge vocabulary: assigned, spawned, invoked, retrieved, evaluated, superseded. Every edge should cite its source row/event. Missing edges remain unknown.
5. Keep Commons co-participation visually distinct from delegation and learning. `AgentCommonsPage.tsx:35–38` and `CONSTELLATION_LEGEND` already state the important limit: a shared thread is not proof of communication or learning. Preserve this correction. Reflection is already labelled “Reflection” at `13`; recommending that rename as a new fix would be stale advice.
6. A committee should surface disagreement, discriminator tests, versioned candidates and subsequent reuse outcomes. Message volume, graph density and agreement rate cannot establish capability improvement.
7. Human attention should show unresolved exceptions and risk-bound actions with evidence; routine agent handoffs need no new human click. Keep current maker/checker separation and operator merge/deploy boundaries.

## Evaluation plan

Compare the current page and proposed contextual view using the same prepared incidents, data versions and role. Include a failed execution, stale integration, rejected proposal and unproven memory candidate. Measure correct diagnosis, evidence completeness, backtracking/context losses, elapsed time and accidental mutation attempts. Do not run learning or energy comparisons on tiny UI convenience samples. Separately validate bounded collaboration on held-out task pairs with outcome correctness, tokens, latency and measured energy coverage; report uncertainty and no-effect cases.

## Checker disposition

Approve proceeding with a small context-preserving/refresh/accessibility change after focused regression tests. Do not approve claims of production visual quality, WCAG conformance, faster agent learning, lower watts or sustained evolution from this source review.

Baseline verification by this reviewer: `npm run test -w @djimitflo/dashboard -- src/UX25b.test.tsx src/components/AppShell.test.tsx src/pages/SwarmMissionControlPanels.test.tsx src/pages/AgentCommonsPage.test.ts` passed **31 tests across four files**. These existing tests do not exercise the new defect cases specified above. No application code was modified by this reviewer.

## Independent patch review, first round

The proposed patch replaces top-line missing execution and health values with `unknown`, preserves measured zero, refreshes seven source reads and adds a request-generation guard. Navigation changes preserve unrelated query parameters and target the canonical assurance inbox route from Commons. A focused run of `SwarmMissionControlRefresh.test.tsx`, `UX25b.test.tsx`, `AgentCommonsPage.test.ts` and `AppShell.test.tsx` passed **29 tests across four files** at this review point.

The first refresh implementation awaited all seven promises before updating any panel. This introduces a head-of-line latency regression: a slow optional knowledge-events or learning-curve read can hide already available core execution data. The independent checker requested per-source guarded updates while retaining a shared refresh generation and aggregate completion, plus a deferred-optional-read regression test. The request-generation guard appears structurally correct but requires an explicit overlapping-request regression test before a claim of race verification. The canonical review URL is valid against routing source; actual lazy-mounted anchor scrolling remains browser-unverified. This paragraph records an intermediate review, not final approval of an unreviewed later patch.

## Final scoped patch verdict

**SUPERSEDED: previous scoped PASS withdrawn pending the final loading-lifecycle correction; not a production release approval.** The revised refresh applies each source independently inside a generation-guarded `.then`; `Promise.allSettled` still aggregates errors and completion. This removes the introduced head-of-line data-display regression but does not yet fix the global loading dependency described below. A deferred learning read test proves that a measured core value appears without waiting for it. A StrictMode test resolves an older request after the newer one and proves that the old execution count does not replace the current count. The independent run passed **45 tests across six files**: `SwarmMissionControlRefresh.test.tsx`, `SwarmMissionControlPage.test.ts`, `SwarmMissionControlPanels.test.tsx`, `AppShell.test.tsx`, `AgentCommonsPage.test.ts`, and `UX25b.test.tsx`.

The patch deliberately repairs only the five top-line Mission Control metrics and its three health strips, seven-source refresh, tab query preservation and canonical Commons review link. Other pre-existing default-zero models, mobile drawer behavior, Commons tab/input accessibility and missing status theme token remain backlog. The global refresh spinner/error aggregation still waits for all reads to settle, although faster successful panels now update independently; this is not an atomic cross-source snapshot. The parent identified that the request helper has no timeout, so waiting on the optional reads can indefinitely lock Refresh and callers awaiting refresh. This is a blocking regression to correct by preserving completion of the four core sources while optional sources update and report failures independently. Independent browser, screen-reader, production runtime and measured operator-speed evidence were not obtained by this reviewer. No source code was modified by the checker.

## Final corrected verdict — supersedes intermediate verdicts

**PASS for the final inspected local read-interface repairs; no production release approval.** Each of the seven reads now applies successful data and source-specific error changes independently, guarded by the same request generation. Only the four existing core reads determine the refresh promise and loading lifecycle. Optional reads have explicit rejection handlers; a pending optional read neither hides core failures nor leaves Refresh disabled after the core reads finish. This removes the loading regression identified in the prior review. Existing indefinite waits on a core read are not repaired by this bounded patch.

The independent final run passed **46 tests across six files**, using the same six-file command above. This includes never-resolving optional evidence with core data visible and Refresh enabled, core error visibility while optional evidence remains unresolved, obsolete-request suppression, seven-source retry and recovered-error removal. Query preservation and canonical Commons URL tests also passed. Other default-zero models, mobile navigation accessibility, Commons input/tab semantics and status styling remain documented backlog. Independent browser/screen-reader behavior, production runtime and operator performance were not verified by this reviewer. No checker source edits or production changes were performed.
