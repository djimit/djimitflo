# Operator Cockpit 3.0 — UX architecture

Implemented in #738 (command view) + #742 (server states, totals) + #749 (detector/scheduler health in 'What is blocked?', pending). Status: I T D; P = rendered against prod data only via the server snapshot (no browser screenshot taken).


## Information hierarchy (progressive disclosure)
- **Level 1, the Command strip** (always visible, four cards in the operator's order):
  1. *Is the system healthy?* Shows the worst of: the server `health`, every guardrail state, section errors (→ UNKNOWN), silent stalls (→ DEGRADED) and snapshot age over 10 min (→ STALE). Up to five reasons are listed. It never shows green when there are no guardrails or when any input is UNKNOWN.
  2. *Is improvement occurring?* verified vs regressed over 7 d, labelled **"throughput, not intelligence"**, with a link to /evolution for the validated-improvement scorecard.
  3. *What is blocked?* Stalls (each linking to #stalls), benched gym species and stale species.
  4. *What needs you?* The total of the blocking needs-you counts, linking to /decisions. A null count makes the total a lower bound ("≥ N (k unknown)"). A missing block reads "unknown".
- **Level 1b, banners:** a partial-failure banner (role=alert) listing `errors[]`; a stale-data line; Needs-you detail with deep links; the daily digest.
- **Level 2, diagnosis** (`<details open>`): guardrails with explicit state text (healthy / degraded / breached / unknown / stale), services, silent stalls, gym species, remote workers, efficiency.
- **Level 3–4, evidence and raw detail** (`<details>` collapsed): deploys, scorecard, strategy genomes, runtime usage, judgments.

## States
`HEALTHY | DEGRADED | BREACHED | UNKNOWN | STALE | NOT_APPLICABLE`. The server's `state` wins when present. On an older server the state is derived: `value === null` → UNKNOWN, even though the old server reported `ok: true` for null values; otherwise ok → HEALTHY and not ok → BREACHED. NOT_APPLICABLE never raises the overall state.

## Data integrity in the UI
- Stale-response guard: each load takes a sequence number, and only the newest response may set data, errors or services. Refresh stays clickable (aria-busy) because overlapping loads are now harmless.
- A null count renders as "unknown", never as 0. A count the server omits (older server) counts as 0.

## Accessibility
- One h1. Each card and section has an h2 with a stable id, so anchor links work.
- The health card is role=status with aria-live=polite. The partial-failure banner is role=alert.
- State is always conveyed in text, with StatusPill providing text plus an icon; colour is never the only signal.
- `<details>`/`<summary>` are native, so keyboard (Enter/Space) and screen-reader disclosure work without extra code, and the summary has a visible focus ring.

## Responsive
- Command strip: 1 column on phones, 2 on small screens, 4 on large. Guardrail grid: 1/2/4 columns. The existing DataTables keep their own overflow handling.

## Not done (follow-ups)
- Decisions / Evolution / Fleet / Evidence / Assurance as separate views: these already exist as pages (/decisions, /evolution, /fleet, /governance). The strip links to them instead of duplicating them.
- No "highest expected value" ranking on the strip yet. That is Phase 3 and needs server-side prioritisation.

## Mapping to the directive's six views
| View | Where | Status |
|---|---|---|
| Command | Command strip on / (cockpit) | I T D |
| Decisions | /decisions (approvals, requeue with classes, D5 labels, memory, CAR audit, draft PRs) | existing + #742 classes |
| Evolution | /evolution (evidence endpoint, gates A–D, intelligence section) | existing, linked |
| Fleet | /fleet, /fleet-hosts, /agents | existing, linked |
| Evidence | /evolution + /knowledge | existing |
| Assurance | /governance | existing |

Not proven: real-user task timing ("answers within seconds") — no usability test was run.
