import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { ensureCreditTable } from '../services/outcome-attribution';
import { ensurePowerTable } from '../services/resource-ledger';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import {
  buildValueAllocation, EXPLORATION_FLOOR, LEARNER_READ_JUDGMENTS, proposeAction, runValueAllocation, valueAllocatorMode, type AllocationRow, type WindowStats,
} from '../services/value-allocator';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
let db: Database.Database;
let seq = 0;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); ensureCreditTable(db); new SkillEvolutionEngine(db); seq = 0; });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const call = (purpose: string, opts: { tin?: number | null; tout?: number | null; shadow?: number; consumer?: string; model?: string } = {}) =>
  db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, provider, shadow, tokens_in, tokens_out, purpose, created_at) VALUES (?, ?, 1, 'litellm', ?, ?, ?, ?, ?)`)
    .run(opts.consumer ?? 'svc', opts.model ?? 'gpt-x', opts.shadow ?? 0, opts.tin === undefined ? 100 : opts.tin, opts.tout === undefined ? 50 : opts.tout, purpose, iso(NOW - DAY));
const judgment = (name: string, mode: string, opts: { model?: string | null; tin?: number; tout?: number; decision?: string; subjectType?: string; at?: number } = {}) =>
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, input_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, 'h', ?, ?, ?, ?, ?, ?)`)
    .run(`j-${++seq}`, name, opts.subjectType ?? 's', `sub-${seq}`, mode, opts.decision ?? 'yes', opts.tin ?? 0, opts.tout ?? 0, opts.model === undefined ? 'jev-model' : opts.model, iso(opts.at ?? NOW - DAY));
