/**
 * re-20261030 (C-reliability §2b/§3, E-assumptions N4/N5/N7/N12/C5/C6, B-intelligence candidate 3): what the stall watch
 * did not see on 29/30-10, replayed. Report-only detectors: no_oracle_work (the oracle lanes made nothing for 12 h),
 * zero_verified (a maker species finishes attempts but never verifies), deploy:behind_main (main waits for CI unseen,
 * be57e146), PL-001/TG-001 as gym-host activity, and a stall dropped by quiet hours pushed once afterwards.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth, stallWatchTick, type Stall } from '../services/stall-watch';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { gapLaneResults } from '../services/test-gap-source-service';
import { pushStall, setPushSender } from '../services/operator-push';
import { PL_LOOP } from '../services/pl-001';
import { TG_LOOP } from '../services/tg-001';

/** capability chain: a configured environment, so these tests see only the detectors they assert on */
const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); gapLaneResults?.clear(); });
afterEach(() => { gapLaneResults?.clear(); setPushSender(null); db.close(); vi.restoreAllMocks(); });
const T = (iso: string) => Date.parse(iso);
const report = (now: number, env: NodeJS.ProcessEnv) => detectStallsWithHealth(db, now, { ...C, ...env });
const names = (now: number, env: NodeJS.ProcessEnv) => report(now, env).stalls.map((s) => s.subsystem).sort();

