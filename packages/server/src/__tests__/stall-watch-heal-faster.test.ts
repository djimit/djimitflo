/**
 * re-20261105 (C-reliability §2a/§2d/§3, candidates 1, 3, 6, 7): incidents the stall watch saw late, cleared falsely or not at
 * all, replayed. deploy:behind_main cleared twice on 11-02 while prod stayed behind (a newer sha started waiting); the 10-30
 * content-safety 404 (nemotron retired) took 19.3 h to detect; the low-volume `checker_second_opinion` timeouts never reach the
 * 6 h rule's n ≥ 10; fleet drift is displayed but never alarmed; an outdated host agent is invisible.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { detectStallsWithHealth, stallWatchTick, FLEET_DRIFT_STALL_H } from '../services/stall-watch';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { FleetCommands } from '../services/fleet-commands';
import { MIN_HOST_AGENT_VERSION } from '../routes/host-agent';

/** capability chain: a configured environment, so these tests see only the detectors they assert on */
const C = { DJIMITFLO_SKILLS_DIR: __dirname, DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename };
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); });
afterEach(() => { db.close(); });
const T = (iso: string) => Date.parse(iso);
const report = (now: number, env: NodeJS.ProcessEnv) => detectStallsWithHealth(db, now, { ...C, ...env });
const stall = (now: number, env: NodeJS.ProcessEnv, subsystem: string) => report(now, env).stalls.find((s) => s.subsystem === subsystem);
const tmp = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'heal-')), name);

describe('deploy:behind_main is anchored on the first waiting sha after the last deploy (11-02 replay)', () => {
  // prod ran e196e22c (a manual deploy, not in the log) all day; 3d6770ba (gitleaks red), 7ae1ebf9 (draft-PR flake) and
  // 8280e864 (#1146) each waited in turn; prod caught up at 22:31. Live: opened 13:31, cleared 14:31 (false), opened 16:31,
  // cleared 21:31 (false).
  const RUNNING = 'e196e22c' + '0'.repeat(32);
  const [A, B, D] = ['3d6770ba', '7ae1ebf9', '8280e864'].map((p) => p + '1'.repeat(32));
  const log = [
    { at: '2026-11-02T08:10:00Z', event: 'deploying', sha: 'f'.repeat(40) }, { at: '2026-11-02T08:14:00Z', event: 'done', sha: 'f'.repeat(40) },
    { at: '2026-11-02T08:30:00Z', event: 'verdict_ok', sha: 'f'.repeat(40) },
    { at: '2026-11-02T11:28:00Z', event: 'waiting', sha: A, detail: 'CI not green: failed:gitleaks' },
    { at: '2026-11-02T14:28:00Z', event: 'waiting', sha: B, detail: 'CI not green: failed:build-and-test (22)' },
    { at: '2026-11-02T21:28:00Z', event: 'waiting', sha: D, detail: 'main is 4 min old, settling until 20' },
  ];
  const write = (events: object[]) => { const f = tmp('deploy-log.jsonl'); fs.writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); return f; };

  it('stays open from 13:31 until the deploy at 22:31; a newer sha waiting does not clear it', () => {
    const env = { DJIMITFLO_BUILD_COMMIT: RUNNING, DEPLOY_LOG_PATH: write(log) };
    expect(stall(T('2026-11-02T13:20:00Z'), env, 'deploy:behind_main')).toBeUndefined(); // 1 h 52 min
    for (const tick of ['13:31', '14:31', '16:31', '21:31', '22:20']) {
      const s = stall(T(`2026-11-02T${tick}:00Z`), env, 'deploy:behind_main');
      expect(s, tick).toMatchObject({ since: '2026-11-02T11:28:00Z' });
      expect(s!.detail).toContain('3d6770ba');
      expect(s!.detail).toContain('e196e22c');
    }
    expect(stall(T('2026-11-02T21:31:00Z'), env, 'deploy:behind_main')!.detail).toContain('8280e864'); // the newest held-back sha
  });

  it('clears once a deploy starts, or when prod runs any held-back sha', () => {
    const deployed = [...log, { at: '2026-11-02T22:27:00Z', event: 'deploying', sha: D }, { at: '2026-11-02T22:31:00Z', event: 'done', sha: D }];
    expect(stall(T('2026-11-02T22:40:00Z'), { DJIMITFLO_BUILD_COMMIT: RUNNING, DEPLOY_LOG_PATH: write(deployed) }, 'deploy:behind_main')).toBeUndefined();
    expect(stall(T('2026-11-02T22:40:00Z'), { DJIMITFLO_BUILD_COMMIT: D.slice(0, 12), DEPLOY_LOG_PATH: write(deployed) }, 'deploy:behind_main')).toBeUndefined();
    // a manual deploy of the newest waiting sha (no deploying event): prod is not behind
    expect(stall(T('2026-11-02T22:40:00Z'), { DJIMITFLO_BUILD_COMMIT: D, DEPLOY_LOG_PATH: write(log) }, 'deploy:behind_main')).toBeUndefined();
  });
});

