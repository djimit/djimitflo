import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { checkLoopPrs, POLL_INTERVAL_MS, POLL_SLACK_MS, SETTLEMENT_STATES, settlementState, survivalCounts, type SettlementOutcome } from '../services/merge-survival';
import { listDraftPrs } from '../services/loop-draft-pr-service';
import { evolutionLineage, postVerificationRegressions } from '../services/evolution-lineage';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { decisionsInbox } from '../services/decisions-inbox';
import { attributionSummary } from '../services/outcome-attribution';

// E1: evolutionary settlement state ≠ GitHub PR state; survival rates count settled states only; per-poll counts persisted.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const H = 3_600_000; const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const created = iso(NOW - 30 * D);
const st = (o: SettlementOutcome | null, c = created, now = NOW) => settlementState(c, o, now);

let db: Database.Database;
afterEach(() => db?.close());
function fresh() { db?.close(); db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); return db; }
const prRun = (id: string, outcome: Record<string, unknown> | null, createdAt = created, goal: string | null = null) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, goal_id, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'test-gap', 'closed', 'completed', ?, '[]', '{}', '[]', '[]', ?, ?, ?)`)
  .run(id, goal, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${id.replace(/\D/g, '') || 1}`, ...(outcome ? { pr_outcome: outcome } : {}) }), createdAt, createdAt);
const merged = (mergedAgoMs: number, extra: Record<string, unknown> = {}) => ({ state: 'merged', merged_at: iso(NOW - mergedAgoMs), checked_at: iso(NOW - H), ...extra });
const settledAt = (mergedAgoMs: number, survived: boolean) => merged(mergedAgoMs, { settled_at: iso(NOW - mergedAgoMs + 14 * D + H), survived });

describe('settlementState: exactly one state per PR, age separate', () => {
  it('derives each state from consistent evidence', () => {
    expect(st({ state: 'open', checked_at: iso(NOW - H) })).toMatchObject({ state: 'OPEN_BLOCKED', reason: 'open', terminal: false, age_days: 30 });
    expect(st(null, iso(NOW - 2 * H))).toMatchObject({ state: 'OPEN_BLOCKED', reason: 'not_polled_yet' });
    expect(st({ state: 'closed_unmerged', merged_at: null, settled_at: iso(NOW - 2 * D) })).toMatchObject({ state: 'OPEN_BLOCKED', reason: 'closed_unmerged', terminal: true, age_days: 2 });
    expect(st(merged(3 * D))).toMatchObject({ state: 'MERGED_SURVIVAL_PENDING', reason: 'within_14d_window', age_days: 3 });
    expect(st(settledAt(20 * D, true))).toMatchObject({ state: 'SETTLED_SURVIVED', terminal: false });
    expect(st(settledAt(20 * D, false))).toMatchObject({ state: 'SETTLED_REGRESSED' });
  });

  it('inconsistent or missing evidence is PIPELINE_ANOMALY with a named reason — never a silent state', () => {
    const cases: Array<[SettlementOutcome | null, string, string?]> = [
      [{ state: 'merged', settled_at: iso(NOW - D), survived: true }, 'merged_without_merged_at'],
      [{ state: 'open', settled_at: iso(NOW - D) }, 'settled_while_unmerged'],
      [{ state: 'open', survived: true }, 'settled_while_unmerged'],
      [{ state: 'closed_unmerged', survived: false, settled_at: iso(NOW - D) }, 'settled_while_unmerged'],
      [{ state: 'open', merged_at: iso(NOW - D) }, 'open_with_merged_at'],
      [{ state: 'closed_unmerged' }, 'closed_without_settlement'],
      [merged(20 * D, { survived: true }), 'survived_without_settled_at'],
      [merged(20 * D, { settled_at: iso(NOW - 10 * D), survived: true }), 'settled_before_window'],
      [merged(20 * D, { settled_at: iso(NOW - D), not_scored: 'docs_only' }), 'not_scored:docs_only'],
      [merged(20 * D, { settled_at: iso(NOW - D) }), 'settled_without_verdict'],
      [{ state: 'reopened' }, 'unknown_state:reopened'],
      [{ checked_at: iso(NOW - H) }, 'outcome_without_state'],
      [null, 'never_polled', iso(NOW - POLL_INTERVAL_MS - POLL_SLACK_MS - 60_000)],
    ];
    for (const [o, reason, c] of cases) expect(st(o, c ?? created), reason).toMatchObject({ state: 'PIPELINE_ANOMALY', reason });
  });

  it('never-polled boundary: one poll interval + slack is still a wait, a minute later an anomaly', () => {
    expect(st(null, iso(NOW - POLL_INTERVAL_MS - POLL_SLACK_MS)).state).toBe('OPEN_BLOCKED');
    expect(st(null, iso(NOW - POLL_INTERVAL_MS - POLL_SLACK_MS - 60_000)).state).toBe('PIPELINE_ANOMALY');
  });

  it('states are mutually exclusive over a grid of evidence, and the age never changes the state name', () => {
    const states = ['open', 'merged', 'closed_unmerged', undefined];
    for (const state of states) for (const m of [null, iso(NOW - 20 * D)]) for (const s of [undefined, iso(NOW - D)]) for (const sv of [undefined, true, false]) {
      const r = st(state === undefined && !m && !s && sv === undefined ? null : { state, merged_at: m, settled_at: s, survived: sv });
      expect(SETTLEMENT_STATES.filter((x) => x === r.state)).toHaveLength(1);
      expect(r.state).not.toMatch(/\d/);
    }
  });
});

