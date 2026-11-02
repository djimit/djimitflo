import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { aggregateScope, costPerVerified, LOST_WINDOWS, METRIC_DEFINITIONS, metricRef, toolCallLinkage, usageEvents, type UsageEvent } from '../services/cost-ledger';

const NOW = Date.parse('2026-10-14T00:00:00Z');
const H = 3_600_000; const DAY = 24 * H;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SINCE = iso(30 * DAY); const UNTIL = iso(0);
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

// ── seed helpers: the shapes the production writers store ─────────────────────────────────────────────────────────
const proposal = (id: string, status: string, at = iso(10 * DAY), panel: string | null = null) =>
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, panel_id, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', ?, ?, ?, ?)")
    .run(id, status, panel, at, at);
const run = (id: string, proposalId: string | null, pr?: { state: string; merged_at?: string; survived?: boolean; settled_at?: string }, at = iso(9 * DAY)) => {
  if (proposalId) db.prepare("INSERT OR IGNORE INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', ?, ?, ?)").run(`g-${proposalId}`, proposalId, at, at);
  const meta = pr ? { pr_url: `https://github.com/o/r/pull/${id}`, pr_outcome: { checked_at: iso(H), ...pr } } : {};
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', ?, ?, ?)")
    .run(id, proposalId ? `g-${proposalId}` : null, JSON.stringify(meta), at, at);
};
const lease = (id: string, runId: string, role: string, usage: Record<string, unknown> | null, extra: Record<string, unknown> = {}, status = 'completed', runtime = 'opencode', at = iso(9 * DAY)) =>
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, runId, role, runtime, status, JSON.stringify({ model: 'glm-5.2', ...(usage ? { runtime_usage: usage } : { runtime_usage: { usage_source: 'unknown' } }), ...extra }), at, at);
const makerOutcome = (runId: string, ok: boolean) =>
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, created_at) VALUES (?, 'loop-maker:test-gap:opencode', ?, 'test-gap', ?, ?)").run(`o-${runId}`, ok ? 1 : 0, runId, iso(8 * DAY));
const call = (consumer: string, tin: number | null, tout: number | null, extra: { run?: string; purpose?: string; attempts?: number; model?: string; provider?: string } = {}, at = iso(5 * DAY)) =>
  db.prepare('INSERT INTO llm_model_calls (consumer, model, ok, provider, tokens_in, tokens_out, run_id, purpose, attempts, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(consumer, extra.model ?? 'kimi-k3:cloud', extra.provider ?? 'ollama', tin, tout, extra.run ?? null, extra.purpose ?? null, extra.attempts ?? null, at);
const judgment = (id: string, name: string, subjectType: string, subjectId: string, tin: number, tout: number, at = iso(6 * DAY), hash = 'h') =>
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, input_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, ?, 'shadow', 'x', ?, ?, 'jev-1.13.0', ?)")
    .run(id, name, subjectType, subjectId, hash, tin, tout, at);
const usage = (total: number, prompt?: number, completion?: number) => ({ total_tokens: total, ...(prompt !== undefined ? { prompt_tokens: prompt } : {}), ...(completion !== undefined ? { completion_tokens: completion } : {}), usage_source: 'runtime_stdout' });
const scopeOf = (c: ReturnType<typeof costPerVerified>, s: string) => c.scopes.find((x) => x.scope === s)!;