describe('zero_success:llm fires on the last 5 calls of a consumer failing (10-30 content-safety 404 replay)', () => {
  const call = (ok: number, at: string, shadow = 0) => db.prepare("INSERT INTO llm_model_calls (consumer, model, ok, shadow, created_at) VALUES ('content_safety', 'nemotron', ?, ?, ?)").run(ok, shadow, at);
  const VA = { VALUE_ANOMALY_ALARM: 'on' };
  beforeEach(() => {
    // nemotron era: ~60 calls/day ok, the last success at 04:31; from 09:48 every call is an HTTP 404
    for (let h = 5; h <= 28; h++) call(1, new Date(T('2026-10-30T04:31:00Z') - h * 3_600_000).toISOString());
    call(1, '2026-10-30T04:31:00Z');
    for (const t of ['09:48', '10:08', '10:28', '10:48']) call(0, `2026-10-30T${t}:00Z`);
  });

  it('fires at the 5th consecutive failure, since the first failure, although the 24 h window holds a success', () => {
    expect(stall(T('2026-10-30T11:00:00Z'), VA, 'zero_success:llm:content_safety')).toBeUndefined(); // 4 failures
    call(0, '2026-10-30T11:08:00Z');
    const s = stall(T('2026-10-30T11:10:00Z'), VA, 'zero_success:llm:content_safety');
    expect(s).toMatchObject({ since: '2026-10-30T09:48:00Z' });
    expect(s!.detail).toContain('last 5');
  });

  it('a success among the last 5, or only shadow failures, is not a streak', () => {
    call(1, '2026-10-30T11:07:00Z'); call(0, '2026-10-30T11:08:00Z');
    expect(stall(T('2026-10-30T11:10:00Z'), VA, 'zero_success:llm:content_safety')).toBeUndefined();
    db.prepare('DELETE FROM llm_model_calls').run();
    for (const t of ['09:48', '10:08', '10:28', '10:48', '11:08']) call(0, `2026-10-30T${t}:00Z`, 1);
    call(1, '2026-10-30T08:00:00Z');
    expect(stall(T('2026-10-30T11:10:00Z'), VA, 'zero_success:llm:content_safety')).toBeUndefined();
  });

  it('a streak that ended more than 24 h ago is not raised (the consumer is idle, not failing)', () => {
    call(0, '2026-10-30T11:08:00Z');
    expect(stall(T('2026-10-30T11:10:00Z'), VA, 'zero_success:llm:content_safety')).toBeDefined();
    expect(stall(T('2026-10-31T12:00:00Z'), VA, 'zero_success:llm:content_safety')).toBeUndefined();
  });
});

describe('judgments: a second, 24 h rule for low-volume judgments (checker_second_opinion timeouts)', () => {
  const judgment = (name: string, decision: string, at: string, i: number) => db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, ?, 'lease', ?, 'h', 'shadow', ?, 'x', ?)")
    .run(`${name}-${i}`, name, `s${i}`, decision, at);
  const NOW = T('2026-11-04T23:45:00Z');
  it('fires on > 30 % errors over 24 h with n ≥ 10 when the 6 h window is below n = 10', () => {
    // 12 verdicts at 2 h spacing (≤ 3 per 6 h), 4 of them TYPESAFE_FAILED: timeout
    for (let i = 0; i < 12; i++) judgment('checker_second_opinion', i % 3 === 0 ? 'error' : 'yes', new Date(NOW - (i * 2 + 1) * 3_600_000).toISOString(), i);
    const s = stall(NOW, {}, 'judgment:checker_second_opinion');
    expect(s).toMatchObject({ since: new Date(NOW - 24 * 3_600_000).toISOString() });
    expect(s!.detail).toContain('4/12 verdicts were errors in 24 h');
  });

  it('does not fire below n = 10 or at ≤ 30 % errors, nor on a high-volume judgment that recovered in the last 6 h', () => {
    for (let i = 0; i < 9; i++) judgment('few', 'error', new Date(NOW - (i * 2 + 1) * 3_600_000).toISOString(), i);
    for (let i = 0; i < 10; i++) judgment('fine', i < 3 ? 'error' : 'yes', new Date(NOW - (i * 2 + 1) * 3_600_000).toISOString(), i);
    for (let i = 0; i < 20; i++) judgment('recovered', 'error', new Date(NOW - (8 + i * 0.5) * 3_600_000).toISOString(), i);
    for (let i = 0; i < 12; i++) judgment('recovered', 'yes', new Date(NOW - (1 + i * 0.25) * 3_600_000).toISOString(), 100 + i);
    expect(report(NOW, {}).stalls.map((s) => s.subsystem).filter((s) => s.startsWith('judgment:'))).toEqual([]);
  });
});

