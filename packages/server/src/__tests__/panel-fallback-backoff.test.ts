// Gap from #887: with PANEL_FALLBACK_RUNTIME=claude, a Claude subscription usage limit had no backoff — every tick re-spawned
// `claude -p`, which failed at once and burned Max limits. Now one shared Claude subscription backoff
// (SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS, default 5 h) covers the gym species, the production fallback leases and the panel.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { callClaudePanel, SelfImprovementAgentReviewService, type SpawnFn } from '../services/self-improvement-agent-review-service';
import { claudeSubscriptionBackoff, inLimitBackoff, LIMIT_HIT, recordSubscriptionLimit } from '../services/subscription-gym';
import { fallbackRefusal, panelInferenceStatus } from '../services/ollama-outage-fallback';
import { noteOllamaOutput } from '../services/inference-failover';
import { detectStallsWithHealth } from '../services/stall-watch';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const VALID = JSON.stringify({ stance: 'support', confidence: 0.8, findings: ['bounded change'], evidence_refs: ['context:rationale'] });
const LIMIT_OUT = JSON.stringify({ type: 'result', is_error: true, result: "Claude AI usage limit reached|1760000000" });
const dbs: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dbs.splice(0)) d.close(); });

function setup() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); dbs.push(db);
  const panel = new SpecialistPanelService(db).createPanel({ topic: 'T', question: 'Q?', risk_class: 'low', specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'si' }, context: { description: 'd', rationale: 'r' } });
  vi.stubEnv('PANEL_FALLBACK_RUNTIME', 'claude'); vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', 'claude'); vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { db, panel };
}
/** A fake `claude -p` child answering with `out` (exit `code`). */
function fakeClaude(out: () => { stdout: string; code: number }) {
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      stdin: { end: () => { setImmediate(() => { const o = out(); child.stdout.emit('data', o.stdout); child.emit('close', o.code); }); } } });
    return child;
  });
}
const service = (db: Database.Database, spawnFn: ReturnType<typeof fakeClaude>) => new SelfImprovementAgentReviewService(db, async () => VALID,
  { callFallback: (p, m, u) => callClaudePanel(p, m, u, { spawnFn: spawnFn as unknown as SpawnFn, env: process.env }) });
const verdictRows = (db: Database.Database) => ({
  reviews: (db.prepare('SELECT COUNT(*) AS n FROM specialist_reviews').get() as { n: number }).n,
  quarantine: (db.prepare('SELECT COUNT(*) AS n FROM specialist_review_quarantine').get() as { n: number }).n,
  closed: new SpecialistPanelService(db).closedSeats((db.prepare('SELECT id FROM specialist_panels').get() as { id: string }).id).size,
});