describe('usage events: identity, one owner, mirrors never counted', () => {
  it('derives one event per token record with a stable sha256 identity and exactly one primary owner; the maker ledger row is a mirror', () => {
    proposal('p1', 'verified'); run('r1', 'p1', { state: 'merged', merged_at: iso(8 * DAY) });
    lease('m1', 'r1', 'maker', usage(3_000_000, 100_000, 20_000)); makerOutcome('r1', true);
    lease('c1', 'r1', 'checker', usage(500_000), { verdict: 'accepted' });
    call('maker', 3_000_000, null, { run: 'r1', provider: 'opencode', model: 'glm-5.2' }); // B29 mirror of m1
    call('maker', 3_000_000, null, { run: 'r1', provider: 'opencode', model: 'glm-5.2' }); // duplicate model-call record (second daemon pass)
    call('jev', 800, null, { purpose: 'jev:systemone' }); // mirror of the judgment rows below
    judgment('j1', 'discovery_relevance', 'self_improvement', 'p1', 800, 40);
    call('fallback', null, null, { purpose: 'transport:panel_review:review' }); // transport row of a caller that records itself
    call('panel_review', 900, 60, { purpose: 'panel_review:review' });
    call('jev', null, null, { attempts: 0, purpose: 'jev:systemone' }); // queue_full: never sent

    const { events, mirrors } = usageEvents(db, SINCE, UNTIL, { now: NOW });
    expect(events.map((e) => e.source).sort()).toEqual(['judgments', 'llm_model_calls', 'worker_leases', 'worker_leases']);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events) expect(e.id).toMatch(/^[0-9a-f]{32}$/);
    expect(usageEvents(db, SINCE, UNTIL, { now: NOW }).events.map((e) => e.id)).toEqual(events.map((e) => e.id)); // deterministic, not random
    expect(events.find((e) => e.row_id === 'm1')).toMatchObject({ owner: { kind: 'lease', id: 'm1' }, tokens_provider_reported: { input: 100_000, output: 20_000, other: 2_880_000, total: 3_000_000 },
      tokens_estimated: null, tokens_reconciled: 3_000_000, reconciled_basis: 'provider_reported', run_verified: true, proposal_verified: true, pr_merged: true, pr_survived: null });
    expect(mirrors.find((m) => m.rule.startsWith('consumer = maker'))).toMatchObject({ rows: 2, tokens: 6_000_000, owner_kind: 'lease' });
    expect(mirrors.map((m) => m.rows).reduce((a, b) => a + b, 0)).toBe(5);
    const total = events.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0);
    expect(total).toBe(3_000_000 + 500_000 + 840 + 960);
    // the v1 source counts the mirror as its own event — the double count, reproducible
    const v1 = usageEvents(db, SINCE, UNTIL, { now: NOW, includeMakerMirror: true }).events;
    expect(v1.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0) - total).toBe(6_000_000);
  });

  it('marks one runJudgments call over several judgments as shared with its allocation rule; the members sum to the call', () => {
    proposal('p1', 'verified');
    judgment('j1', 'a', 'self_improvement', 'p1', 500, 30); judgment('j2', 'b', 'self_improvement', 'p1', 500, 30); // one call: 1000 in / 60 out split at write
    judgment('j3', 'a', 'self_improvement', 'p1', 500, 30, iso(6 * DAY), 'other-state'); // a different call
    const ev = usageEvents(db, SINCE, UNTIL, { now: NOW }).events;
    const shared = ev.filter((e) => e.shared);
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((e) => e.shared!.group)).size).toBe(1);
    expect(shared[0].shared).toMatchObject({ members: 2, rule: expect.stringMatching(/^equal_split_at_write/) });
    expect(shared.reduce((s, e) => s + e.tokens_reconciled!, 0)).toBe(1060);
    expect(ev.find((e) => e.row_id === 'j3')!.shared).toBeNull();
  });
});