describe('14-day boundary on merged_at (fixed NOW)', () => {
  it('13 d 23 h without a check → pending; exactly 14 d → the window is complete (settlement valid, inclusive)', () => {
    expect(st(merged(14 * D - H))).toMatchObject({ state: 'MERGED_SURVIVAL_PENDING', reason: 'within_14d_window' });
    // the poller has not run yet at exactly 14 d: still pending, awaiting the check
    expect(st(merged(14 * D))).toMatchObject({ state: 'MERGED_SURVIVAL_PENDING', reason: 'awaiting_survival_check' });
    // a settlement written at exactly merged_at + 14 d is on the settled side
    expect(st(merged(14 * D, { settled_at: iso(NOW), survived: true })).state).toBe('SETTLED_SURVIVED');
    expect(st(merged(14 * D, { settled_at: iso(NOW - 60_000), survived: true }))).toMatchObject({ state: 'PIPELINE_ANOMALY', reason: 'settled_before_window' });
  });

  it('14 d + 1 min → settled once the survival check ran; pending until then; anomaly once the check is overdue', () => {
    expect(st(merged(14 * D + 60_000, { settled_at: iso(NOW), survived: false })).state).toBe('SETTLED_REGRESSED');
    expect(st(merged(14 * D + 60_000)).state).toBe('MERGED_SURVIVAL_PENDING');
    expect(st(merged(14 * D + POLL_INTERVAL_MS + POLL_SLACK_MS + 60_000))).toMatchObject({ state: 'PIPELINE_ANOMALY', reason: 'survival_check_overdue' });
  });

  const PATCH = '@@ -0,0 +1,2 @@\n+it("adds two", () => {\n+  expect(add(1, 1)).toBe(2);';
  const poll = async (mergedAgoMs: number) => {
    fresh(); prRun('r1', null, iso(NOW - mergedAgoMs - D));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/files')) return { ok: true, status: 200, json: async () => [{ filename: 't.test.ts', patch: PATCH }] };
      if (url.endsWith('/commits')) return { ok: true, status: 200, json: async () => [] };
      if (/pulls\/\d+$/.test(url)) return { ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: iso(NOW - mergedAgoMs), created_at: iso(NOW - mergedAgoMs - D) }) };
      return { ok: true, status: 200, json: async () => ({ content: Buffer.from('it("adds two", () => {\n  expect(add(1, 1)).toBe(2);').toString('base64'), encoding: 'base64' }) };
    }) as unknown as typeof fetch;
    await checkLoopPrs(db, fetchImpl, { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv, new Date(NOW));
    return listDraftPrs(db, 50, NOW).rows[0].settlement;
  };
  it('through the real poller: 13 d 23 h stays pending, exactly 14 d and 14 d + 1 min settle', async () => {
    expect(await poll(14 * D - H)).toBe('MERGED_SURVIVAL_PENDING');
    expect(await poll(14 * D)).toBe('SETTLED_SURVIVED');
    expect(await poll(14 * D + 60_000)).toBe('SETTLED_SURVIVED');
  });
});