/** survived: a merge outcome settled 2 days ago (the PR merged ≥ 14 d before); credited: an outcome_credits maker row now */
function makerRun(opts: { tokens?: number | null; credited?: boolean; survived?: boolean; model?: string; runtime?: string; meta?: Record<string, unknown> } = {}) {
  const run = `run-${++seq}`;
  const meta = opts.survived ? { pr_url: `https://github.com/djimit/djimitflo/pull/${seq}`, pr_outcome: { state: 'merged', merged_at: iso(NOW - 20 * DAY), settled_at: iso(NOW - 2 * DAY), survived: true } } : {};
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'test-gap', 'closed', 'completed', ?, ?, ?)")
    .run(run, JSON.stringify(meta), iso(NOW - 25 * DAY), iso(NOW - DAY));
  const leaseMeta = { model: opts.model ?? 'm1', ...(opts.tokens === null ? {} : { token_accounting: { total_tokens: opts.tokens ?? 1000 } }), ...opts.meta };
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', ?, 'completed', ?, ?, ?)")
    .run(`l-${seq}`, run, opts.runtime ?? 'opencode', JSON.stringify(leaseMeta), iso(NOW - DAY), iso(NOW - DAY));
  if (opts.survived) mergeOutcome(run, 1);
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'outcome_attribution', 'loop_run', ?, 'h', 'annotation', ?, 'x', ?)`)
    .run(`oa-${seq}`, run, opts.credited ? 'verified' : 'maker_failure', iso(NOW - DAY));
  if (opts.credited) db.prepare("INSERT INTO outcome_credits (run_id, kind, ref, created_at) VALUES (?, 'maker', ?, ?)").run(run, `${opts.runtime ?? 'opencode'}@${opts.model ?? 'm1'}`, iso(NOW - DAY));
  return run;
}
function mergeOutcome(run: string, success: 0 | 1, at = NOW - 2 * DAY) {
  db.prepare(`INSERT INTO skill_outcomes (id, skill_id, agent_id, task_id, success, tokens_used, duration_ms, domain, evidence_refs_json, created_at)
    VALUES (?, 'loop-maker:merge:opencode', 'a', ?, ?, 0, 0, 'merge', '[]', ?)`).run(`so-${++seq}`, run, success, iso(at));
}
const row = (v: ReturnType<typeof buildValueAllocation>, consumer: string) => {
  const r = v.consumers.find((c) => c.consumer === consumer);
  if (!r) throw new Error(`no row ${consumer}: ${v.consumers.map((c) => c.consumer).join(', ')}`);
  return r;
};

describe('value allocator: resources', () => {
  it('NULL token counts are unknown, never 0 (llm calls and maker leases)', () => {
    for (let i = 0; i < 3; i++) call('summarise', { tin: null, tout: null });
    makerRun({ tokens: null }); makerRun({ tokens: null });
    const v = buildValueAllocation(db, NOW, {}, []);
    const llm = row(v, 'llm:summarise');
    expect(llm.w7.tokens).toMatchObject({ cloud: null, known_calls: 0, unknown_calls: 3 });
    expect(llm.w7.class).toBe('UNKNOWN_COST');
    expect(llm.w7.per_m_tokens).toBeNull();
    const maker = row(v, 'maker:opencode@m1');
    expect(maker.w7.tokens.cloud).toBeNull();
    expect(maker.w7.tokens.unknown_calls).toBe(2);
    expect(maker.w7.class).toBe('UNKNOWN_COST');
  });

  it('P0-7: a maker lease the engine ran on a fallback runtime is the effective runtime\'s consumer, not the requested one', () => {
    makerRun({ meta: { requested_runtime: 'opencode', effective_runtime: 'claude', effective_model: null } });
    makerRun({ meta: { effective_runtime: 'opencode', effective_model: 'm1' } }); // no switch: unchanged
    const v = buildValueAllocation(db, NOW, {}, []);
    expect(row(v, 'maker:opencode@m1').w7.runs).toBe(1);
    expect(v.consumers.filter((c) => c.consumer.startsWith('maker:claude')).map((c) => c.w7.runs)).toEqual([1]);
  });

  it('a judgment model row with 0 + 0 tokens is unknown; a row without a model made no model call', () => {
    judgment('risk_atomic', 'annotation', { tin: 0, tout: 0 });
    judgment('stall_rule', 'annotation', { model: null });
    const v = buildValueAllocation(db, NOW, {}, []);
    expect(row(v, 'judgment:risk_atomic').w7.tokens).toMatchObject({ cloud: null, unknown_calls: 1 });
    expect(row(v, 'judgment:stall_rule').w7.tokens).toMatchObject({ cloud: 0, basis: 'no_model_call' });
  });

  it('does not count maker mirror rows or un-purposed jev rows twice', () => {
    call('maker:test-gap', { consumer: 'maker' }); call(null as unknown as string, { consumer: 'jev' });
    const v = buildValueAllocation(db, NOW, {}, []);
    expect(v.consumers.filter((c) => c.kind === 'llm_purpose')).toEqual([]);
  });
});

describe('value allocator: value and class', () => {
  it('shadow-only judgments and challenger rows are NO_CONSUMER with value 0 by design; annotation is not', () => {
    for (let i = 0; i < 3; i++) judgment('commons_idea', 'shadow', { tin: 300, tout: 20 });
    judgment('proposal_prescreen@qwen', 'shadow', { tin: 300, tout: 20 });
    judgment('reflection_triage', 'annotation', { tin: 300, tout: 20 });
    const v = buildValueAllocation(db, NOW, {}, []);
    const shadow = row(v, 'judgment:commons_idea');
    expect(shadow.consumer_status).toBe('no_consumer');
    expect(shadow.w7.class).toBe('NO_CONSUMER');
    expect(shadow.w7.value).toMatchObject({ units: 0, verified: 0 });
    expect(shadow.proposal.action).toBe('pause');
    expect(row(v, 'judgment:proposal_prescreen@qwen').w7.class).toBe('EXPERIMENT'); // JEV-114 challenger (d)
    const annotation = row(v, 'judgment:reflection_triage');
    expect(annotation.w7.class).not.toBe('NO_CONSUMER');
    expect(annotation.w7.value.units).toBeNull(); // unknown, not 0
  });

  it('all-shadow llm purposes are NO_CONSUMER; live ones without an attribution path are INSUFFICIENT, value unknown', () => {
    call('panel_review:shadow', { shadow: 1 }); call('panel_review:review');
    const v = buildValueAllocation(db, NOW, {}, []);
    expect(row(v, 'llm:panel_review:shadow').w7.class).toBe('NO_CONSUMER');
    const live = row(v, 'llm:panel_review:review');
    expect(live.w7.class).toBe('INSUFFICIENT');
    expect(live.w7.value.units).toBeNull();
  });

  it('credits verified ×1 and merge-survived ×3; VALUE_PROVEN needs volume, NO_VALUE needs ≥ 20 runs with zero value', () => {
    makerRun({ credited: true, survived: true }); makerRun({ credited: true });
    for (let i = 0; i < 4; i++) makerRun();
    for (let i = 0; i < 20; i++) makerRun({ model: 'm2' });
    for (let i = 0; i < 3; i++) makerRun({ model: 'm3' });
    const v = buildValueAllocation(db, NOW, {}, []);
    const m1 = row(v, 'maker:opencode@m1');
    expect(m1.w7.value).toMatchObject({ verified: 2, survived: 1, units: 2 * 1 + 1 * 3 });
    expect(m1.w7.runs).toBe(6);
    expect(m1.w7.class).toBe('VALUE_PROVEN');
    expect(m1.w7.per_m_tokens?.low).not.toBeNull();
    expect(row(v, 'maker:opencode@m2').w7.class).toBe('NO_VALUE');
    expect(row(v, 'maker:opencode@m2').proposal.action).toBe('reduce_cap');
    expect(row(v, 'maker:opencode@m3').w7.class).toBe('INSUFFICIENT');
  });

  it('without attribution recorded in the window, maker value is unknown (INSUFFICIENT), never NO_VALUE', () => {
    for (let i = 0; i < 25; i++) makerRun();
    db.prepare("DELETE FROM judgments WHERE judgment = 'outcome_attribution'").run();
    const m = row(buildValueAllocation(db, NOW, {}, []), 'maker:opencode@m1');
    expect(m.w7.value.units).toBeNull();
    expect(m.w7.class).toBe('INSUFFICIENT');
  });

  it('a non-enforce judgment has no credit path: value unknown even with attribution recorded, never NO_VALUE', () => {
    makerRun({ credited: true });
    for (let i = 0; i < 25; i++) judgment('outcome_review', 'annotation', { model: null });
    const r = row(buildValueAllocation(db, NOW, {}, []), 'judgment:outcome_review');
    expect(r.w7.value.units).toBeNull();
    expect(r.w7.class).toBe('INSUFFICIENT');
  });

  it('P0-11: consumption comes from the gate registry, not the mode label', () => {
    for (let i = 0; i < 3; i++) judgment('telegram_access', 'enforce', { model: null }); // audit of the gate's own decision
    for (let i = 0; i < 3; i++) judgment('content_safety', 'shadow', { subjectType: 'kb_page', decision: 'no', model: 'nemotron' }); // KB ingest deletes on these
    for (let i = 0; i < 3; i++) judgment('content_safety', 'shadow', { subjectType: 'social_reply', model: 'nemotron' }); // record-only
    for (let i = 0; i < 3; i++) judgment('commons_contribution', 'shadow');
    const v = buildValueAllocation(db, NOW, {}, []);
    expect(row(v, 'judgment:telegram_access').consumer_status).not.toBe('decision_consumed');
    expect(row(v, 'judgment:content_safety').consumer_status).toBe('decision_consumed');
    expect(row(v, 'judgment:content_safety').w7.value.decision_consumed).toBe(3); // only the KB rows
    expect(row(v, 'judgment:commons_contribution').consumer_status).toBe('no_consumer'); // thread gate off
    const on = buildValueAllocation(db, NOW, { COMMONS_THREAD_GATE_ENABLED: 'true' }, []);
    expect(row(on, 'judgment:commons_contribution').consumer_status).toBe('decision_consumed'); // threadGated reads shadow rows
  });

  it('an enforce-mode judgment is decision-consumed: VALUE_PROVEN and a hard floor', () => {
    for (let i = 0; i < 3; i++) judgment('proposal_prescreen', 'enforce', { tin: 400, tout: 30 });
    const r = row(buildValueAllocation(db, NOW, {}, []), 'judgment:proposal_prescreen');
    expect(r.consumer_status).toBe('decision_consumed');
    expect(r.w7.value.decision_consumed).toBe(3);
    expect(r.w7.class).toBe('VALUE_PROVEN');
    expect(r.hard_floor).toMatch(/gate/);
  });
});

describe('value allocator: proposals', () => {
  const stats = (cls: WindowStats['class'], extra: Partial<WindowStats> = {}): Pick<WindowStats, 'class' | 'per_m_tokens' | 'tokens' | 'energy'> => ({
    class: cls, per_m_tokens: null, tokens: { cloud: 1e6, local: 0, known_calls: 10, unknown_calls: 0, coverage: 1, basis: 'reported' },
    energy: { wh: null, status: 'no_local_jobs', gpu_seconds: 0 }, ...extra });

  it('hard floors are never proposed for reduction or pause', () => {
    for (let i = 0; i < 3; i++) judgment('deploy_check', 'shadow', { tin: 500, tout: 50 });
    for (let i = 0; i < 3; i++) judgment('security_review', 'shadow', { tin: 500, tout: 50 });
    for (let i = 0; i < 3; i++) call('content_safety:prompt_gate', { shadow: 1 });
    const v = buildValueAllocation(db, NOW, {}, ['merge_survival', 'stall_watch', 'auth_rotation']);
    const floors = v.consumers.filter((c) => c.hard_floor);
    expect(floors.map((c) => c.consumer).sort()).toEqual(['judgment:deploy_check', 'judgment:security_review', 'llm:content_safety:prompt_gate',
      'scheduler:auth_rotation', 'scheduler:merge_survival', 'scheduler:stall_watch']);
    for (const c of floors) { expect(c.proposal.action).toBe('keep'); expect(c.proposal.share).toBeGreaterThanOrEqual(1); }
    for (const cls of ['NO_VALUE', 'NO_CONSUMER', 'VALUE_PROVEN'] as const) {
      const p = proposeAction({ consumer_status: 'unknown', hard_floor: 'stall watch',
        w7: stats(cls, { per_m_tokens: { value: 0.001, low: 0, high: 0.002, n: 50 } }) }, 10);
      expect(p.action).toBe('keep');
    }
  });

  it('never proposes below the exploration floor for VALUE_PROVEN or INSUFFICIENT', () => {
    const p = proposeAction({ consumer_status: 'consumed', hard_floor: null, w7: stats('VALUE_PROVEN', { per_m_tokens: { value: 0.001, low: 0.0001, high: 0.002, n: 40 } }) }, 10);
    expect(p).toMatchObject({ action: 'keep', share: 1 }); // (a) VALUE_PROVEN below the peer median is kept, never reduced
    const better = proposeAction({ consumer_status: 'consumed', hard_floor: null, w7: stats('VALUE_PROVEN', { per_m_tokens: { value: 30, low: 20, high: 40, n: 40 } }) }, 10);
    expect(better.action).toBe('raise_share');
    const insufficient = proposeAction({ consumer_status: 'unknown', hard_floor: null, w7: stats('INSUFFICIENT') }, 10);
    expect(insufficient.share).toBeGreaterThanOrEqual(EXPLORATION_FLOOR);
    expect(insufficient.action).toBe('keep');
  });

  it('UNKNOWN_COST is kept (nothing to weigh), not reduced', () => {
    const p: AllocationRow['proposal'] = proposeAction({ consumer_status: 'unknown', hard_floor: null, w7: stats('UNKNOWN_COST') }, null);
    expect(p).toMatchObject({ action: 'keep', share: 1 });
  });
});

describe('value allocator: daily judgment and endpoint', () => {
  it('is off by default and writes one shadow value_allocation row per UTC day', () => {
    expect(valueAllocatorMode({})).toBe('off');
    expect(runValueAllocation(db, NOW, {}, [])).toBeNull();
    judgment('commons_idea', 'shadow', { tin: 300, tout: 20 });
    const env = { VALUE_ALLOCATOR_MODE: 'shadow' };
    const a = runValueAllocation(db, NOW, env, []);
    const b = runValueAllocation(db, NOW + 3_600_000, env, []);
    expect(b).toBe(a);
    const rows = db.prepare("SELECT mode, decision, answers_json FROM judgments WHERE judgment = 'value_allocation'").all() as Array<{ mode: string; decision: string; answers_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('shadow');
    expect(JSON.parse(rows[0].answers_json).consumers.length).toBeGreaterThan(0);
    runValueAllocation(db, NOW + DAY, env, []);
    expect((db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'value_allocation'").get() as { n: number }).n).toBe(2);
  });

  it('GET /api/health/value-allocation: 404 when off, manage:config when shadow', async () => {
    const auth = new AuthService(db);
    const admin = auth.generateToken(auth.createUser('va-admin@example.test', 'disposable-password', UserRole.ADMIN));
    const viewer = auth.generateToken(auth.createUser('va-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    const http = express().use('/api/health', createHealthRoutes(db, createAuthMiddleware(auth)));
    judgment('commons_idea', 'shadow', { tin: 300, tout: 20 });
    vi.stubEnv('VALUE_ALLOCATOR_MODE', 'off');
    expect((await request(http).get('/api/health/value-allocation').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    vi.stubEnv('VALUE_ALLOCATOR_MODE', 'shadow');
    expect((await request(http).get('/api/health/value-allocation')).status).toBe(401);
    expect((await request(http).get('/api/health/value-allocation').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    const res = await request(http).get('/api/health/value-allocation').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('shadow');
    expect(res.body.consumers.find((c: { consumer: string }) => c.consumer === 'judgment:commons_idea').w7.class).toBe('NO_CONSUMER');
  });

  it('VALUE_ALLOCATOR_MODE is a non-acting evolution flag', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'VALUE_ALLOCATOR_MODE', acting: false });
  });
});

describe('value allocator: prod 20-10 defects', () => {
  const stats = (cls: WindowStats['class']): Pick<WindowStats, 'class' | 'per_m_tokens' | 'tokens' | 'energy'> => ({
    class: cls, per_m_tokens: null, tokens: { cloud: 1e6, local: 0, known_calls: 10, unknown_calls: 0, coverage: 1, basis: 'reported' },
    energy: { wh: null, status: 'no_local_jobs', gpu_seconds: 0 } });

  it('(a) a consumer VALUE_PROVEN in either window is never paused or reduced (keep or raise only)', () => {
    // prescreen read by the gate (enforce) 20 days ago, shadow-only in the last 7 days, with measured tokens
    for (let i = 0; i < 6; i++) judgment('proposal_prescreen', 'enforce', { tin: 400, tout: 30, at: NOW - 20 * DAY });
    for (let i = 0; i < 6; i++) judgment('proposal_prescreen', 'shadow', { tin: 400, tout: 30 });
    const r = row(buildValueAllocation(db, NOW, {}, []), 'judgment:proposal_prescreen');
    expect(r.w30.class).toBe('VALUE_PROVEN');
    expect(['keep', 'raise_share']).toContain(r.proposal.action);
    expect(r.proposal.share).toBeGreaterThanOrEqual(1);
    for (const w7 of ['NO_CONSUMER', 'NO_VALUE', 'VALUE_PROVEN'] as const) {
      const p = proposeAction({ consumer_status: 'unknown', hard_floor: null, w7: { ...stats(w7), per_m_tokens: { value: 0.001, low: 0, high: 0.002, n: 50 } }, w30: { class: 'VALUE_PROVEN' } }, 10);
      expect(['keep', 'raise_share']).toContain(p.action);
    }
  });

  it('(b) a merged PR that survived 14 d credits ×3 to the maker that made it (lease, effective runtime) and its credited judgments, superseded closes left out', () => {
    for (let i = 0; i < 5; i++) makerRun({ credited: true, survived: true });
    const fallback = makerRun({ survived: true, meta: { effective_runtime: 'claude', effective_model: 'sonnet' } });
    db.prepare("INSERT INTO outcome_credits (run_id, kind, ref, created_at) VALUES (?, 'judgment', 'proposal_prescreen', ?)").run(fallback, iso(NOW - 20 * DAY));
    for (let i = 0; i < 3; i++) judgment('proposal_prescreen', 'enforce', { tin: 400, tout: 30 });
    const v = buildValueAllocation(db, NOW, {}, []);
    const m1 = row(v, 'maker:opencode@m1');
    expect(m1.w7.value).toMatchObject({ verified: 5, survived: 5, units: 5 + 5 * 3 });
    expect(m1.w7.class).toBe('VALUE_PROVEN');
    expect(row(v, 'maker:claude@sonnet').w7.value.survived).toBe(1);
    expect(row(v, 'judgment:proposal_prescreen').w7.value.survived).toBe(1);
    // without any merge verdict settled in the window, survived is unknown (null), never 0
    db.prepare("DELETE FROM skill_outcomes WHERE domain = 'merge'").run();
    expect(row(buildValueAllocation(db, NOW, {}, []), 'maker:opencode@m1').w7.value).toMatchObject({ verified: 5, survived: null, units: 5 });
  });

  it('(b) a superseded closed-unmerged merge outcome is no verdict', () => {
    const run = makerRun({ credited: true });
    const prop = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
      VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`);
    prop.run('p-o', 'proposed', '[]', iso(NOW), iso(NOW));
    prop.run('p-c', 'verified', JSON.stringify(['requeue-of:p-o']), iso(NOW), iso(NOW));
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g-o', 'o', 'low', 'completed', '{}', 'p-o', ?, ?)").run(iso(NOW), iso(NOW));
    db.prepare("UPDATE loop_runs SET goal_id = 'g-o', metadata = ? WHERE id = ?").run(JSON.stringify({ pr_outcome: { state: 'closed_unmerged' } }), run);
    mergeOutcome(run, 0);
    expect(row(buildValueAllocation(db, NOW, {}, []), 'maker:opencode@m1').w7.value.survived).toBeNull(); // no verdict settled
    db.prepare("DELETE FROM self_improvements WHERE id = 'p-c'").run(); // no successor: a genuine rejection, a scored 0
    expect(row(buildValueAllocation(db, NOW, {}, []), 'maker:opencode@m1').w7.value.survived).toBe(0);
  });

  it('(c) a remote maker: energy from its claimed→finished window on the claiming host; < 90 % sampled = null energy, classified on 0 cloud tokens', () => {
    const model = 'workstation/atomic@llama-router';
    const runs = Array.from({ length: 6 }, () => makerRun({ runtime: 'remote', model, tokens: null, credited: true }));
    db.exec(`CREATE TABLE IF NOT EXISTS remote_maker_jobs (id TEXT PRIMARY KEY, host TEXT NOT NULL, species TEXT NOT NULL, base_commit TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', patch TEXT, reason TEXT, created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT)`);
    ensurePowerTable(db);
    const start = NOW - 2 * DAY;
    runs.forEach((_r, k) => db.prepare("INSERT INTO remote_maker_jobs (id, host, species, base_commit, prompt, status, created_at, claimed_at, finished_at) VALUES (?, 'workstation', 'atomic@llama-router', 'b', 'p', 'done', ?, ?, ?)")
      .run(`job-${k}`, iso(start + k * 3_600_000), iso(start + k * 3_600_000), iso(start + k * 3_600_000 + 600_000)));
    // samples every 30 s over the first job only: 1 of 6 jobs measured (< 90 %)
    for (let t = start - 60_000; t <= start + 660_000; t += 30_000) db.prepare("INSERT INTO host_power_samples (host, at, gpu_watts) VALUES ('workstation', ?, 200)").run(iso(t));
    const partial = row(buildValueAllocation(db, NOW, {}, []), `maker:remote@${model}`);
    expect(partial.w7.tokens.cloud).toBe(0);
    expect(partial.w7.tokens.local).toBeNull();
    expect(partial.w7.energy.wh).toBeNull();
    expect(partial.w7.energy.gpu_seconds).toBe(6 * 600);
    expect(partial.w7.class).toBe('VALUE_PROVEN'); // not UNKNOWN_COST
    expect(partial.w7.reason).toMatch(/energy unknown/);
    // every job sampled: energy measured over the job windows on the claiming host
    for (let k = 1; k < 6; k++) for (let t = start + k * 3_600_000 - 60_000; t <= start + k * 3_600_000 + 660_000; t += 30_000) db.prepare("INSERT INTO host_power_samples (host, at, gpu_watts) VALUES ('workstation', ?, 200)").run(iso(t));
    const full = row(buildValueAllocation(db, NOW, {}, []), `maker:remote@${model}`);
    expect(full.w7.energy.status).toBe('measured');
    expect(full.w7.energy.wh).toBeCloseTo(6 * 200 * (600 / 3600), 0);
  });

  it('(d) challenger rows and arms of a running registry experiment are EXPERIMENT: exempt, keep, stop_by from the registry', () => {
    for (let i = 0; i < 3; i++) judgment('failure_cause@jev-1.14.0', 'shadow', { tin: 300, tout: 20 });
    for (let i = 0; i < 3; i++) call('jev:challenger', { shadow: 1 });
    for (let i = 0; i < 3; i++) judgment('proposal_prescreen', 'shadow', { tin: 300, tout: 20 });
    for (let i = 0; i < 3; i++) judgment('risk_atomic@local', 'shadow', { tin: 300, tout: 20 });
    const env = { TYPESAFE_PROPOSAL_PRESCREEN_MODE: 'shadow' };
    const v = buildValueAllocation(db, NOW, env, []);
    for (const c of ['judgment:failure_cause@jev-1.14.0', 'llm:jev:challenger']) {
      const r = row(v, c);
      expect(r.w7.class).toBe('EXPERIMENT');
      expect(r.experiment).toEqual({ id: 'JEV-114', stop_by: '2027-01-14T00:00:00.000Z' });
      expect(r.proposal).toMatchObject({ action: 'keep', share: 1 });
    }
    expect(row(v, 'judgment:proposal_prescreen').experiment).toEqual({ id: 'D5-NO', stop_by: '2027-01-09T21:00:00.000Z' });
    expect(row(v, 'judgment:proposal_prescreen').proposal.action).toBe('keep');
    expect(row(v, 'judgment:risk_atomic@local').w7.class).toBe('NO_CONSUMER'); // T1 local shadow: not a registry experiment
    expect(v.by_class.EXPERIMENT).toBe(3);
    // flag off → the prescreen is no arm; past stop_by → the challenger is no longer exempt
    expect(row(buildValueAllocation(db, NOW, {}, []), 'judgment:proposal_prescreen').experiment).toBeNull();
    const late = Date.parse('2027-01-20T00:00:00Z');
    for (let i = 0; i < 2; i++) judgment('failure_cause@jev-1.14.0', 'shadow', { tin: 300, tout: 20, at: late - DAY });
    expect(row(buildValueAllocation(db, late, {}, []), 'judgment:failure_cause@jev-1.14.0').w7.class).toBe('NO_CONSUMER');
  });

  it('(e) failure_cause is consumed (dream-state consolidation → memory candidates) only when DREAM_STATE is on', () => {
    for (let i = 0; i < 3; i++) judgment('failure_cause', 'shadow', { tin: 300, tout: 20, decision: 'yes' });
    expect(LEARNER_READ_JUDGMENTS).toHaveProperty('failure_cause');
    const off = row(buildValueAllocation(db, NOW, {}, []), 'judgment:failure_cause');
    expect(off.consumer_status).toBe('no_consumer');
    const on = row(buildValueAllocation(db, NOW, { DREAM_STATE_ENABLED: 'true' }, []), 'judgment:failure_cause');
    expect(on.consumer_status).toBe('consumed');
    expect(on.w7.class).not.toBe('NO_CONSUMER');
    expect(on.w7.value.units).toBeNull(); // a learner has no credit path: unknown, not 0
    expect(on.proposal.action).toBe('keep');
    expect(on.hard_floor).toBeNull();
  });
});