describe('costPerVerified: population first, every attempt in the numerator, UNKNOWN never 0', () => {
  function seedPopulation() {
    proposal('p1', 'verified', iso(10 * DAY), 'panel-1'); proposal('p2', 'regressed'); proposal('p3', 'proposed'); // p3 open: censored
    proposal('old', 'verified', iso(40 * DAY)); // outside the population (created before the window)
    // p1: a failed maker attempt, a cancelled reviewer, then a retry that verified, merged and survived (multiple tasks per PR)
    run('r1a', 'p1'); lease('m1a', 'r1a', 'maker', usage(2_000_000), {}, 'failed'); makerOutcome('r1a', false);
    lease('c1a', 'r1a', 'checker', null, {}, 'cancelled');
    run('r1b', 'p1', { state: 'merged', merged_at: iso(20 * DAY), survived: true, settled_at: iso(5 * DAY) });
    lease('m1b', 'r1b', 'maker', usage(1_000_000)); makerOutcome('r1b', true);
    lease('c1b', 'r1b', 'checker', usage(300_000), { verdict: 'accepted' }); lease('s1b', 'r1b', 'security_checker', usage(200_000), { verdict: 'insufficient_evidence' }, 'failed');
    judgment('jl', 'review_quality', 'worker_lease', 'c1b', 100, 10); // overlapping reviewer usage: a judgment about the reviewer lease
    judgment('jp', 'panel_x', 'specialist_panel', 'panel-1', 200, 20);
    // p2: regressed, merged but still inside the survival window
    run('r2', 'p2', { state: 'merged', merged_at: iso(3 * DAY) }); lease('m2', 'r2', 'maker', usage(4_000_000)); makerOutcome('r2', false);
    lease('c2', 'r2', 'checker', usage(100_000), { verdict: 'rejected' });
    // p3: open PR, maker tokens never reported (UNKNOWN)
    run('r3', 'p3', { state: 'open' }); lease('m3', 'r3', 'maker', null, {}, 'running');
    // unattributed: a resident call and a run of an older proposal
    call('resident:commons-scout', 7_000, 1_000);
    run('rold', 'old'); lease('mold', 'rold', 'maker', usage(9_000_000));
  }

  it('fixes the population (proposals created in the window) and divides everything it consumed by its verified / merged / surviving members', () => {
    seedPopulation();
    const c = costPerVerified(db, { now: NOW, windowDays: 30 });
    const pop = 2_000_000 + 1_000_000 + 300_000 + 200_000 + 110 + 220 + 4_000_000 + 100_000; // m1a m1b c1b s1b jl jp m2 c2
    expect(c.population).toMatchObject({ members: 3, verified: 1, open: 1, merged: 2, surviving: 1, survival_pending: 1 });
    expect(c.population.unattributed.cloud_tokens).toBe(8_000 + 9_000_000);
    const task = scopeOf(c, 'task');
    expect(task).toMatchObject({ n: 1, censored: 1, metric: metricRef('cost.per_verified_task') });
    expect(task.numerator.cloud_tokens).toMatchObject({ value: pop, status: 'partial' }); // c1a and m3 have no tokens → partial, not 0
    expect(task.numerator.cloud_tokens.coverage!).toBeLessThan(1);
    expect(task.per_unit.cloud_tokens).toMatchObject({ value: pop, status: 'lower_bound' });
    // the failed attempt and its reviewers are in the numerator; successful_only is the survivorship-biased contrast
    expect(task.successful_only.cloud_tokens).toBe(2_000_000 + 1_000_000 + 300_000 + 200_000 + 110 + 220);
    expect(scopeOf(c, 'merge')).toMatchObject({ n: 2, censored: 1, per_unit: { cloud_tokens: { value: pop / 2 } } });
    expect(scopeOf(c, 'surviving_pr')).toMatchObject({ n: 1, censored: 1, per_unit: { cloud_tokens: { value: pop } } });
    const rev = scopeOf(c, 'reviewer');
    expect(rev.n).toBe(2); // c1b accepted, c2 rejected; s1b insufficient_evidence and the cancelled c1a are not valid verdicts
    expect(rev.numerator.cloud_tokens.value).toBe(300_000 + 200_000 + 100_000);
    expect(c.shares.reviewer_no_verdict).toMatchObject({ numerator_tokens: 200_000, denominator_tokens: 600_000, leases: 2 });
    // unverified runs: m1a + m2 + c2 (runs with a failed maker outcome) ÷ run-linked population tokens
    expect(c.shares.unverified_run_tokens).toMatchObject({ numerator_tokens: 2_000_000 + 4_000_000 + 100_000, denominator_tokens: pop - 220 });
  });

  it('keeps every unmeasured part UNKNOWN: review minutes, USD without a dated price, energy without samples, local tokens', () => {
    seedPopulation();
    const task = scopeOf(costPerVerified(db, { now: NOW, windowDays: 30 }), 'task');
    for (const k of ['review_minutes', 'usd', 'local_gpu_kwh', 'local_tokens'] as const) {
      expect(task.numerator[k]).toMatchObject({ value: null, status: 'UNKNOWN' });
      expect(task.per_unit[k]).toMatchObject({ value: null, status: 'UNKNOWN' });
    }
  });

  it('USD only from a dated, sourced price entry, labelled inferred; unpriced cache tokens leave it partial', () => {
    proposal('p1', 'verified'); run('r1', 'p1');
    lease('m1', 'r1', 'maker', usage(1_000_000, 900_000, 100_000)); lease('m2', 'r1', 'maker', usage(2_000_000, 100_000, 100_000)); // m2: 1.8 M cache tokens
    const prices = [{ model: 'glm-5.2', usd_per_mtok_input: 1, usd_per_mtok_output: 2, as_of: '2026-10-14', source: 'https://example.test/pricing' }];
    const c = costPerVerified(db, { now: NOW, windowDays: 30, prices });
    const usd = scopeOf(c, 'task').numerator.usd;
    expect(usd).toMatchObject({ value: 1.1, status: 'partial', unit: 'USD (inferred, list price)' });
    expect(usd.coverage).toBeCloseTo(1 / 3, 3);
    expect(c.price_list).toMatchObject({ entries: 1, as_of: '2026-10-14' });
  });

  it('late-arriving records: a lease without tokens is UNKNOWN until its usage arrives, then counted once', () => {
    proposal('p1', 'verified'); run('r1', 'p1'); lease('m1', 'r1', 'maker', null, {}, 'running');
    const before = scopeOf(costPerVerified(db, { now: NOW, windowDays: 30 }), 'task');
    expect(before.numerator.cloud_tokens).toMatchObject({ value: null, status: 'UNKNOWN' });
    db.prepare("UPDATE worker_leases SET metadata = json_set(metadata, '$.runtime_usage', json(?)) WHERE id = 'm1'").run(JSON.stringify(usage(700_000)));
    const c = costPerVerified(db, { now: NOW, windowDays: 30 });
    // every event now has tokens; what remains below 1 is the lost window inside these 30 days
    expect(scopeOf(c, 'task').numerator.cloud_tokens).toMatchObject({ value: 700_000, status: 'partial', coverage: +(1 - c.window.lost_hours_in_window / (30 * 24)).toFixed(3) });
  });

  it('the lost window (2026-10-11 rollback) lowers coverage instead of counting as zero usage', () => {
    proposal('p1', 'verified'); run('r1', 'p1'); lease('m1', 'r1', 'maker', usage(1_000));
    const c = costPerVerified(db, { now: NOW, windowDays: 30 });
    expect(c.window.lost_windows).toBe(LOST_WINDOWS);
    expect(c.window.lost_hours_in_window).toBeCloseTo((Date.parse(LOST_WINDOWS[0].to) - Date.parse(LOST_WINDOWS[0].from)) / H, 2);
    expect(scopeOf(c, 'task').numerator.cloud_tokens.status).toBe('partial');
  });
});

