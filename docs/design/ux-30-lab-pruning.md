# UX-30 — Lab pruning from real usage (31-10-2026)

Operator ask (31-10): list the dormant Lab pages from usage telemetry and recommend one action per page.
**Nothing is deleted here.** Retiring a page or route is the operator's decision (UXD-3). This document is the evidence
for that decision. It contains no code changes.

**Prod:** `djimitflo-live`, `/health` commit `0d1676cc` (= origin/main), built 2026-10-31T15:57Z, `commit_matches_build: true`.
**Probe:** 2026-10-31T19:36Z, read-only (`readonly` + `query_only`), self-written script, no app code (script below).
**Windows:** 14 d = `day >= 2026-10-17`, 30 d = `day >= 2026-10-01` (UTC days; today is partial). Telemetry starts
2026-09-28. `usage_loss` is empty, but the 10-11T04:16Z → 10-12T16:43Z gap (teardown A) lies inside the 30-d window,
so 30-d counts are a floor.

## Headline

1. **Every Lab page's last view (2026-10-26) is a full-nav crawl, not a visit.** On 7 days (10-02, 10-04, 10-08, 10-09,
   10-10, 10-23, 10-26), ≥ 16 of the 17 Lab pages were each opened about once. That is an audit or screenshot sweep.
   With those sweep views removed, the 17 Lab pages had **36 targeted views in 14 d** (50 in 30 d). 23 of the 36 are
   on 4 pages: Swarm Mission Control 7, Swarm 6, Fleet Cockpit 6 and Swarm Resources 4. The 20 top-level pages had
   **468** in the same 14 d.
2. **No Lab page has had a targeted view after 2026-10-26.** Pages viewed in 14 d other than by a crawl: 13 of 17.
   Pages with 0 targeted views in 30 d: Agent Catalog, Consensus debates and Predictive analytics. Goal reasoning has
   none in 14 d.
3. **No operator action came from a Lab page in 14 d.** The Lab POSTs in 30 d are:
   - `worker-pool/plan` ×14, a read-only POST fired on page load;
   - `agi/reason` ×2 (last 10-04), `intelligence/predict` ×3, `meta/tuning/run` ×3 (last 10-10);
   - `assurance/evals/run` ×5 (10-02) and `explainer/fleet/regenerate` ×1 (10-09).

   The memory-candidate promote (126) and reject (20) calls came from **Decisions**: they fall on days Swarm Resources
   was not opened.
4. **Several Lab pages read empty or stale stores**:
   - `federation_peers`: 0 rows.
   - The catalog DB: `profiles` 0 rows.
   - `discussions`: 0 rows. `swarm_learning`: 2 rows, last 07-06.
   - `council_sessions`: last 09-21. The explainer tables: last write 10-09.
   - `cognitive_strategies`: 2 rows, last 09-21. `proactive_memories`: 0 rows.
   - `/knowledge/events` is always `[]`, because the db is not wired at `routes/index.ts:151`.
5. **No Lab route has machine traffic.** Every hit on a Lab-only route falls on a day its page was viewed. The machine
   load is elsewhere: host-agent polling 581,532 hits / 30 d, social runtime and Agent Commons 35,556, gym worker 18,394.

## Method

