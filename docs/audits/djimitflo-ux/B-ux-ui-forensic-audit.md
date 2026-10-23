# B. UX/UI forensic audit

## What works

- The production navigation is materially better than the legacy source structure: 22 task-oriented entries in five named groups, with 17 experimental destinations collapsed under Lab.
- The cockpit answers four useful first questions: health, improvement, blockers and operator attention. It explicitly says verified throughput is not improvement.
- Empty states are usually explicit (`No pending approvals`, `No interactions`, `No memory candidates`) rather than blank.
- Skip-to-content, `aria-current`, labeled mobile navigation and the global error boundary are present.
- Decisions consolidates approvals, requeues, labels, PR settlement and calibration instead of scattering each queue across a new page.

## Confirmed friction

| Finding | Evidence | Impact | Priority |
|---|---|---|---|
| Decisions is an unbounded mixed-responsibility page | 117 PRs, 17 Dependabot PRs, 50+ requeue rows, pre-screen labels, attribution audit, discovery labels, retrieval labels and Telegram allowlist on one route | High scrolling cost; unrelated administrative configuration is mixed with daily decisions | P1 |
| Configuration is a raw prefix dump | Dozens of headings from ACE through JWT and beyond, with no task grouping visible above the fold | Requires recall of environment-variable names; no “why/effect/restart/source” workflow | P1 |
| A stale chunk can make a route unrecoverable | `/federation` showed `Importing a module script failed`; Retry returned to the same error | Experimental capability becomes unavailable and global navigation disappears | P1 |
| Lazy-route exploration can show only `Loading...` for a material interval | Observed on Goals & Loops, Knowledge, Evolution and several Lab routes | No skeleton, timeout or progress detail; operators cannot distinguish slow from broken | P2 |
| System status vocabulary is inconsistent | Cockpit services say `up`, TypeSafe says `reachable (404)`, usage reports old `failed`/`timeout`, integration requirements call for configured/connected/healthy | `up` can be mistaken for capability health | P1 |
| Controls do not consistently disclose mutation scope | Policies show `Enabled`; Decisions rows expose Dismiss/Requeue and label switches; Fleet exposes commands | Operators must infer whether click is local, audited, reversible or immediate | P1 |
| Data-heavy tables lack visible pagination/search in several critical views | Decisions and MCP permissions render very large collections | Slow scanning, high cognitive load and poor keyboard efficiency | P2 |
| Navigation and content language mix English and Dutch | Authority filter displayed `Alle beslissingen` while surrounding UI is English | Small but recurring recognition cost | P3 |
| Experimental failures are visible but weakly summarized | Consensus list shows many `failed` items without grouped cause or recovery path | Activity becomes noise rather than diagnosis | P2 |

## Operator journeys

| Journey | Current path | Steps / context switches | Result |
|---|---|---:|---|
| Find why a goal failed | Goals & Loops → run/task detail → Observability/Audit → possibly Decisions | 4–6 / 3+ | PARTIAL: IDs are not a unified breadcrumb |
| Identify degraded integration | Cockpit Services → Usage → Configuration | 3 / 2 | PARTIAL: transport health, last activity and effective config are separate |
| Investigate rejected proposal | Improvement Funnel → Decisions pre-screen/requeue → goal/run if known | 3–5 / 2 | PARTIAL: origin evidence and rejection trace are not one chain |
| Find specialist evidence | Improvement Funnel calibration → panel records/source/API knowledge | 3+ / 2 | POOR: no obvious row-to-decision drill-down |
| Decide whether an experiment improved capability | Cockpit → Evolution | 2 / 1 | NOT POSSIBLE: UI explicitly reports capability gain and reproduction as not measured |
| Locate effective workflow config | Configuration raw list → infer prefix → source/deploy docs | 2–4 / 2 | POOR: value source and activation mode absent |
| Explain resource spike | Cockpit efficiency → Usage → run detail/logs | 3–5 / 2 | PARTIAL: consumer totals do not directly link to contributing runs |

## Accessibility and responsive assessment

Keyboard landmarks and labels are present, but the volume of focusable controls on Decisions makes sequential keyboard navigation impractical. Tables depend heavily on visual column association and need row-level accessible names for primary entities/actions. Mobile code has a drawer and backdrop, but no mobile viewport was available, so responsive behavior is NOT TESTABLE. Charts and color contrast were not instrument-measured; no compliance claim is made.

## Page-level direction

- Keep Cockpit as the top-level operational answer page; do not restore the legacy Dashboard to primary navigation.
- Split Decisions by task through tabs/anchored counts and virtualized or paginated queues, not new top-level pages.
- Convert raw Configuration into a filtered effective-value catalog while retaining an advanced raw view.
- Add contextual links at the row/entity level before creating another observability dashboard.
- Make Lab failure isolation preserve the shell/navigation so one lazy chunk cannot strand the user.