describe('versioned metrics and corrections', () => {
  it('pins every published definition: a text change without a new version fails here', () => {
    expect(METRIC_DEFINITIONS.map((m) => `${m.id}@${m.version}:${m.hash}`)).toMatchInlineSnapshot(`
      [
        "efficiency.cloud_tokens@1:e2f2544d5228b627",
        "efficiency.cloud_tokens@2:f876eed0fbacfac4",
        "cost.usage_event@1:604327e21a10c631",
        "cost.population@1:fbeccb36c6ab2ae0",
        "cost.per_verified_task@1:cec34bc552bd40bd",
        "cost.per_valid_reviewer_verdict@1:c16b35a13beffa22",
        "cost.per_merged_pr@1:d93d7b9b896d8d5d",
        "cost.per_surviving_pr@1:b125d1314838ceb4",
        "cost.unverified_run_share@1:1b69e78a75408796",
        "cost.reviewer_no_verdict@1:04081e3b5efeee75",
      ]
    `);
    expect(new Set(METRIC_DEFINITIONS.map((m) => `${m.id}@${m.version}`)).size).toBe(METRIC_DEFINITIONS.length);
    expect(METRIC_DEFINITIONS.find((m) => m.id === 'efficiency.cloud_tokens' && m.version === 2)).toMatchObject({ supersedes: 1, reason: expect.stringContaining('ACCOUNTING_CORRECTION') });
  });

  it('shows the v1 value next to the corrected one as an ACCOUNTING_CORRECTION, never as an operational saving', () => {
    proposal('p1', 'verified'); run('r1', 'p1');
    lease('m1', 'r1', 'maker', usage(3_000_000)); call('maker', 3_000_000, null, { run: 'r1', provider: 'opencode', model: 'glm-5.2' });
    const c = costPerVerified(db, { now: NOW, windowDays: 30 });
    expect(c.corrections).toEqual([expect.objectContaining({ classification: 'ACCOUNTING_CORRECTION', metric: metricRef('efficiency.cloud_tokens', 2), from: metricRef('efficiency.cloud_tokens', 1),
      v1_cloud_tokens: 6_000_000, v2_cloud_tokens: 3_000_000, delta_tokens: 3_000_000 })]);
    expect(scopeOf(c, 'task')).toMatchObject({ per_unit: { cloud_tokens: { value: 3_000_000 } }, with_duplicate: { per_unit: 6_000_000, delta_tokens: 3_000_000, correction: 'ACCOUNTING_CORRECTION' } });
    expect(c.operational_savings.verified).toEqual([]);
    for (const s of c.scopes) expect(s.metric).toEqual(metricRef(s.metric.id));
  });
});