| Step | What | Source |
|---|---|---|
| Nav | 20 top-level items plus 17 in the collapsed Lab section | `packages/dashboard/src/components/Layout.tsx:16-65` |
| Page → API | Static map. Page component (from `App.tsx`) → transitive local imports (Layout, `lib/api`, `lib/store` and tests excluded) → `api.method()` resolved to its `request()` path in `lib/api.ts`, plus literal `api.get/post(...)` paths | `page-api-map.mjs` (below) |
| Page views | `usage_counts kind='page'`, posted by `Layout.tsx:88-91` on every navigation (ids masked to `:id`). A page's count includes its sub-routes (`/frontier-experts/:id`) | S4, `services/usage-telemetry.ts` |
| API calls | `usage_counts kind='api'`: the matched Express pattern, method and status class. Page paths are matched segment by segment (params are wildcards) | same |
| Operator vs machine | Page views come from a logged-in browser, which is operator-side. They still cannot separate a human from a crawl, so **targeted views** remove one view per page on each **sweep day** (a day on which ≥ 16 of the 17 Lab pages were viewed). API hits have no caller column (teardown A, M7), so a route's hits are called **machine** when they fall on a day no nav page that calls the route was viewed | derived |
| Exclusive routes | Routes that only this nav page calls. Their hits are the traffic that retiring the page would remove. Shared routes (e.g. `/api/agents`, `/api/tasks`) stay with their other page | derived |
| Backing tables | Endpoint → handler → service, one hop. Table row count and newest `created_at`/`updated_at`/… from the same probe. The catalog has its own SQLite file (`services/agent-catalog-service.ts:11`), probed separately | code read + probe |
| Dead marks | #1094 (OPEN, head `b49d559e`) and the 30-10 teardown (`~/.djimit/re-20261030/A-capability-map.md`) | — |

**Limits.**
- The static map is a floor. Dynamic paths built outside `api.ts` are not resolved.
- `GET /api/approvals` is mostly the pending-approvals banner in `Layout`, which polls every 30 s on every page
  (`hooks/usePendingApprovals.ts:13`). It is credited to Decisions only because Decisions calls it too.
- "Targeted" is an estimate. A human who opens one Lab page on a sweep day is subtracted as well.

## Per-page numbers

Columns:
- **views:** raw page views, 14 d / 30 d.
- **targeted:** views minus sweep views, 14 d / 30 d.
- **last targeted:** the day of the last targeted view. The last raw view of every Lab page is the 10-26 sweep.
- **API:** hits on every route the page calls, 14 d / 30 d.
- **excl. API:** hits on routes only this page calls, 14 d / 30 d.

### Top-level (all KEEP)

| Page | views | targeted | last targeted | API | excl. API | Note |
|---|---|---|---|---|---|---|
| `/` Cockpit | 62 / 156 | 60 / 149 | 10-31 | 628 / 1777 | 628 / 1777 | `/api/health/*` |
| `/decisions` | 54 / 156 | 52 / 149 | 10-31 | 5809 / 13146 | 5774 / 13020 | banner poll, see Limits. 64 machine hits / 30 d. Memory-candidate promote and reject happen here |
| `/goals-loops` | 31 / 85 | 29 / 79 | 10-31 | 130 / 346 | 130 / 346 | calls `/api/intervention`, which has 0 hits in 30 d (zero-hit group, teardown A) |
| `/tasks` | 33 / 82 | 31 / 76 | 10-31 | 230 / 405 | 0 / 0 | all routes shared |
| `/repositories` | 28 / 70 | 26 / 64 | 10-31 | 28 / 70 | 2 / 4 | |
| `/improvement-funnel` | 32 / 73 | 30 / 66 | 10-31 | 64 / 148 | 64 / 148 | |
| `/evolution` | 37 / 67 | 35 / 62 | 10-29 | 246 / 383 | 246 / 383 | |
| `/observability` | 21 / 53 | 19 / 47 | 10-31 | 21 / 53 | 21 / 53 | |
| `/usage` | 27 / 48 | 25 / 42 | 10-31 | 50 / 71 | 50 / 71 | |
| `/knowledge` | 27 / 63 | 25 / 56 | 10-31 | 54 / 90 | 54 / 90 | |
| `/frontier-experts` | 42 / 109 | 40 / 103 | 10-29 | 91 / 267 | 91 / 267 | |
| `/agent-commons` | 24 / 97 | 22 / 90 | 10-29 | 2467 / 8710 | 2467 / 8710 | 2,900 hits each on `social/commons`, `lures` and `join-requests`: an open tab polling |
| `/fleet` | 18 / 32 | 16 / 26 | 10-29 | 173 / 206 | 173 / 206 | |
| `/agents` | 24 / 37 | 22 / 31 | 10-29 | 286 / 423 | 87 / 94 | 32 machine hits on `/api/agents` |
| `/policies` | 9 / 20 | 7 / 15 | 10-29 | 9 / 20 | 9 / 20 | |
| `/governance` | 8 / 25 | 6 / 19 | 10-26 | 29 / 107 | 17 / 55 | links to `/swarm-resources#panel-<id>` (`components/ImprovementInbox.tsx:99`) |
| `/mcp-permissions` | 8 / 27 | 6 / 22 | 10-26 | 18 / 56 | 18 / 56 | |
| `/audit` | 7 / 26 | 5 / 20 | 10-26 | 7 / 27 | 7 / 27 | |
| `/authority` | 7 / 28 | 5 / 22 | 10-26 | 148 / 321 | 148 / 321 | 62 machine hits on `/api/authority/stats` |
| `/configuration` | 9 / 20 | 7 / 14 | 10-26 | 9 / 20 | 9 / 20 | |

