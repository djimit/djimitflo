# DI-001 C — discovery_relevance: dependency audit and reversible pause

Status: audit done 2026-10-14 against origin/main `bb02a731` and prod (`djimitflo-live`, read-only better-sqlite3).
Pause flag `DISCOVERY_RELEVANCE_PAUSED` is in this PR, default off. Nothing changes until an operator sets it.

## 1. What the judgment is

`discovery_relevance` (`packages/server/src/services/judgments/discovery-relevance.ts:10`) is a jev (TypeSafe
`systemOne`) call. It asks two questions about each fleet discovery (arXiv paper / GitHub repo): `relevance`
(open_problem / lane_technique / adjacent / off_topic) and `actionable` (noul). `decide()` (line 28) returns `yes` only for
open_problem|lane_technique with confidence ≥ `CONFIDENCE_FLOOR` and actionable ≥ 0.5. Below the floor it returns
`uncertain`. The mode comes from `TYPESAFE_DISCOVERY_RELEVANCE_MODE` (`judgment-service.ts:23`). Each call writes one
`judgments` row (`judgment-service.ts:71`), or one `decision='error'` row on failure (`:77`).

Prod flags (2026-10-14): `TYPESAFE_DISCOVERY_RELEVANCE_MODE=shadow`, `FRONTIER_UNITS_REQUIRE_RELEVANCE=true`,
`FRONTIER_EXPERT_SOURCE_UNITS_ENABLED=true`, `DISCOVERY_RELEVANCE_SOURCES=djimitflo-scout,operator-chatgpt`,
`ARENA_GATE_ENABLED=true`, `FEEDBACK_INTERESTS_ENABLED=true`, `COMMITTEE_SWARM_ENABLED=true`,
`EFFORT_CONTROLLER_MODE=shadow`, `FRONTIER_EXPERTS_SCHEDULER_ENABLED=false`, `DREAM_EVOLUTION_ENABLED=false`,
`FRONTIER_TECHNIQUE_CARDS_ENABLED=false`. `DISCOVERY_RELEVANCE_PAUSED` is unset.

## 2. Writers (inference call sites)

All of them are in `services/expert-source-units-service.ts` `ingestDiscovery()`. The only event consumer that calls it is
`services/external-event-ingest-service.ts:192` (bus `discovery.*` events, inside the ingest transaction, before the
event is inserted into `external_events`).

| # | Path | file:line | Trigger | Prod today |
|---|------|-----------|---------|------------|
| W1 | **FE2 admission** (`subject_type='discovery_pending'`) | `expert-source-units-service.ts:118-131` | taxonomy match + `FRONTIER_UNITS_REQUIRE_RELEVANCE=true` | **operational**. A unit is created only when the verdict is open_problem/lane_technique; the verdict is then re-pointed to `expert_unit` (`:128`) |
| W2 | **R3 rejected-gate shadow** + **KE-2 override** (`discovery_rejected`) | `:96-110` | no taxonomy match; capped at `DISCOVERY_GATE_SHADOW_MAX_PER_DAY` (100) by `rejectedShadowLeft()` | **operational**. A `yes` creates a `taxonomy_override:jev` unit (`:108`, `overrideUnit` `:157`) |
| W3 | G3 direct-path shadow (`expert_unit`) | `:133-138` | taxonomy match and REQUIRE_RELEVANCE off | not reachable on prod (REQUIRE_RELEVANCE=true). The 759 G3-era rows are from before 29-09 |
| W4 | KE-5 errored retry | `retryErroredRelevance` `:196`, called from `frontier-expert-scheduler.ts:131` | FE scheduler tick | **not operational** (scheduler off) |
| W5 | KE-2 backfill | `backfillRejectedOverrides` `:174` | manual one-shot | ran once 2026-10-09 (95 units) |
| W6 | local shadow copy (`discovery_relevance@local`) | `judgment-service.ts:70` → `local-shadow-queue.ts:14` | after each jev call | 196 rows, last 2026-09-30: **not operational** |
| W7 | EVC effort record (`effort_decision`) | `effort-controller.ts:157-175` (`JUDGMENT_CONSUMERS` `:145`) | before each call | shadow only (415 run / 22 skip) |