it('links execution_events tool.call rows to their lease through the stored tasks.metadata.lease_id only', () => {
  run('r1', null); lease('m1', 'r1', 'maker', usage(1)); lease('c1', 'r1', 'checker', usage(1));
  const task = (id: string, meta: object) => db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata, created_at, updated_at) VALUES (?, 't', 'd', 'completed', 'low', 'low', 'local', ?, ?, ?)")
    .run(id, JSON.stringify(meta), iso(DAY), iso(DAY));
  const ev = (taskId: string) => db.prepare("INSERT INTO execution_events (id, task_id, event_type, message, level, tool_name, created_at) VALUES (?, ?, 'tool.call', 'Tool call: bash', 'info', 'bash', ?)")
    .run(`${taskId}-${Math.random()}`, taskId, iso(DAY));
  task('loop-worker-m1-x', { lease_id: 'm1' }); task('loop-worker-c1-x', { lease_id: 'c1' }); task('engine-1', {}); task('loop-worker-gone-x', { lease_id: 'gone' });
  ev('loop-worker-m1-x'); ev('loop-worker-m1-x'); ev('loop-worker-c1-x'); ev('engine-1'); ev('loop-worker-gone-x'); ev('no-such-task');
  expect(toolCallLinkage(db, SINCE, UNTIL)).toMatchObject({ events: 6, linked: 3, linked_share: 0.5, by_role: { maker: 2, checker: 1 }, unlinked: { no_task: 1, no_lease_id: 1, lease_missing: 1 } });
});