describe('survival rates count SETTLED_SURVIVED / SETTLED_REGRESSED only', () => {
  it('survivalCounts excludes pending and anomalies from numerator and denominator', () => {
    expect(survivalCounts(['SETTLED_SURVIVED', 'SETTLED_REGRESSED', 'MERGED_SURVIVAL_PENDING', 'PIPELINE_ANOMALY', 'OPEN_BLOCKED'])).toEqual({ survived: 1, regressed: 1, settled: 2, rate: 0.5 });
    expect(survivalCounts(['MERGED_SURVIVAL_PENDING', 'PIPELINE_ANOMALY']).rate).toBeNull();
  });

  /** 1 survived, 1 regressed, 1 pending, 2 anomalies that main counted (merged without merged_at + survived; settled before the window, regressed), 1 closed unmerged */
  const seed = () => {
    fresh();
    const proposal = (id: string) => {
      db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
        VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', 'verified', '[]', ?, ?)`).run(id, `t ${id}`, iso(NOW - 25 * D), iso(NOW - 24 * D));
      db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'completed', '{}', ?, ?, ?)`)
        .run(`g-${id}`, id, iso(NOW - 24 * D), iso(NOW - 24 * D));
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
        VALUES (?, 'outcome_attribution', 'loop_run', ?, 'h', 'computed', 'verified', 't', ?)`).run(`a-${id}`, `r${id.slice(1)}`, iso(NOW - D));
      return `g-${id}`;
    };
    prRun('r1', settledAt(20 * D, true), created, proposal('p1'));
    prRun('r2', settledAt(20 * D, false), created, proposal('p2'));
    prRun('r3', merged(3 * D), created, proposal('p3'));
    prRun('r4', { state: 'merged', settled_at: iso(NOW - D), survived: true }, created, proposal('p4'));
    prRun('r5', merged(20 * D, { settled_at: iso(NOW - 15 * D), survived: false }), created, proposal('p5'));
    prRun('r6', { state: 'closed_unmerged', merged_at: null, settled_at: iso(NOW - D) }, created, proposal('p6'));
  };

  it('evolution lineage NEV / survival_rate and post-verification regressions', () => {
    seed();
    const e = evolutionLineage(db, NOW, { OUTCOME_ATTRIBUTION_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(e.nev).toMatchObject({ survived: 1, settled: 2, survival_rate: 0.5 });
    expect(e.regression_split.post_verification).toBe(1);
    expect(postVerificationRegressions(db, iso(NOW - 30 * D), NOW)).toBe(1);
  });

  it('evolution evidence merge section and gate B', () => {
    seed();
    const ev = buildEvolutionEvidence(db, {}, NOW);
    expect(ev.merge.settlement).toMatchObject({ survived: 1, regressed: 1, settled: 2, survival_rate: 0.5,
      by_state: { OPEN_BLOCKED: 1, MERGED_SURVIVAL_PENDING: 1, SETTLED_SURVIVED: 1, SETTLED_REGRESSED: 1, PIPELINE_ANOMALY: 2 } });
    expect(ev.gates.B.reason).toContain('2 settled loop PRs (1 survived, 1 not)');
  });

  it('evolution evidence drafts.unsettled and gate C count OPEN_BLOCKED (not closed) + MERGED_SURVIVAL_PENDING; anomalies apart', () => {
    seed(); prRun('r8', null); prRun('r9', { state: 'open', checked_at: iso(NOW - H) }); // r8: never polled for 30 d → anomaly
    const ev = buildEvolutionEvidence(db, {}, NOW);
    expect(ev.drafts).toMatchObject({ unsettled: 2, unsettled_open_or_recent: 2, anomalous: 3, age_days_max: 30 }); // main: 3 (r3, r8, r9), anomalies hidden
    expect(ev.gates.C.reason).toMatch(/^2 loop PRs/);
  });

  it('decisions inbox ranking and attribution summary', () => {
    seed(); prRun('r7', { state: 'open', checked_at: iso(NOW - H) });
    const ranked = decisionsInbox(db, NOW).ranking.filter((r) => r.kind === 'loop_pr');
    expect(ranked.map((r) => r.id)).toEqual(['7']); // only the open PR waits for the operator
    expect(ranked[0].evidence[0]).toContain('merge survival 1/2 settled loop PRs');
    expect(attributionSummary(db, NOW).survived).toEqual({ yes: 1, no: 1 });
  });
});