describe('fleet_drift: a fleet service whose deployed source differs from main for > 24 h', () => {
  const RUNNING = 'c'.repeat(40);
  const file = tmp('fleet-drift.json');
  const env = { DJIMITFLO_COMMIT_SHA: RUNNING, FLEET_DRIFT_PATH: file };
  const check = (at: number, drifting: string[]) => fs.writeFileSync(file, JSON.stringify({ checked_at: new Date(at - 5 * 60_000).toISOString(), commit: RUNNING, status: 'checked',
    services: Object.fromEntries(['event-bus', 'agent-registry'].map((s) => [s, { deployed: 'a'.repeat(64), main: drifting.includes(s) ? 'b'.repeat(64) : 'a'.repeat(64), match: !drifting.includes(s) }])) }));
  const ONSET = T('2026-11-04T18:00:00Z'); const H = 3_600_000;
  const tick = async (at: number, drifting: string[]) => { check(at, drifting); await stallWatchTick(db, undefined, at, { ...C, ...env }); };

  it('raises fleet_drift:<svc> once the drift first seen by the watch is older than 24 h; a match resets the onset', async () => {
    expect(FLEET_DRIFT_STALL_H).toBe(24);
    await tick(ONSET, ['event-bus', 'agent-registry']);
    await tick(ONSET + 12 * H, ['event-bus', 'agent-registry']);
    check(ONSET + 23 * H, ['event-bus', 'agent-registry']);
    expect(report(ONSET + 23 * H, env).stalls.filter((s) => s.subsystem.startsWith('fleet_drift:'))).toEqual([]);
    await tick(ONSET + 23.5 * H, ['event-bus']); // agent-registry was redeployed
    check(ONSET + 25 * H, ['event-bus', 'agent-registry']); // and drifts again (not yet recorded by a tick)
    const r = report(ONSET + 25 * H, env);
    expect(r.stalls.filter((s) => s.subsystem.startsWith('fleet_drift:')).map((s) => [s.subsystem, s.since])).toEqual([['fleet_drift:event-bus', new Date(ONSET).toISOString()]]);
    expect(r.stalls.find((s) => s.subsystem === 'fleet_drift:event-bus')!.detail).toContain('> 24 h');
    expect(r.detectors.find((d) => d.name === 'fleet_drift')?.status).toBe('ok');
  });

  it('an unknown drift record (absent, stale, other commit) is not_applicable and records nothing', async () => {
    const absent = { ...C, DJIMITFLO_COMMIT_SHA: RUNNING, FLEET_DRIFT_PATH: path.join(os.tmpdir(), 'no-such-dir', 'fleet-drift.json') };
    await stallWatchTick(db, undefined, ONSET, absent);
    expect(detectStallsWithHealth(db, ONSET, absent).detectors.find((d) => d.name === 'fleet_drift')?.status).toBe('not_applicable');
    expect(db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'fleet_drift'").get()).toEqual({ n: 0 });
  });
});

describe('fleet:agent_outdated: a live host agent below the server minimum version', () => {
  const NOW = Date.now();
  it(`raises fleet:agent_outdated:<host> for a host polling with a version below ${MIN_HOST_AGENT_VERSION}`, () => {
    const fleet = new FleetCommands(db);
    fleet.poll('workstation', {}, '2'); fleet.poll('macmini', {}, MIN_HOST_AGENT_VERSION); fleet.poll('eve-v', {}, '');
    db.prepare("INSERT INTO fleet_hosts (host, last_seen, agent_version, info_json) VALUES ('retired', ?, '1', '{}')").run(new Date(NOW - 10 * 86_400_000).toISOString());
    const r = report(NOW, {});
    expect(r.stalls.filter((s) => s.subsystem.startsWith('fleet:agent_outdated:')).map((s) => s.subsystem).sort()).toEqual(['fleet:agent_outdated:eve-v', 'fleet:agent_outdated:workstation']);
    expect(r.stalls.find((s) => s.subsystem === 'fleet:agent_outdated:workstation')!.detail).toContain(`agent version 2 < ${MIN_HOST_AGENT_VERSION}`);
    expect(r.detectors.find((d) => d.name === 'fleet_agents')?.status).toBe('ok');
  });
});