describe('PANEL_FALLBACK_RUNTIME under the shared Claude subscription backoff', () => {
  it('a limit error sets the backoff; the next ticks never spawn; no verdict, quarantine or closed seat (E2)', async () => {
    const { db, panel } = setup();
    const spawnFn = fakeClaude(() => ({ stdout: LIMIT_OUT, code: 1 }));
    const svc = service(db, spawnFn);
    await svc.reviewMissingSpecialists(panel.id, 'run-1');
    expect(spawnFn).toHaveBeenCalledTimes(1); // the first seat hit the limit; the second seat already waits
    expect(claudeSubscriptionBackoff(db)).toMatchObject({ source: 'panel_review' });
    for (let i = 2; i < 6; i++) await svc.reviewMissingSpecialists(panel.id, `run-${i}`);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(verdictRows(db)).toEqual({ reviews: 0, quarantine: 0, closed: 0 });
    expect(panelInferenceStatus(db)).toMatchObject({ status: 'inference_unavailable', backoff: { source: 'panel_review' } });
  });

  it('backoff expiry: the seat spawns claude again and is answered', async () => {
    const { db, panel } = setup();
    recordSubscriptionLimit(db, 'panel_review', new Date(Date.now() - 5 * 3_600_000 - 60_000)); // just past the default 5 h
    expect(claudeSubscriptionBackoff(db)).toBeNull();
    const spawnFn = fakeClaude(() => ({ stdout: JSON.stringify({ type: 'result', is_error: false, result: VALID, usage: { input_tokens: 1, output_tokens: 1 } }), code: 0 }));
    const updated = await service(db, spawnFn).reviewMissingSpecialists(panel.id, 'run-1');
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(updated.reviews).toHaveLength(2);
    expect(panelInferenceStatus(db).status).toBe('available');
  });

  it('SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS sets the window', () => {
    const { db } = setup();
    recordSubscriptionLimit(db, 'panel_review', new Date(Date.now() - 10 * 60_000));
    expect(claudeSubscriptionBackoff(db)).not.toBeNull();
    vi.stubEnv('SUBSCRIPTION_GYM_LIMIT_BACKOFF_MS', String(5 * 60_000));
    expect(claudeSubscriptionBackoff(db)).toBeNull();
  });

  it('one backoff: a panel hit benches the claude gym species and production fallback leases (codex untouched)', () => {
    const { db } = setup();
    expect(fallbackRefusal(db)).toBeNull();
    recordSubscriptionLimit(db, 'panel_review');
    expect(inLimitBackoff(db, 'claude')).toBe(true);
    expect(inLimitBackoff(db, 'codex')).toBe(false);
    expect(fallbackRefusal(db)).toBe(LIMIT_HIT);
  });

  it('one backoff: a production fallback lease hit or a claude gym hit keeps the panel from spawning', async () => {
    for (const hit of ['lease', 'gym'] as const) {
      const { db, panel } = setup();
      db.pragma('foreign_keys = OFF');
      if (hit === 'lease') db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('l1', 'r1', 'maker', 'claude', 'failed', ?)")
        .run(JSON.stringify({ runtime_fallback: { from: 'opencode', to: 'claude' }, failure_reason: LIMIT_HIT, subscription_limit_hit_at: new Date().toISOString() }));
      else db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, repository_path, metadata, created_at) VALUES ('g1', 'evolution-gym', 'closed', 'failed', '/r', ?, ?)")
        .run(JSON.stringify({ gym: { species: 'claude', subscription: 1 }, gym_result: { status: 'discarded', reason: LIMIT_HIT } }), new Date().toISOString());
      expect(claudeSubscriptionBackoff(db)?.source).toBe(hit === 'lease' ? 'runtime_fallback' : 'gym');
      noteOllamaOutput(db, 'you have reached your weekly usage limit', 'test'); // auto-failover off: classified only
      const spawnFn = fakeClaude(() => ({ stdout: VALID, code: 0 }));
      await service(db, spawnFn).reviewMissingSpecialists(panel.id, 'run-1'); // OLLAMA_OUTAGE_FALLBACK_RUNTIME=claude → fallback path
      expect(spawnFn).not.toHaveBeenCalled();
      expect(verdictRows(db)).toEqual({ reviews: 0, quarantine: 0, closed: 0 });
    }
  });

  it('stall-watch and evidence report the panel as inference_unavailable; nothing while the fallback is not needed', () => {
    const { db } = setup();
    expect(detectStallsWithHealth(db, Date.now(), process.env).detectors.find((d) => d.name === 'inference_unavailable')?.status).toBe('ok');
    recordSubscriptionLimit(db, 'runtime_fallback_test');
    const stall = detectStallsWithHealth(db, Date.now(), process.env).stalls.find((s) => s.subsystem === 'inference_unavailable');
    expect(stall?.detail).toMatch(/backoff until/);
    expect(buildEvolutionEvidence(db, process.env).inference.panel_fallback).toMatchObject({ status: 'inference_unavailable', backoff: { source: 'runtime_fallback_test' } });
    vi.stubEnv('OLLAMA_OUTAGE_FALLBACK_RUNTIME', ''); // Ollama fine and the panel itself never hit the limit: available
    expect(panelInferenceStatus(db).status).toBe('available');
    vi.stubEnv('PANEL_FALLBACK_RUNTIME', '');
    expect(panelInferenceStatus(db)).toEqual({ status: 'off', backoff: null });
    expect(detectStallsWithHealth(db, Date.now(), process.env).detectors.find((d) => d.name === 'inference_unavailable')?.status).toBe('not_applicable');
  });
});
