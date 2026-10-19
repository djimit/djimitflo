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
import {
  buildValueAllocation, EXPLORATION_FLOOR, proposeAction, runValueAllocation, valueAllocatorMode, type AllocationRow, type WindowStats,
} from '../services/value-allocator';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
let db: Database.Database;
let seq = 0;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); ensureCreditTable(db); seq = 0; });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const call = (purpose: string, opts: { tin?: number | null; tout?: number | null; shadow?: number; consumer?: string; model?: string } = {}) =>
  db.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, provider, shadow, tokens_in, tokens_out, purpose, created_at) VALUES (?, ?, 1, 'litellm', ?, ?, ?, ?, ?)`)
    .run(opts.consumer ?? 'svc', opts.model ?? 'gpt-x', opts.shadow ?? 0, opts.tin === undefined ? 100 : opts.tin, opts.tout === undefined ? 50 : opts.tout, purpose, iso(NOW - DAY));
const judgment = (name: string, mode: string, opts: { model?: string | null; tin?: number; tout?: number; decision?: string } = {}) =>
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, input_tokens, output_tokens, model, created_at) VALUES (?, ?, 's', ?, 'h', ?, ?, ?, ?, ?, ?)`)
    .run(`j-${++seq}`, name, `sub-${seq}`, mode, opts.decision ?? 'yes', opts.tin ?? 0, opts.tout ?? 0, opts.model === undefined ? 'jev-model' : opts.model, iso(NOW - DAY));
function makerRun(opts: { tokens?: number | null; credited?: boolean; survived?: boolean; model?: string; meta?: Record<string, unknown> } = {}) {
  const run = `run-${++seq}`;
  const meta = opts.survived ? { pr_url: `https://github.com/djimit/djimitflo/pull/${seq}`, pr_outcome: { state: 'merged', merged_at: iso(NOW - 20 * DAY), settled_at: iso(NOW - 2 * DAY), survived: true } } : {};
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'test-gap', 'closed', 'completed', ?, ?, ?)")
    .run(run, JSON.stringify(meta), iso(NOW - 25 * DAY), iso(NOW - DAY));
  const leaseMeta = { model: opts.model ?? 'm1', ...(opts.tokens === null ? {} : { token_accounting: { total_tokens: opts.tokens ?? 1000 } }), ...opts.meta };
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)")
    .run(`l-${seq}`, run, JSON.stringify(leaseMeta), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'outcome_attribution', 'loop_run', ?, 'h', 'annotation', ?, 'x', ?)`)
    .run(`oa-${seq}`, run, opts.credited ? 'verified' : 'maker_failure', iso(NOW - DAY));
  if (opts.credited) db.prepare("INSERT INTO outcome_credits (run_id, kind, ref, created_at) VALUES (?, 'maker', ?, ?)").run(run, `opencode@${opts.model ?? 'm1'}`, iso(NOW - DAY));
  return run;
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
    expect(row(v, 'judgment:proposal_prescreen@qwen').w7.class).toBe('NO_CONSUMER');
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
    expect(p.action).toBe('reduce_cap');
    expect(p.share).toBe(EXPLORATION_FLOOR);
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