describe('property: every usage event is counted at most once per aggregation scope', () => {
  // mulberry32: seeded, so a failure reproduces
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))('random overlapping cohorts, seed %i', (seed) => {
    const r = rng(seed);
    const statuses = ['verified', 'regressed', 'proposed', 'infra_failed'];
    const nP = 2 + Math.floor(r() * 5);
    let originalLease = 0; let originalJudgment = 0; let originalCalls = 0;
    for (let p = 0; p < nP; p++) {
      proposal(`p${p}`, pick(r, statuses), iso((1 + r() * 20) * DAY), `panel${p}`);
      const runs = 1 + Math.floor(r() * 3); // retries: several runs (tasks) per proposal, any of them with a PR
      for (let k = 0; k < runs; k++) {
        const id = `r${p}_${k}`; const prState = pick(r, ['none', 'open', 'merged', 'merged_survived', 'merged_regressed']);
        const pr = prState === 'none' ? undefined : prState === 'open' ? { state: 'open' }
          : { state: 'merged', merged_at: iso(20 * DAY), ...(prState === 'merged' ? {} : { survived: prState === 'merged_survived', settled_at: iso(2 * DAY) }) };
        run(id, `p${p}`, pr, iso(r() * 25 * DAY));
        if (r() < 0.8) makerOutcome(id, r() < 0.5);
        for (const role of ['maker', 'checker', 'security_checker']) {
          const tokens = r() < 0.85 ? Math.floor(r() * 1e6) + 1 : null;
          if (tokens) originalLease += tokens;
          lease(`${role}-${id}`, id, role, tokens ? usage(tokens) : null, { verdict: pick(r, ['accepted', 'rejected', 'insufficient_evidence']) }, pick(r, ['completed', 'failed', 'cancelled']), 'opencode', iso(r() * 25 * DAY));
          if (role === 'maker' && tokens && r() < 0.6) { call('maker', tokens, null, { run: id }); if (r() < 0.3) call('maker', tokens, null, { run: id }); } // mirrors, sometimes twice
        }
        if (r() < 0.5) { const t = Math.floor(r() * 1000) + 1; originalJudgment += 2 * t; judgment(`jl${id}`, 'x', 'worker_lease', `checker-${id}`, t, t); }
      }
      if (r() < 0.5) { const t = Math.floor(r() * 500) + 1; originalJudgment += 4 * t; judgment(`ja${p}`, 'a', 'self_improvement', `p${p}`, t, t, iso(DAY), `s${p}`); judgment(`jb${p}`, 'b', 'self_improvement', `p${p}`, t, t, iso(DAY), `s${p}`); }
      if (r() < 0.5) { const t = Math.floor(r() * 500) + 1; originalJudgment += 2 * t; judgment(`jp${p}`, 'panel', 'specialist_panel', `panel${p}`, t, t); }
    }
    for (let i = 0; i < 3; i++) { const t = Math.floor(r() * 5000) + 1; originalCalls += t; call(`resident:${i}`, t, 0); }

    const { events } = usageEvents(db, SINCE, UNTIL, { now: NOW });
    const total = events.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0);
    // reconciliation against the original records: leases + judgments + non-mirror model calls, nothing else
    expect(total).toBe(originalLease + originalJudgment + originalCalls);
    // identity and single ownership
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const owners = new Map<string, Set<string>>();
    for (const e of events) owners.set(e.id, (owners.get(e.id) ?? new Set()).add(`${e.owner.kind}:${e.owner.id}`));
    for (const o of owners.values()) expect(o.size).toBe(1);
    // random overlapping cohorts (task / reviewer / merge / surviving PR and random subsets): each event at most once, sums consistent
    const cohorts: Array<(e: UsageEvent) => boolean> = [
      (e) => e.proposal_verified === true, (e) => e.role === 'reviewer', (e) => e.pr_merged === true, (e) => e.pr_survived === true,
      ...Array.from({ length: 6 }, () => { const keep = new Set(events.filter(() => r() < 0.5).map((e) => e.id)); return (e: UsageEvent) => keep.has(e.id); }),
    ];
    const doubled = [...events, ...events.filter(() => r() < 0.5)]; // the same event offered twice to the aggregator
    for (const c of cohorts) {
      const a = aggregateScope(doubled, c, 'any');
      expect(new Set(a.ids).size).toBe(a.ids.length);
      const distinct = events.filter(c);
      expect(a.events).toBe(distinct.length);
      expect(a.tokens).toBe(distinct.reduce((s, e) => s + (e.tokens_reconciled ?? 0), 0));
      expect(a.tokens).toBeLessThanOrEqual(total);
      const complement = aggregateScope(events, (e) => !c(e), 'any');
      expect(a.tokens + complement.tokens).toBe(total);
    }
    const c = costPerVerified(db, { now: NOW, windowDays: 30 });
    expect(c.usage).toMatchObject({ owners_sum_equals_total: true, total_tokens: total, sum_over_owners: total });
    const scoped = scopeOf(c, 'task').numerator.cloud_tokens.value ?? 0;
    expect(scoped + c.population.unattributed.cloud_tokens).toBe(total);
    for (const s of c.scopes) expect(s.successful_only.cloud_tokens).toBeLessThanOrEqual(s.numerator.cloud_tokens.value ?? 0);
  });
});