let seq = 0;
const proposal = (source: string, refs: string[], createdAt: string, status = 'verified') => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
  VALUES (?, 'feature', 't', 'd', 'r', ?, ?, 0.6, ?, '{}', ?, ?)`).run(`p${++seq}`, source, status, JSON.stringify(refs), createdAt, createdAt);

describe('no_oracle_work: the gap lanes are on but made no proposal in 12 h', () => {
  const LANES = { TEST_GAP_SOURCE_ENABLED: 'true', MUTATION_GAP_ENABLED: 'true' };
  it('replay 10-29T22:36Z → 10-30T10:36Z (no goals): fires after 12 h with the lanes\' last no-candidate reason', () => {
    proposal('gap_analysis', ['test-gap:loop-auto-merge#exports'], '2026-10-29T20:10:00.000Z');
    proposal('gap_analysis', ['mutation-gap:merge-survival'], '2026-10-29T22:36:00.000Z');
    proposal('reflection', ['reflection:x'], '2026-10-30T09:00:00.000Z', 'proposed'); // not oracle work
    gapLaneResults.set('test-gap', { created: 0, skipped: 'no untested candidate', at: '2026-10-30T10:00:00.000Z' });
    gapLaneResults.set('mutation-gap', { created: 0, skipped: 'no candidate', at: '2026-10-30T10:00:00.000Z' });
    expect(names(T('2026-10-30T10:30:00Z'), LANES)).not.toContain('no_oracle_work'); // 11 h 54 min
    const r = report(T('2026-10-30T10:37:00Z'), LANES);
    const s = r.stalls.find((x) => x.subsystem === 'no_oracle_work');
    expect(s).toBeDefined();
    expect(s!.since).toBe('2026-10-29T22:36:00.000Z');
    expect(s!.detail).toContain('0 gap_analysis proposals in 12 h');
    expect(s!.detail).toContain('test-gap: no untested candidate');
    expect(s!.detail).toContain('mutation-gap: no candidate');
    expect(r.health).toBe('BREACHED');
  });

  it('without a recorded reason it still fires (unknown reason); flags off: not applicable', () => {
    proposal('gap_analysis', ['test-gap:x'], '2026-10-29T08:00:00.000Z');
    const now = T('2026-10-30T10:37:00Z');
    expect(report(now, { TEST_GAP_SOURCE_ENABLED: 'true' }).stalls.find((x) => x.subsystem === 'no_oracle_work')?.detail).toContain('no lane result recorded');
    expect(names(now, {})).not.toContain('no_oracle_work');
    expect(report(now, {}).detectors.find((d) => d.name === 'no_oracle_work')?.status).toBe('not_applicable');
    // never a gap proposal at all while a lane is on is a stall too
    db.exec('DELETE FROM self_improvements');
    expect(report(now, { MUTATION_GAP_ENABLED: 'true' }).stalls.find((x) => x.subsystem === 'no_oracle_work')?.since).toBeNull();
  });

  it('a gap proposal in the window, or every lane at its own cap, is not a stall', () => {
    proposal('gap_analysis', ['test-gap:x'], '2026-10-30T00:00:00.000Z');
    expect(names(T('2026-10-30T10:37:00Z'), LANES)).not.toContain('no_oracle_work');
    db.exec('DELETE FROM self_improvements');
    proposal('gap_analysis', ['test-gap:x'], '2026-10-29T20:00:00.000Z');
    gapLaneResults.set('test-gap', { created: 0, skipped: 'daily cap reached', at: '2026-10-30T10:00:00.000Z' });
    gapLaneResults.set('mutation-gap', { created: 0, skipped: 'one in flight', at: '2026-10-30T10:00:00.000Z' });
    const r = report(T('2026-10-30T10:37:00Z'), LANES);
    expect(r.stalls.map((s) => s.subsystem)).not.toContain('no_oracle_work');
    expect(r.detectors.find((d) => d.name === 'no_oracle_work')).toMatchObject({ status: 'capped', detail: expect.stringContaining('daily cap reached') });
  });
});

describe('zero_verified: a maker species finishes ≥ 5 attempts in 72 h and verifies none', () => {
  const NOW = T('2026-10-30T16:00:00Z');
  const outcome = (skill: string, model: string | null, success: 0 | 1, hoursAgo: number, domain = 'doc-drift-and-small-fix-loop') =>
    db.prepare('INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, model, created_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?)')
      .run(`o${++seq}`, skill, success, domain, model, new Date(NOW - hoursAgo * 3_600_000).toISOString());
  it('fires for the remote species (0/19 in 7 d), not for opencode, the gym or below 5 attempts', () => {
    for (let i = 0; i < 6; i++) outcome('loop-maker:doc-drift-and-small-fix-loop:remote', 'workstation/atomic@llama-router', 0, 4 + i * 10);
    outcome('loop-maker:doc-drift-and-small-fix-loop:remote', 'workstation/atomic@llama-router', 1, 80); // a success outside the window
    for (let i = 0; i < 6; i++) outcome('loop-maker:doc-drift-and-small-fix-loop:opencode', 'ollama/glm-5.2:cloud', i % 2 ? 1 : 0, 2 + i);
    for (let i = 0; i < 4; i++) outcome('loop-maker:doc-drift-and-small-fix-loop:codex', null, 0, 2 + i);
    for (let i = 0; i < 8; i++) outcome('loop-maker:gym:remote', 'workstation/atomic@llama-router', 0, 2 + i, 'gym');
    const on = report(NOW, { VALUE_ANOMALY_ALARM: 'on' });
    const z = on.stalls.filter((s) => s.subsystem.startsWith('zero_verified:'));
    expect(z.map((s) => s.subsystem)).toEqual(['zero_verified:maker:remote@workstation/atomic@llama-router']);
    expect(z[0].detail).toContain('0/6');
    expect(z[0].since).toBe(new Date(NOW - 54 * 3_600_000).toISOString());
    // shadow: named in the detector detail, not raised; off: not applicable
    const shadow = report(NOW, { VALUE_ANOMALY_ALARM: 'shadow' });
    expect(shadow.stalls.map((s) => s.subsystem)).not.toContain('zero_verified:maker:remote@workstation/atomic@llama-router');
    expect(shadow.detectors.find((d) => d.name === 'zero_verified')?.detail).toContain('zero_verified:maker:remote@workstation/atomic@llama-router');
    expect(report(NOW, {}).detectors.find((d) => d.name === 'zero_verified')?.status).toBe('not_applicable');
  });
});

describe('deploy:behind_main: the newest main sha has waited > 2 h (be57e146)', () => {
  const RUNNING = 'bab9b131' + '0'.repeat(32); const MAIN = 'be57e146' + '1'.repeat(32);
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-')), 'deploy-log.jsonl');
  const write = (f: string, ...ev: object[]) => fs.writeFileSync(f, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const history = [{ at: '2026-10-30T00:14:00Z', event: 'deploying', sha: RUNNING, detail: 'was x' }, { at: '2026-10-30T00:19:00Z', event: 'done', sha: RUNNING }];
  const waiting = { at: '2026-10-30T00:46:00Z', event: 'waiting', sha: MAIN, detail: 'CI not green: required_missing:build-and-test (22),security-scan' };
  it('fires 2 h after the waiting event; the verdict of the running build written later does not hide it', () => {
    const f = file(); const env = { DJIMITFLO_BUILD_COMMIT: RUNNING, DEPLOY_LOG_PATH: f };
    write(f, ...history, waiting, { at: '2026-10-30T00:39:00Z', event: 'verdict_ok', sha: RUNNING });
    expect(names(T('2026-10-30T02:40:00Z'), env)).not.toContain('deploy:behind_main');
    const s = report(T('2026-10-30T02:47:00Z'), env).stalls.find((x) => x.subsystem === 'deploy:behind_main');
    expect(s).toMatchObject({ since: '2026-10-30T00:46:00Z' });
    expect(s!.detail).toContain('be57e146');
    expect(s!.detail).toContain('required_missing:build-and-test');
    expect(s!.detail).toContain('bab9b131');
    // 16 h later still waiting: still the same stall (since unchanged)
    expect(report(T('2026-10-30T16:30:00Z'), env).stalls.find((x) => x.subsystem === 'deploy:behind_main')?.since).toBe('2026-10-30T00:46:00Z');
  });

  it('clears when that sha deploys, when it runs (a manual deploy), or when main moves on and waits afresh', () => {
    const f = file(); const later = T('2026-10-30T16:30:00Z');
    write(f, ...history, waiting, { at: '2026-10-30T16:00:00Z', event: 'deploying', sha: MAIN });
    expect(names(later, { DJIMITFLO_BUILD_COMMIT: RUNNING, DEPLOY_LOG_PATH: f })).not.toContain('deploy:behind_main');
    write(f, ...history, waiting);
    expect(names(later, { DJIMITFLO_BUILD_COMMIT: MAIN.slice(0, 12), DEPLOY_LOG_PATH: f })).not.toContain('deploy:behind_main');
    write(f, ...history, waiting, { at: '2026-10-30T15:30:00Z', event: 'waiting', sha: 'c'.repeat(40), detail: 'main is 3 min old, settling until 20' });
    expect(names(later, { DJIMITFLO_BUILD_COMMIT: RUNNING, DEPLOY_LOG_PATH: f })).not.toContain('deploy:behind_main');
  });
});

describe('gym: a PL-001 / TG-001 remote run is gym-host activity', () => {
  const NOW = T('2026-10-30T05:00:00Z');
  const env = { EVOLUTION_GYM_REMOTE_ENABLED: 'true', EVOLUTION_GYM_REMOTE_MAX_PER_DAY: '96' };
  const lastGym = () => db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at) VALUES ('g', 'loop-maker:gym:remote', 1, 0, 1, 'gym', '2026-10-29T17:13:00.000Z')").run();
  const remoteRun = (loop: string, at: number) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at) VALUES (?, ?, 'closed', 'completed', ?, ?)")
    .run(`rr${++seq}`, loop, JSON.stringify({ gym: { remote_host: 'workstation', species: 'remote@atomic' } }), new Date(at).toISOString());
  it('PL-only night (10-29T17:13Z → 10-30T06:26Z): no gym stall; the detector names the host work', () => {
    lastGym();
    for (let t = T('2026-10-29T17:30:00Z'); t <= NOW - 10 * 60_000; t += 17 * 60_000) remoteRun(PL_LOOP, t);
    const r = report(NOW, env);
    expect(r.stalls.map((s) => s.subsystem)).not.toContain('gym');
    expect(r.detectors.find((d) => d.name === 'gym')?.detail).toContain(PL_LOOP);
  });
  it('a TG-001 run counts too; a host silent for > 6 h on every loop still stalls', () => {
    lastGym();
    remoteRun(TG_LOOP, NOW - 2 * 3_600_000);
    expect(names(NOW, env)).not.toContain('gym');
    db.exec(`DELETE FROM loop_runs`);
    remoteRun(PL_LOOP, NOW - 7 * 3_600_000);
    expect(names(NOW, env)).toContain('gym');
  });
});

describe('quiet hours: a stall the push dropped is pushed once, at the first tick after', () => {
  // (the djimitsec runtime admission expiring 11-27 is a stall on these dates too: messages are counted per subsystem)
  const alerts: string[] = [];
  const sender = { requestApproval: vi.fn(async () => undefined), broadcastAlert: vi.fn(async (t: string) => { alerts.push(t); }) };
  const pushedOf = (subsystem: string) => alerts.filter((a) => a.startsWith(`Stall: ${subsystem} since `)).length;
  const zombie = (id: string) => {
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, created_at, updated_at) VALUES (?, 'review', 'low', 'running', '2026-10-29T18:00:00Z', '2026-10-29T18:00:00Z')").run(id);
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, goal_id, created_at) VALUES (?, 'repo-maintenance-loop', 'closed', 'completed', ?, '2026-10-29T18:00:00Z')").run(`r-${id}`, id);
  };
  const tick = (iso: string, push: NodeJS.ProcessEnv, detect: NodeJS.ProcessEnv = {}) =>
    stallWatchTick(db, (s: Stall) => pushStall(db, s, push, new Date(iso)), T(iso), { ...C, ...detect });
  const hours = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(T(from) + i * 3_600_000).toISOString());
  beforeEach(() => { alerts.length = 0; setPushSender(sender); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

  it('opened 23:00Z with quiet hours 20–5: nothing until 05:00, then exactly one push', async () => {
    const push = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_QUIET_HOURS: '20-5' };
    zombie('g1');
    for (const t of hours('2026-10-29T23:00:00Z', 6)) await tick(t, push); // 23:00 … 04:00
    expect(alerts).toEqual([]);
    await tick('2026-10-30T05:00:00Z', push);
    expect(pushedOf('goals')).toBe(1);
    for (const t of hours('2026-10-30T06:00:00Z', 3)) await tick(t, push);
    expect(pushedOf('goals')).toBe(1);
  });

  it('a stall that cleared during quiet hours is not pushed afterwards', async () => {
    const push = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_QUIET_HOURS: '20-5' };
    zombie('g1');
    await tick('2026-10-29T23:00:00Z', push);
    db.exec("UPDATE goals SET status = 'completed'");
    await tick('2026-10-30T02:00:00Z', push);
    await tick('2026-10-30T05:00:00Z', push);
    expect(pushedOf('goals')).toBe(0);
  });

  it('stalls dropped by the hourly cap are sent on later ticks, each once', async () => {
    const push = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_PUSH_MAX_PER_HOUR: '1' };
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-')), 'deploy-log.jsonl');
    fs.writeFileSync(f, `${JSON.stringify({ at: '2026-10-30T01:00:00Z', event: 'waiting', sha: 'e'.repeat(40), detail: 'CI not green' })}\n`);
    const detect = { DJIMITFLO_BUILD_COMMIT: 'a'.repeat(40), DEPLOY_LOG_PATH: f };
    zombie('g1');
    await tick('2026-10-30T09:00:00Z', push, detect); // ≥ 2 new stalls, cap 1
    expect(alerts).toHaveLength(1);
    for (const t of hours('2026-10-30T10:01:00Z', 5)) await tick(t, push, detect);
    expect(pushedOf('goals')).toBe(1);
    expect(pushedOf('deploy:behind_main')).toBe(1);
    expect(new Set(alerts).size).toBe(alerts.length);
  });
});