Other checks: no `runJudgments` batch includes `discovery_relevance`, so the note's "batched with other questions (#519)"
does not hold. K1 content safety on discovery events (`external-event-ingest-service.ts:189`) is a separate inference
(178 calls / 7 d). It is out of scope and keeps running while paused.

## 3. Readers and downstream dependents

| # | Reader | file:line | What it reads | Prod today |
|---|--------|-----------|---------------|------------|
| R1 | FE2 "judged once" check | `expert-source-units-service.ts:120` | any non-error row for the ref | operational |
| R2 | R3 daily cap | `:143-148` | `discovery_rejected` rows in the last 24 h | operational |
| R3 | **fleet source gate** (AR-W6) | `committee-swarm.ts:272-278` via `knowledgeOverview`, used at `expert-source-units-service.ts:94` | yes/uncertain/no per source, 30 d; blocks a source with ≥ 50 judged and 0 yes | operational, but **no effect**: both in-scope sources have yes > 0 (scout 232, chatgpt 8) |
| R4 | **knowledge overview** (W5) | `knowledge-overview.ts:34-66`, `GET /api/health/knowledge` (`routes/health.ts:164`), dashboard `/knowledge` | verdict mix per source, recent `yes` | operational (read-only) |
| R5 | **N4 interest profile / yield gate** (#733) | `interest-feedback.ts:96-116` (`termYields`), `:127` (relevant pool), published `djimitflo.feedback.interests` → `scripts/fleet-discovery-publisher.py:65` | yes rate per scout term vs the static baseline; trials expire after 14 d unmeasured | **operational**: profile 2026-10-13 `repair` 0.291 n=55 |
| R6 | committee scout persona context | `committee-swarm.ts:36, 93-94` | the 5 newest `yes` units (no time window) | operational: 95 jobs, last 2026-10-13 |
| R7 | dream-evolution knowledge inputs (KE-3) | `dream-evolution.ts:171-173` | 3 newest `yes` in 30 d | not operational (`DREAM_EVOLUTION_ENABLED=false`) |
| R8 | technique-card abstract-fetch priority | `technique-card-service.ts:84` | `yes` first | not operational (cards off) |
| R9 | stall watch "discoveries" | `stall-watch.ts:106-115` | newest row; stall after 36 h | operational |
| R10 | operator cockpit usage | `operator-cockpit.ts:175` | calls/errors/tokens per judgment, 7 d | operational (generic) |
| R11 | improvement funnel / intelligence metrics | `improvement-funnel-service.ts:86`, `intelligence-metrics.ts:298` | generic latency / annotation counts | inert (0 annotations) |
| R12 | evolution evidence flag list | `evolution-evidence.ts:41` | flag names | operational (display) |

Units downstream: the 242 `yes` units sit at CAPABILITY_INFERRED 133, EVIDENCE_COLLECTED 108 and CHECKED **1**. Only one
reached a human check (I06: CHECKED/APPROVED need humans). No consumer turns a `yes` into a code change, a gym task or a
merged PR.

## 4. Prod volume (`judgments`, judgment = 'discovery_relevance')

The first row is from 2026-09-26, so "all time" is 18 days.

| window | calls | errors | input tok | output tok | total tok | mean tok / ok call | mean latency | p50 / p95 latency (ok) |
|--------|-------|--------|-----------|------------|-----------|---------------------|--------------|------------------------|
| all (26-09 → 13-10) | 3 745 | 294 | 2 688 550 | 259 058 | **2 947 608** | 854 | 38.7 s | – |
| 7 d (07-10 → 13-10) | 969 | 294 (288 `TYPESAFE_QUEUE_FULL`, 6 timeout) | 514 419 | 50 745 | **565 164** | 837 | 90.4 s | 2.7 s / 320 s |

Verdict mix, all time (non-error n = 3 451): **yes 242 (7.0 %)**, no 322 (9.3 %), **uncertain 2 887 (83.7 %)**.
In the last 7 d (n = 675) it is yes 51 (7.6 %), no 40, uncertain 584 (86.5 %).
`uncertain` here means "confidence below the floor": adjacent 1 136, lane_technique 932, off_topic 729, open_problem 90.
`open_problem` has been `yes` only 4 times ever. The judge is confident on about one call in six.

Yes by source: djimitflo-scout 232, operator-chatgpt 8, djimit-kbwiki 2.
Discovery events in the last 7 d: scout 1 200, hermes-macmini 34, hermes-eve-v 5. The last two are already out of scope.

Path split: keyword-rejected refs judged 1 790 (non-error), yes 108 → **6.0 %**. Taxonomy-accepted refs, yes ≈ 134 /
1 661 → **≈ 8 %**. The keyword gate and jev hardly separate the two populations.

## 5. The pause (implemented, default off)

`DISCOVERY_RELEVANCE_PAUSED=true` (`expert-source-units-service.ts`, `discoveryRelevancePaused`) stops every **new**
discovery_relevance call. Historical judgments, the judgment definition, the existing tables and the mode flag stay as
they are. One new table, `discovery_relevance_backlog`, holds what the pause left unjudged (section 5.1).
The fallback is explicit for each dependent:

| Dependent | Paused behaviour |
|-----------|------------------|
| W1 FE2 admission | **No unit admitted**. This is the existing fail-closed rule ("no verdict, no unit"). `ingestDiscovery` parks the event in the backlog (path `pending`) and returns `paused-pending`. The ingest service also annotates the stored bus event with `relevance: 'unjudged', relevance_paused, relevance_paused_at`; that is informational, the backlog holds the state. A ref that already has a verdict still returns `known`. |
| W2 R3 / KE-2 | No shadow call and no override unit. The keyword gate's rejection stands (pre-KE-2 behaviour). Parked (path `rejected`), returns `paused-rejected`. |
| W3 G3 direct path | The unit is created as before, because admission there never waited for jev. Only the shadow call is skipped; parked (path `unit`, the shadow is judged on the unit later). |
| W4 KE-5 retry | `{ skipped: 'paused' }`, so no retry is used up. |
| Re-judge | `rejudgePaused()`, called next to KE-5 in the FE scheduler and usable by hand. It works through the backlog under the contract in 5.1, bounded per call and per day. Unpaused normal ingestion never judges a ref that has an open backlog row; the backlog owns that decision. |
| R3 fleet source gate / R4 overview | Unchanged code. Paused events have no verdict, so they are **missing**, never `no` (test: 49 `no` + 10 paused events = 49 judged, gate open). |
| R5 N4 yields | `termYields` counts verdicts only, so paused events are left out of n (tested). **Changed:** while paused, an unmeasured trial is not expired by the 14-day clock. Its clock restarts, so a pause cannot kill a trial for missing data. Once unpaused, the 14-day rule applies again. Over a long pause the 30-d window drains: measured terms fall below n = 20 and become "unmeasured". That reads as missing, not as failed. |
| R6 committee scout | Keeps the 5 newest historical `yes` (it has no window). Stale, not wrong. |
| R9 stall watch | While paused, "no judgment for 36 h" is not a stall. The check becomes "no discovery **received** for 36 h", so a publisher outage is still caught. |
| R12 evolution evidence | `DISCOVERY_RELEVANCE_PAUSED` is listed as an acting flag. |
| Counter | `GET /api/health/knowledge` → `relevance_pause`: `paused`, `unjudged {pending, rejected, unit}`, `calls_avoided` (rejected capped per day at the R3 cap), `mean_tokens_per_call` (7 d up to the last real call) and `tokens_avoided_estimate`. Also `backlog` (unjudged + rejudging), `states`, `oldest_unjudged_age_hours` and `rejudge {batch, max_per_day, claim_timeout_minutes, max_attempts, tick_minutes, per_day, drain_estimate_days}`. Everything is read from the backlog table, not from memory, so it survives restarts. The token figure is labelled "estimate". |

Event ingest, recording, taxonomy matching, abstracts (KE-1), K1 content safety and the interest profile keep running.

**Tokens avoided (estimate):** about **565 k tokens/week** on the 7-d basis (≈ 675 successful + 294 failed calls/week ×
837 tok). The 18-day run rate is ≈ 208 calls/day, which gives ≈ 1.2 M tokens/week. Queue pressure goes away too: 288
`TYPESAFE_QUEUE_FULL` in one day (08-10) were discovery_relevance calls crowding the shared jev limiter.

Activate (operator): set `DISCOVERY_RELEVANCE_PAUSED=true` in the live env and restart. Revert by unsetting it. Unsetting
it replays nothing by itself. The backlog drains only through `rejudgePaused()`, either per FE scheduler tick (off on prod
today) or by hand with the same `docker exec … node -e` pattern as `backfillRejectedOverrides`.

### 5.1 Recovery contract: what is and isn't guaranteed

State model (`discovery_relevance_backlog`, PK = **decision identity `(event_id, policy)`**). `policy` is
`discovery_relevance:<sha256(questions + confidence floor + DECIDE_RULE)[:12]>`, so a changed prompt or rule gives a new identity rather
than an overwrite. The states:

`unjudged` → `rejudging` (claim: `fence = fence + 1`, `claimed_at`) → `judged` | `skipped` (invalid / ref already decided /
no unit) | `failed` (after `DISCOVERY_REJUDGE_MAX_ATTEMPTS`, default 5). A failed call or commit goes back to `unjudged`
with `attempts + 1`. A `rejudging` claim older than `DISCOVERY_REJUDGE_CLAIM_TIMEOUT_MINUTES` (default 15; jev p95 is 320 s)
can be reclaimed, which increments the fence again.

Guaranteed:
- **Durable.** Every discovery parked during the pause is a row in SQLite, so a restart at any point loses nothing.
  Duplicate delivery of the same `event_id` is `INSERT OR IGNORE`, giving one row.
- **Fenced claims.** A claim is one atomic `UPDATE … WHERE state = 'unjudged' OR stale claim … RETURNING fence`, so of
  two workers, on one or two connections, only one gets a given fence. The fence is monotonic per row.
- **At most one persisted decision per identity.** The `judgments` insert, the backlog transition to `judged` (guarded
  by `fence = <worker's fence> AND state = 'rejudging'`) and the downstream admission (unit creation and re-pointing
  the judgment to the unit, or the KE-2 override) run in **one SQLite transaction**
  (`runJudgment(…, commit)` in `judgment-service.ts`). A worker whose fence is no longer current is vetoed and writes
  nothing: no judgment row, no decision, no unit. A newer valid decision can therefore never be overwritten.
  `judgment_id` is `UNIQUE`.
- **Atomic failure.** If the judgment insert or the admission throws, all of it rolls back, the row returns to
  `unjudged`, and a later call retries it. No unit can exist without its decision, and a unit is never created twice.
- **Bounded drain.** Each call claims at most `DISCOVERY_REJUDGE_BATCH` (default 20) and at most
  `DISCOVERY_REJUDGE_MAX_PER_DAY` (default 200) per rolling 24 h, counted from `claimed_at` in the table, so a restart
  does not reset the budget. It also skips while jev is busy (limiter queue or breaker), and the R3 daily cap still
  applies to rejected rows. With the hourly FE tick the default drain rate is **200/day** (`min(20 × 24, 200)`),
  which is about the pre-pause rate of ≈ 208 calls/day. `drain_estimate_days = backlog / per_day`.
- **Same rules as ingestion.** A ref that already has a verdict or a unit is `skipped`, not judged again. The second
  event id of one ref therefore costs no call.

Not guaranteed:
- **Exactly-once external execution.** The jev call is **at-least-once**. A worker that crashes after jev answered
  but before its commit, or whose claim times out while jev is still slow, leaves the row reclaimable. The next
  worker calls jev again. Tokens are spent twice, but one decision is persisted. The provider has no idempotency key.
- **Exactly-once per ref across policies.** A new policy version is a new identity. Rows of an old policy are not
  re-judged by this code (`rejudgePaused` selects the current policy only) and stay visible in `states`.
- **Liveness under a permanently failing jev.** After 5 attempts a row is `failed` and needs an operator. It is counted
  in `states.failed` and never silently dropped.
- **Scope/gate at re-judge time.** `DISCOVERY_RELEVANCE_SOURCES` and the arena gate were applied at ingest; they are
  not re-evaluated when a parked row is judged.

## 6. Economics: is there a cheaper decision procedure? (assessment, not built)

The decision it supports is "should this discovery become an expert unit / feed the scout profile". Measured value so far:
7 % yes, 84 % uncertain, 1 of 242 yes-units ever checked by a human, no unit linked to a merged change. At about 850
tokens and a 39 s mean (p95 320 s) latency per call, that is ≈ 12 k tokens per `yes` and ≈ 2.9 M tokens for one
human-checked unit.

| Option | Cost per discovery | Expected quality | Notes |
|--------|--------------------|------------------|-------|
| A. Deterministic: taxonomy match + source scope (already live) | ~0 | Separates poorly by itself (accepted ≈ 8 % yes vs rejected 6 % under jev). But jev's yes is not ground truth either: 84 % uncertain | Baseline. With the pause, admission is "nothing new", the strictest variant. A cheaper baseline would admit taxonomy ∩ scope (the pre-FE2 ~1 000 units/week that nobody used), so not that. |
| B. Retrieval score (K2 embeddings, `kb-corpus.ts` / `proposal-dedupe.ts` `embed`+`cosine`) against the open-problem texts of the evidence pack and the existing `yes` set | one embedding call (~100–300 tok, local nemotron) + cosine | Unknown. It gives a continuous score, so a threshold can be tuned to a budget (top-k per week) | The 242 yes / 322 no historical verdicts are a ready offline benchmark: compute AUC of the cosine score against them before building anything. |
| C. Targeted human labelling | operator minutes | Highest validity. It also yields the missing ground truth for A/B/jev | 20–50 labels on a stratified sample (accepted/rejected × jev yes/uncertain/no) would show whether jev's `yes` beats random at all. `intelligence-metrics.ts:298` already counts `annotation` rows for this judgment (0 today). |
| D. jev (current) | ~850 tok, 39 s mean | 7 % yes at confidence, 84 % uncertain | The most expensive option, and its value is unproven. |

Recommendation: keep it paused. Run C (a small stratified label set) and B offline (cosine AUC on the historical verdicts
plus the labels). Then compare all four on the same labelled set.

**Reactivation criterion.** Unpause only when there is demonstrated *incremental decision value over a baseline*. On a
labelled sample of at least 50 discoveries (stratified as above), jev must beat the best cheap baseline (A or B at a
budget-matched threshold) by a pre-registered margin on precision@admitted. A non-overlapping 95 % CI on the
difference counts as the margin. At least one consumer that acts on a `yes` must be operational (FE2 units that
reach CHECKED, or N4 terms whose yield beats the static baseline). Without a consumer that acts, the VOI is 0 by
`effort-controller.ts` hook (c), whatever the accuracy.

## 7. Tests

`packages/server/src/__tests__/discovery-relevance-pause.test.ts` has 16 tests:
- flag default false / only `'true'`; unpaused FE2 unchanged;
- paused FE2 through `pollOnce` (no jev fetch, no unit, event stored and parked); paused R3/KE-2 and G3 paths;
- KE-5 retry and re-judge standing still while paused;
- restart during backlog accumulation (file DB reopened twice);
- crash between jev response and commit (reclaim only after the timeout, jev called twice, one decision, the late stale
  worker vetoed);
- stale worker answering before the new owner (vetoed);
- duplicate delivery (same event id twice in one bus batch, plus a direct call: one event, one row, one judgment);
- partial DB failure (judgment insert throws; admission throws after the unit was created: both roll back, then one
  decision and one unit);
- concurrent workers on two connections;
- pause/unpause toggles (no duplicate, no loss, normal ingestion defers to the backlog);
- bounded drain (no replay on unpause, batch 20, backpressure while jev is busy, daily cap, next day continues);
- overview backlog/age/drain and token estimate; fleet gate and N4 yields treating paused events as missing;
  stall watch; N4 trial clock.

Ten of these failed against the first PR head `02fd0eba`, which had no backlog table, fence or bounded drain. The other
six pass on both heads.