it("listDraftPrs: polled-but-unsettled PRs are counted (main reported '55 PRs, 0 not settled yet')", () => {
  fresh();
  prRun('r1', { state: 'open', checked_at: iso(NOW - H) });
  prRun('r2', merged(3 * D));
  prRun('r3', settledAt(20 * D, true));
  prRun('r4', { state: 'closed_unmerged', merged_at: null, settled_at: iso(NOW - D) });
  prRun('r5', { state: 'merged', settled_at: iso(NOW - D), survived: true });
  const r = listDraftPrs(db, 50, NOW);
  expect(r).toMatchObject({ total: 5, unsettled: 3, closed_unmerged: 1,
    by_settlement: { OPEN_BLOCKED: 2, MERGED_SURVIVAL_PENDING: 1, SETTLED_SURVIVED: 1, SETTLED_REGRESSED: 0, PIPELINE_ANOMALY: 1 } });
  const row = r.rows.find((x) => x.run_id === 'r2')!;
  expect(row).toMatchObject({ outcome: 'merged', settlement: 'MERGED_SURVIVAL_PENDING', settlement_age_days: 3, age_days: 30 }); // GitHub state and settlement separate
});

describe('per-poll counts are persisted (observe only)', () => {
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' } as NodeJS.ProcessEnv;
  const cycles = () => (db.prepare("SELECT decision, state_hash, answers_json FROM judgments WHERE judgment = 'merge_survival_poll' ORDER BY created_at").all() as Array<{ decision: string; state_hash: string; answers_json: string }>)
    .map((r) => ({ ...JSON.parse(r.answers_json) as Record<string, unknown>, decision: r.decision, state_hash: r.state_hash }));

  it('one row per cycle: considered, selected, skipped, updated, settled, anomalous and API failures by status', async () => {
    fresh();
    prRun('r1', null); prRun('r2', null); prRun('r3', null);
    prRun('r4', null, iso(NOW - 90 * D)); // outside the v1 scan window: considered, not selected
    db.prepare("UPDATE loop_runs SET metadata = json_set(metadata, '$.pr_url', 'https://github.com/o/r/issues/9') WHERE id = 'r3'").run(); // no PR number
    const before = db.prepare("SELECT metadata FROM loop_runs WHERE id = 'r4'").get();
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/pulls/2') ? { ok: false, status: 403, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: null }) })) as unknown as typeof fetch; // r1: closed unmerged
    expect(await checkLoopPrs(db, fetchImpl, env, new Date(NOW))).toEqual({ checked: 1, settled: 1 });
    const [c] = cycles();
    expect(c).toMatchObject({ decision: 'recorded', state_hash: 'msv:1', version: 1, considered: 4, selected: 3, skipped: 2, updated: 1, settled: 1, anomalous: 0, api_failures: { 403: 1 } });
    expect(c.cycle_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.prepare("SELECT metadata FROM loop_runs WHERE id = 'r4'").get()).toEqual(before); // historical rows untouched
  });

  it('an updated row whose evidence is inconsistent counts as anomalous by reason', async () => {
    fresh(); prRun('r1', null);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ state: 'weird', merged_at: null }) })) as unknown as typeof fetch;
    await checkLoopPrs(db, fetchImpl, env, new Date(NOW));
    // GitHub 'weird' is recorded as open by the poller (unchanged behaviour), which is consistent → not anomalous
    expect(cycles()[0]).toMatchObject({ updated: 1, anomalous: 0 });
    fresh(); prRun('r1', null);
    const overdue = vi.fn(async (url: string) => (/pulls\/\d+$/.test(url) ? { ok: true, status: 200, json: async () => ({ state: 'closed', merged_at: iso(NOW - 20 * D) }) }
      : { ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch; // files/commits fail: survival unknown, check overdue
    await checkLoopPrs(db, overdue, env, new Date(NOW));
    expect(cycles()[0]).toMatchObject({ updated: 1, anomalous: 1, anomalies: { survival_check_overdue: 1 }, api_failures: { 502: 2 } });
  });

  it('a thrown call is counted and the cycle still recorded; missing credentials are recorded as a disabled cycle', async () => {
    fresh(); prRun('r1', null);
    const boom = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(checkLoopPrs(db, boom, env, new Date(NOW))).rejects.toThrow('ECONNRESET');
    expect(cycles()[0]).toMatchObject({ decision: 'error', api_failures: { threw: 1 }, updated: 0 });
    fresh();
    await checkLoopPrs(db, boom, {} as NodeJS.ProcessEnv, new Date(NOW));
    expect(cycles()[0]).toMatchObject({ decision: 'recorded', disabled: 'GITHUB_REPOSITORY/GITHUB_TOKEN missing' });
  });
});