Govern is the quietest top-level section. Its pages had no view after 10-29 (Policies) or 10-26 (the other five).
Govern pages are control surfaces that are needed rarely, but they must stay reachable. They stay KEEP and are
**not** moved to Lab.

### Lab

| Page | views | targeted | last targeted | API | excl. API | Backing store (rows, newest) | #1094 / teardown 30-10 |
|---|---|---|---|---|---|---|---|
| `/dashboard` Activity overview | 4 / 8 | **2 / 2** | 10-21 | 393 / 659 | **0 / 0** | `agents` 32 (10-18), `tasks` 1,278 (10-30), spec files on disk. All shared with Agents, Tasks and Governance | — |
| `/swarm-resources` | 6 / 21 | 4 / 14 | 10-24 | 95 / 358 | 30 / 140 | `specialist_panels` 1,642 (10-30), `specialist_reviews` 2,875 (10-26), `memory_candidates` 254 (10-26), `work_items` 1,229 (10-30), `rsi_audit_log` 0 | panels: Ollama panels idle since 10-26 (A #25) |
| `/swarm` | 8 / 13 | 6 / 6 | 10-25 | 471 / 779 | 44 / 54 | exclusive: `discussions` **0 rows** (still 39 GETs), `swarm_learning` **2 rows, 07-06**, usage-window (cost ledger). The rest is shared | — |
| `/fleet-cockpit` | 8 / 13 | 6 / 6 | 10-25 | 47 / 91 | **0 / 0** | swarm status + runtime contracts (env + CLI probes). Worker-pool start/stop/drain: **0 calls in 30 d** | — |
| `/swarm-mission-control` | 9 / 14 | 7 / 7 | 10-26 | 74 / 124 | 35 / 55 | `swarm_missions` 240 (10-30), `swarm_runner_manifests` 3,431 (10-30), `swarm_capabilities` 514 (10-28), `swarm_claims` 400 (**09-13**). `/knowledge/events` always `[]` (no db, `routes/index.ts:151`) | — |
| `/explainers` | 3 / 8 | 1 / 1 | 10-23 | 15 / 46 | 15 / 46 | `explainer_bundles` 120 / `explainer_tasks` 81 (**10-09**), `explainer_jobs` 74 (09-23), `discovered_repositories` 30 (09-12), `human_review_queue` 3 (09-21) | — |
| `/pipeline-builder` | 3 / 8 | 1 / 1 | 10-23 | **0 / 0** | 0 / 0 | none: browser `localStorage` only, "execution is not supported". The only user of the `@xyflow/react` dependency | — |
| `/catalog` | 2 / 7 | **0 / 0** | none | 4 / 14 | 4 / 14 | separate DB `/data/agent-catalog.sqlite`: `profiles` / `evaluations` / `activations` / `overlaps` **all 0 rows**. activate/deactivate: 0 calls | — |
| `/interaction-board` | 3 / 8 | 1 / 1 | 10-23 | 20 / 45 | 6 / 16 | interaction ledger: `agent_messages` 7,944 (10-31) + 14 other tables | — |
| `/self-driving` | 3 / 9 | 1 / 2 | 10-23 | 18 / 57 | 12 / 39 | `meta_tuning_log` 1,129 (10-31), `compliance_reports` 39 (10-30), `proactive_memories` **0**, cognitive stats (shared) | meta tuner refused by the 0.95 floor since 10-30 (A #13) |
| `/cognitive` | 3 / 9 | 1 / 2 | 10-23 | 9 / 27 | 3 / 9 | `cognitive_strategies` **2 (09-21)**, `cognitive_meta_learning` 1, `cognitive_patterns` 3, `cognitive_episodes` 348 (10-30) | — |
| `/consensus-debates` | 2 / 7 | **0 / 0** | none | 2 / 7 | 2 / 7 | `council_sessions` 17, `council_outputs` 26, both **09-21** | — |
| `/agi-reasoning` | 2 / 8 | **0 / 1** | 10-02 | 0 / 2 | 0 / 2 | POST `/agi/reason` **writes** `goal_hypotheses` (3) and `strategy_nodes` (10), newest 09-27; only `agi-goal-reasoning-engine.ts` reads them | **`agi` is a zero-hit route group** (A §1) |
| `/predictive-analytics` | 2 / 7 | **0 / 0** | none | 1 / 3 | 1 / 3 | none stored: in-memory heuristic over `loop_runs` / `worker_leases` | — |
| `/self-healing` Health checks | 5 / 10 | 3 / 3 | 10-23 | 4 / 6 | 4 / 6 | `loop_runs`, `worker_leases` (computed) | self-healing scheduler is live but unverified (C, E N3) |
| `/economy` | 3 / 8 | 1 / 1 | 10-23 | 4 / 9 | 4 / 9 | derived from `swarm_capabilities` + leases; dollar figures null without a dated price | — |
| `/federation` | 4 / 10 | 2 / 3 | 10-23 | 8 / 20 | 8 / 20 | `federation_peers` **0 rows**; `/federation/register` 0 calls; capabilities = `swarm_capabilities` again | **#1094 deletes `services/federation/adapter.ts`** (0 importers). The route file stays |

#1094 touches no nav page directly. It deletes the orphan `ComplianceDashboard.tsx` (not in the nav), removes the
`/api/swarm` alias (no page calls it; `/swarm` the page calls `/api/swarms/*`) and deletes the federation adapter.

## Recommendations

Each recommendation lists its evidence and what would break. MOVE and MERGE-INTO keep the capability and change only
where it is shown. RETIRE-CANDIDATE means the operator may remove the nav item, the route and the page. In every case
the server routes are a separate decision: MCP tools, scripts and other pages may still call them.

| # | Page | Recommendation | Evidence | What breaks if done |
|---|---|---|---|---|
| 1 | `/pipeline-builder` | **RETIRE-CANDIDATE** | 1 targeted view / 30 d. No API. It cannot execute anything | drafts in the viewer's own `localStorage` are lost. `@xyflow/react` can be dropped (no other importer) |
| 2 | `/catalog` Agent Catalog | **RETIRE-CANDIDATE** | 0 targeted views / 30 d. Its store is empty (0 profiles). activate/deactivate unused | nothing visible. `/api/catalog/*` and the agent-catalog package are a separate decision |
| 3 | `/federation` | **RETIRE-CANDIDATE** | 0 peers, 0 registrations. #1094 already deletes its adapter as dead. Its capabilities list duplicates `swarm_capabilities` | nothing: no peer exists |
| 4 | `/consensus-debates` | **RETIRE-CANDIDATE** | 0 targeted views / 30 d. No council session since 09-21. 0 executes | the UI to start a council session. The council stays reachable via `djimitflo_council_ask` (MCP) and `scripts/council-shadow-smoke.mjs`, which call the API |
| 5 | `/agi-reasoning` | **RETIRE-CANDIDATE** | 0 targeted views / 14 d (1 / 30 d). 2 calls / 30 d, last 10-04. `agi` is a zero-hit group in teardown A. Each click writes hypothesis rows that nothing else reads | a button that writes `goal_hypotheses` / `strategy_nodes` |
| 6 | `/predictive-analytics` | **RETIRE-CANDIDATE** | 0 targeted views / 30 d. 3 calls / 30 d. Nothing is stored | nothing persisted |
| 7 | `/dashboard` Activity overview | **RETIRE-CANDIDATE** | 2 targeted views / 30 d (last 10-21). 0 exclusive routes: Agents, Tasks and Governance show the same data. Its title "Mission Control" clashes with Swarm Mission Control | the `/dashboard` URL; a redirect to `/` would keep bookmarks working |
| 8 | `/swarm` | **RETIRE-CANDIDATE** | 6 targeted views / 30 d (10-21..25). Exclusive data: `discussions` has 0 rows and `swarm_learning` was last written 07-06. The rest is Agents, Tasks and swarm status | the usage-window card (2 calls / 30 d). It is a cost view; if wanted, it belongs on `/usage` |
| 9 | `/cognitive` | **RETIRE-CANDIDATE** (fold the stats card into #10) | 2 targeted views / 30 d. Strategies: 2 rows, last 09-21. `cognitive/stats` is already on Self-Driving | per-goal-type strategy lookup over 2 rows. Mounting `/cognitive` still starts its background writer; retiring the page does not stop it |
| 10 | `/economy` | **RETIRE-CANDIDATE** | 1 targeted view / 30 d. Derived only. Dollar figures null | competence-per-capability view; a merge into `/usage` is the alternative if wanted |
| 11 | `/explainers` | **RETIRE-CANDIDATE** (UI) | 1 targeted view / 30 d. No explainer write since 10-09. The MCP `explainer_*` tools are the working path | review-queue resolve (3 items, 09-21) and the fleet sync/regenerate buttons (1 regenerate / 30 d) |
| 12 | `/self-driving` | **MERGE-INTO `/evolution`** | 2 targeted views / 30 d. Its live content is the meta tuner (`meta_tuning_log` written today, refused by the 0.95 floor since 10-30). That is evolution-loop state. Memory stats read an empty table | the tuning-run button (3 / 30 d, last 10-10) moves too |
| 13 | `/self-healing` Health checks | **MERGE-INTO `/observability`** | 3 targeted views / 30 d. A computed health check over loops and leases; the self-healing scheduler behind it is live | nothing, if the card moves |
| 14 | `/interaction-board` | **MERGE-INTO `/agent-commons`** | 1 targeted view / 30 d, but its ledger is live (7,944 messages, today). Agent Commons already links to it as "Full interaction ledger" (`AgentCommonsPage.tsx:407`) | the link target; becomes a tab or section |
| 15 | `/fleet-cockpit` | **MERGE-INTO `/fleet`** | 6 targeted views / 30 d. 0 exclusive routes. Worker-pool start/stop/drain unused for 30 d. Swarm Resources already points to Fleet Cockpit and Fleet hosts side by side (`SwarmResourcesPage.tsx:213`) | worker-pool controls, if not moved |
| 16 | `/swarm-resources` | **MERGE-INTO `/governance`** (specialist panels) and `/decisions` (memory candidates, already there) | 4 targeted views / 14 d. Live panel data (1,642 panels). Promote/reject is already done from Decisions. Governance links each panel here | **Governance "Review panel" links** (`ImprovementInbox.tsx:99`) and the RSI safety toggle and assurance eval run (5 / 30 d, 10-02). Move these before any removal |
| 17 | `/swarm-mission-control` | **KEEP** (Lab) | the most-used Lab page (7 targeted views / 30 d). Live `swarm_missions` and runner manifests. It owns the `proof-runs/:id` and `missions/:id` detail routes (linked from Interaction Board, MissionDetail and ProofRunDetail) | — . Two problems to note: `/knowledge/events` is unwired (`routes/index.ts:151`) and `swarm_claims` has had no write since 09-13. A later merge into Goals & Loops is the upgrade path |

**Top retire candidates** (with the fewest views and the emptiest backing):

| Page | targeted views | Backing store |
|---|---|---|
| Agent Catalog | 0 in 30 d | catalog DB 0 rows |
| Federation | 3 in 30 d | 0 peers |
| Consensus debates | 0 in 30 d | last session 09-21 |
| Predictive analytics | 0 in 30 d | nothing stored |
| Goal reasoning | 1 in 30 d | 2 calls, zero-hit group |
| Pipeline drafts | 1 in 30 d | no API at all |

If all 11 RETIRE-CANDIDATEs and 5 MERGE-INTOs are done, Lab shrinks from 17 items to 1 (Swarm Mission Control).

## Decision pending

The operator decides per row (UXD-3). Suggested order, cheapest first:
1. Remove rows 1–6 (no data, no unique route, no links in).
2. Do rows 7–11 with a redirect.
3. Do the merges 12–16. Row 16 needs its Governance links moved first.

A retirement PR should show this table's numbers again from a fresh probe. It should also add a redirect for every
removed URL.

## Probe scripts (read-only)

Run pattern: `scp` the script to `vps-agentical:/tmp/`, `docker cp` it into `djimitflo-live`, then
`docker exec -e NODE_PATH=/app/node_modules djimitflo-live node /tmp/<script>.js > out.json`. Both scripts open the
database with `readonly: true, fileMustExist: true` and `query_only = ON`. No branch code runs in the container.

`ux30-probe.js` (usage counts for 30 d, plus row count and newest row for every table):

```js
// UX-30 read-only probe: page/route usage (S4 usage_counts) + row count / newest row per table. No app code.
const Database = require('better-sqlite3');
const db = new Database('/data/djimitflo.sqlite', { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const out = { probed_at: new Date().toISOString(), since30 };
out.span = db.prepare('SELECT MIN(day) first_day, MAX(day) last_day, COUNT(DISTINCT day) days FROM usage_counts').get();
out.loss = db.prepare('SELECT day, dropped FROM usage_loss ORDER BY day').all();
out.usage = db.prepare(`SELECT day, kind, name, method, SUM(count) hits,
  SUM(CASE WHEN status_class IN ('4xx','5xx') THEN count ELSE 0 END) errors
  FROM usage_counts WHERE day >= ? GROUP BY day, kind, name, method`).all(since30);
const TS = ['created_at', 'updated_at', 'timestamp', 'ts', 'recorded_at', 'started_at', 'occurred_at', 'generated_at', 'day'];
out.tables = {};
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
  const ts = TS.find((c) => cols.includes(c));
  const row = db.prepare(`SELECT COUNT(*) n${ts ? `, MAX("${ts}") newest` : ''} FROM "${name}"`).get();
  out.tables[name] = { n: row.n, newest: row.newest ?? null, ts_col: ts ?? null };
}
process.stdout.write(JSON.stringify(out));
```

`ux30-probe-catalog.js` (the separate agent-catalog file behind `/catalog`):

```js
const fs = require('fs'); const Database = require('better-sqlite3');
const cands = [process.env.AGENT_CATALOG_DB, '/app/.data/agent-catalog.sqlite', '/data/agent-catalog.sqlite'].filter(Boolean);
const out = { runtime_profile: process.env.DJIMITFLO_RUNTIME_PROFILE ?? process.env.RUNTIME_PROFILE ?? null, candidates: cands, found: null, tables: {} };
const file = cands.find((f) => fs.existsSync(f));
if (file) {
  out.found = file; const db = new Database(file, { readonly: true, fileMustExist: true }); db.pragma('query_only = ON');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
    const ts = ['created_at', 'updated_at', 'evaluated_at', 'imported_at', 'activated_at'].find((c) => cols.includes(c));
    out.tables[name] = db.prepare(`SELECT COUNT(*) n${ts ? `, MAX("${ts}") newest` : ''} FROM "${name}"`).get();
  }
}
console.log(JSON.stringify(out));
```

Result on 31-10: `/data/agent-catalog.sqlite` has `profiles`, `evaluations`, `activations`, `overlaps` and
`audit_ledger`, all with 0 rows. `/app/.data/agent-catalog.sqlite` is absent. The runtime profile is `autonomous`,
so `/api/meta/*` answers.

<details><summary><code>page-api-map.mjs</code> (local, static page → API map; run as <code>node page-api-map.mjs packages/dashboard/src $(nav paths)</code>)</summary>

```js
import fs from 'node:fs'; import path from 'node:path';
const SRC = process.argv[2];
const apiSrc = fs.readFileSync(path.join(SRC, 'lib/api.ts'), 'utf8');
const body = apiSrc.slice(apiSrc.indexOf('class ApiClient'));
const methods = {};
const re = /^\s{2}(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/gm; let m; const heads = [];
while ((m = re.exec(body))) heads.push([m[1], m.index]);
heads.forEach(([name, at], i) => {
  const chunk = body.slice(at, i + 1 < heads.length ? heads[i + 1][1] : body.length);
  const ps = [...chunk.matchAll(/(?:request|this\.get|this\.post|this\.put|this\.patch|this\.delete)\b[^(]{0,120}?\(\s*[`'"]([^`'"?]+)/g)].map((x) => x[1].replace(/\$\{[^}]+\}/g, ':p'));
  if (ps.length) methods[name] = [...new Set([...(methods[name] || []), ...ps])];
});
const resolve = (from, spec) => {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const c of [base, base + '.tsx', base + '.ts', path.join(base, 'index.tsx'), path.join(base, 'index.ts')])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};
const SKIP = /\/(lib\/api|lib\/auth-store|components\/Layout|lib\/store)\.tsx?$/;
function walk(file, seen = new Set()) {
  if (seen.has(file) || SKIP.test(file)) return seen; seen.add(file);
  const s = fs.readFileSync(file, 'utf8');
  for (const x of s.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const r = resolve(file, x[1] || x[2]); if (r && !/\.test\./.test(r)) walk(r, seen);
  }
  return seen;
}
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
const comp = {}; for (const x of app.matchAll(/const (\w+) = lazy\(\(\) => import\('([^']+)'\)/g)) comp[x[1]] = x[2];
for (const x of app.matchAll(/import \{?\s*(\w+)\s*\}? from '(\.\/pages\/[^']+)'/g)) comp[x[1]] = x[2];
const routeComp = {}; for (const x of app.matchAll(/<Route path="([^"]+)" element=\{<(\w+)/g)) routeComp['/' + x[1].replace(/^\//, '')] = x[2];
routeComp['/'] = routeComp['/'] || 'OperatorCockpitPage';
const out = {};
for (const p of process.argv.slice(3)) {
  const c = routeComp[p]; const spec = comp[c];
  if (!spec) { out[p] = { component: c, error: 'unresolved' }; continue; }
  const files = walk(resolve(path.join(SRC, 'App.tsx'), spec)); const paths = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const x of s.matchAll(/\bapi\.(\w+)\s*\(/g)) for (const q of methods[x[1]] || []) paths.add(q);
    for (const x of s.matchAll(/(?:request|\bapi\.(?:get|post|put|patch|delete))\b[^(]{0,200}?\(\s*[`'"](\/[^`'"?]+)/g)) paths.add(x[1].replace(/\$\{[^}]+\}/g, ':p'));
    for (const x of s.matchAll(/[`'"](?:\$\{API_BASE\}|\/api)(\/[\w\-/${}.:]+)/g)) paths.add(x[1].replace(/\$\{[^}]+\}/g, ':p'));
  }
  out[p] = { component: c, files: files.size, paths: [...paths].sort() };
}
console.log(JSON.stringify(out, null, 1));
```

</details>

Sweep days were detected with this rule: a day is a sweep day when ≥ 16 of the 17 Lab paths have a `kind='page'` row
on it. On 31-10 this gives 10-02, 10-04, 10-08, 10-09, 10-10, 10-23 and 10-26. Targeted views = views − 1 for each
sweep day on which the page was viewed.
