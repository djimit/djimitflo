import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { DreamStateService } from '../services/dream-state-service';
import { CAPABILITY_SPECS, capabilityChain, classifyCapability, classifyObservations, isAnomaly, observeCapability, type CapabilityObservation, type CapabilitySpec, type ObserveOptions } from '../services/capability-chain';
import { detectStallsWithHealth } from '../services/stall-watch';
import { markRun, noteScheduler, resetSchedulers } from '../services/scheduler-registry';

const prodFacts = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/capability-chain-prod-20261014.json'), 'utf8')) as { collected_at: string; observations: CapabilityObservation[] };
const NOW = Date.parse('2026-10-14T21:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const spec = (name: string) => CAPABILITY_SPECS.find((s) => s.name === name)!;
const executing = (name: string, lastRun = at(1)) => ({ name, status: 'executing' as const, last_run: lastRun, last_error: null });
/** all declared paths exist, no scheduler registered — each test overrides what it exercises */
const base: ObserveOptions = { stat: () => 'dir', schedulers: [] };
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); new SkillEvolutionEngine(db); new DreamStateService(db); });
afterEach(() => { db.close(); resetSchedulers(); });
const verdict = (name: string, env: NodeJS.ProcessEnv, opts: ObserveOptions = base) => capabilityChain(db, NOW, env, opts, [spec(name)])[0];
const ledger = (hoursAgo: number) => db.prepare("INSERT INTO dream_ledger (created_at, verdict, reason, candidates, classified, confident, consolidated) VALUES (?, 'REJECT', 'x', 1, 1, 0, 0)").run(at(hoursAgo));

describe('1. enabled capability with a disabled required dependency', () => {
  it('dream state on, its judgment off, scheduler ticking, no ledger row for 6 days → BLOCKED at DEPENDENCIES_READY with the observed facts', () => {
    ledger(6 * 24 - 3); // 2026-10-08 ~18:00Z
    const v = verdict('dream_state', { DREAM_STATE_ENABLED: 'true', TYPESAFE_FAILURE_CAUSE_MODE: 'off' }, { ...base, schedulers: [executing('dream_state')] });
    expect(v.state).toBe('BLOCKED');
    expect(v.link).toBe('DEPENDENCIES_READY');
    expect(v.chain).toMatchObject({ ENABLED: 'ok', CONFIGURED: 'ok', DEPENDENCIES_READY: 'failed' });
    const facts = v.facts.map((f) => f.fact);
    expect(facts).toContain('DREAM_STATE_ENABLED=true');
    expect(facts).toContain('TYPESAFE_FAILURE_CAUSE_MODE=off (required: shadow|enforce)');
    expect(v.facts.find((f) => f.fact.startsWith('last dream_ledger row'))?.at).toBe(at(6 * 24 - 3));
    expect(v.remediation).toContain('TYPESAFE_FAILURE_CAUSE_MODE to shadow or enforce');
  });

  it('the rule is generic: any declared dependency flag blocks the same way (no capability-specific cause)', () => {
    const s: CapabilitySpec = { name: 'x', flags: [{ env: 'X_ENABLED' }], dependency_flags: [{ env: 'Y_MODE', on: ['on'] }], window_ms: 3_600_000, hint: 'h' };
    const obs = (y: string | null): CapabilityObservation => ({ name: 'x', observed_at: at(0), env: { X_ENABLED: 'true', Y_MODE: y }, paths: [], scheduler: null, outcome: null, input: null, cap: null });
    expect(classifyCapability(s, obs(null), NOW).state).toBe('BLOCKED');
    expect(classifyCapability(s, obs('on'), NOW).state).toBe('HEALTHY');
  });

  it('dependency ready: a fresh ledger row is HEALTHY; a stale one with a ticking scheduler is STALLED at OUTCOME_PERSISTED', () => {
    const env = { DREAM_STATE_ENABLED: 'true', TYPESAFE_FAILURE_CAUSE_MODE: 'shadow' };
    ledger(5);
    expect(verdict('dream_state', env, { ...base, schedulers: [executing('dream_state')] }).state).toBe('HEALTHY');
    db.exec('DELETE FROM dream_ledger'); ledger(30);
    const v = verdict('dream_state', env, { ...base, schedulers: [executing('dream_state')] });
    expect([v.state, v.link]).toEqual(['STALLED', 'OUTCOME_PERSISTED']);
    expect(v.remediation).toContain('although the scheduler ticks');
  });

  it('reaches the stalls endpoint as a stall with structured evidence', () => {
    ledger(6 * 24);
    const r = detectStallsWithHealth(db, NOW, { DREAM_STATE_ENABLED: 'true', DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename, DJIMITFLO_SKILLS_DIR: os.tmpdir() });
    const s = r.stalls.find((x) => x.subsystem === 'capability:dream_state');
    expect(s?.detail).toMatch(/^BLOCKED at DEPENDENCIES_READY: .*TYPESAFE_FAILURE_CAUSE_MODE=\(unset\)/);
    expect(s?.since).toBe(at(6 * 24));
    expect(r.health).toBe('BREACHED');
    expect(r.detectors.find((d) => d.name === 'capabilities')?.status).toBe('ok');
    expect(r.capabilities.find((c) => c.component === 'dream_state')?.state).toBe('BLOCKED');
  });
});

describe('2. scheduler running without successful ticks (scheduler registry)', () => {
  const env = { DREAM_STATE_ENABLED: 'true', TYPESAFE_FAILURE_CAUSE_MODE: 'shadow' };
  it('a failing tick is STALLED at EXECUTED, read from the live registry', () => {
    ledger(1);
    noteScheduler('dream_state', 'DREAM_STATE_ENABLED', true, 6 * 3_600_000);
    markRun('dream_state', new Error('SQLITE_BUSY'));
    const v = capabilityChain(db, Date.now(), env, { stat: () => 'dir' }, [spec('dream_state')])[0];
    expect([v.state, v.link]).toEqual(['STALLED', 'EXECUTED']);
    expect(v.remediation).toContain('SQLITE_BUSY');
  });
  it('armed but not ticking past its grace is STALLED at SCHEDULED; not armed while the flag is on is MISCONFIGURED', () => {
    ledger(1);
    const stuck = verdict('dream_state', env, { ...base, schedulers: [{ name: 'dream_state', status: 'armed_not_ticking', last_run: null, last_error: null }] });
    expect([stuck.state, stuck.link]).toEqual(['STALLED', 'SCHEDULED']);
    const off = verdict('dream_state', env, { ...base, schedulers: [{ name: 'dream_state', status: 'off', last_run: null, last_error: null }] });
    expect([off.state, off.link]).toEqual(['MISCONFIGURED', 'SCHEDULED']);
  });
});

describe('3. configured skill directory missing or unreadable', () => {
  it('missing → MISCONFIGURED at CONFIGURED; a real directory → HEALTHY; a file → MISCONFIGURED (wrong kind)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    try {
      const missing = verdict('skill_loader', { DJIMITFLO_SKILLS_DIR: path.join(dir, 'nope') }, { schedulers: [] });
      expect([missing.state, missing.link]).toEqual(['MISCONFIGURED', 'CONFIGURED']);
      expect(missing.facts[0].fact).toContain(': missing');
      expect(missing.remediation).toContain('set DJIMITFLO_SKILLS_DIR to a readable dir');
      expect(verdict('skill_loader', { DJIMITFLO_SKILLS_DIR: dir }, { schedulers: [] }).state).toBe('HEALTHY');
      fs.writeFileSync(path.join(dir, 'f'), 'x');
      expect(observeCapability(spec('skill_loader'), db, NOW, { DJIMITFLO_SKILLS_DIR: path.join(dir, 'f') }, { schedulers: [] }).paths[0].status).toBe('wrong_kind');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('unset: no implicit default directory — DISABLED_BY_POLICY at ENABLED, not an anomaly, nothing is stat-ed', () => {
    const stat = (): 'dir' => { throw new Error('an unset skills dir must not be resolved against any default path'); };
    const v = verdict('skill_loader', {}, { ...base, stat });
    expect([v.state, v.link, v.chain.ENABLED]).toEqual(['DISABLED_BY_POLICY', 'ENABLED', 'failed']);
    expect(v.facts[0].fact).toBe('skills directory: DJIMITFLO_SKILLS_DIR unset');
    expect(v.remediation).toMatch(/^none: DJIMITFLO_SKILLS_DIR unset/);
    expect(isAnomaly(v)).toBe(false);
    expect(verdict('skill_loader', { DJIMITFLO_SKILLS_DIR: '  ' }, { ...base, stat }).state).toBe('DISABLED_BY_POLICY');
  });
});

describe('4. promotion gate runner: unset vs configured-but-missing', () => {
  it('unset → UNCONFIGURED at CONFIGURED (no machine-specific default path), not an anomaly', () => {
    const v = verdict('skill_training_promotion_gate', {}, { ...base, stat: () => { throw new Error('no default runner path'); } });
    expect([v.state, v.link, v.chain.CONFIGURED]).toEqual(['UNCONFIGURED', 'CONFIGURED', 'failed']);
    expect(v.facts[0].fact).toBe('skill-training eval runner: DJIMIT_SKILL_TRAINING_EVAL_RUNNER unset');
    expect(JSON.stringify(v)).not.toContain('/Users/');
    expect(isAnomaly(v)).toBe(false);
  });
  it('configured but missing → still MISCONFIGURED, remediation names the env override; a readable file → HEALTHY', () => {
    const v = verdict('skill_training_promotion_gate', { DJIMIT_SKILL_TRAINING_EVAL_RUNNER: '/nope/run.mjs' }, { ...base, stat: () => 'missing' });
    expect([v.state, v.link]).toEqual(['MISCONFIGURED', 'CONFIGURED']);
    expect(v.facts[0].fact).toBe('skill-training eval runner /nope/run.mjs (DJIMIT_SKILL_TRAINING_EVAL_RUNNER): missing');
    expect(v.remediation).toContain('set DJIMIT_SKILL_TRAINING_EVAL_RUNNER to a readable file');
    expect(isAnomaly(v)).toBe(true);
    expect(verdict('skill_training_promotion_gate', { DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename }, { schedulers: [] }).state).toBe('HEALTHY');
  });
});

describe('5. pending executable work without measurable progress', () => {
  const goal = (id: string, status: string, updatedHoursAgo: number) =>
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, created_at, updated_at) VALUES (?, 'o', 'low', ?, ?, ?)").run(id, status, at(updatedHoursAgo + 1), at(updatedHoursAgo));
  it('queued goals with no state change within the window → STALLED; any recent change → HEALTHY; nothing queued → IDLE_EXPECTED', () => {
    expect(verdict('goal_queue', {}).state).toBe('IDLE_EXPECTED');
    goal('g1', 'created', 10); goal('g2', 'decomposed', 9);
    const v = verdict('goal_queue', {});
    expect([v.state, v.link]).toEqual(['STALLED', 'OUTCOME_PERSISTED']);
    expect(v.facts.map((f) => f.fact)).toContain('2 goal(s) created/decomposed, not started');
    expect(v.facts.find((f) => f.fact.startsWith('last state change'))?.at).toBe(at(9));
    goal('g3', 'completed', 1);
    expect(verdict('goal_queue', {}).state).toBe('HEALTHY');
  });
  it('proposals waiting while the review scheduler ticks but nothing moves → STALLED', () => {
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES ('p1', 'bug_fix', 't', 'd', 'r', 'reflection', 'proposed', ?, ?)").run(at(20), at(20));
    const v = verdict('proposal_review', { SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED: 'true' }, { ...base, schedulers: [executing('self_improvement_auto_review')] });
    expect([v.state, v.link]).toEqual(['STALLED', 'OUTCOME_PERSISTED']);
  });
});

describe('expected inactivity is IDLE_EXPECTED, never STALLED; missing evidence is UNKNOWN', () => {
  it('flag off → IDLE_EXPECTED even with a missing path and no outcome', () => {
    for (const name of ['dream_state', 'evolution_gym', 'frontier_experts', 'proposal_review']) {
      const v = verdict(name, {}, { ...base, stat: () => 'missing' });
      expect([name, v.state, v.link]).toEqual([name, 'IDLE_EXPECTED', 'ENABLED']);
    }
  });
  it('remote gym at its daily cap → IDLE_EXPECTED; below its cap and silent → STALLED', () => {
    const claim = (i: number, h: number, status: string) => db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, 'evolution-gym', 'closed', ?, ?, ?, ?)")
      .run(`c${i}`, status, JSON.stringify({ gym: { remote_host: 'workstation' } }), at(h), at(h));
    for (let i = 0; i < 4; i++) claim(i, 20 - i, 'completed');
    const env = { EVOLUTION_GYM_REMOTE_ENABLED: 'true', EVOLUTION_GYM_REMOTE_MAX_PER_DAY: '4' };
    expect(verdict('evolution_gym_remote', env).state).toBe('IDLE_EXPECTED');
    const below = verdict('evolution_gym_remote', { ...env, EVOLUTION_GYM_REMOTE_MAX_PER_DAY: '5' });
    expect([below.state, below.link]).toEqual(['STALLED', 'OUTCOME_PERSISTED']);
    claim(9, 1, 'completed');
    expect(verdict('evolution_gym_remote', { ...env, EVOLUTION_GYM_REMOTE_MAX_PER_DAY: '9' }).state).toBe('HEALTHY');
  });
  it('outcome table missing → UNKNOWN; inside the boot grace with no outcome → UNKNOWN; scheduler-only capability without proof of ticks → UNKNOWN', () => {
    db.exec('DROP TABLE evolution_estimates');
    expect(verdict('evolution_estimates', { EVOLUTION_ESTIMATORS_ENABLED: 'true' }).state).toBe('UNKNOWN');
    const env = { DREAM_STATE_ENABLED: 'true', TYPESAFE_FAILURE_CAUSE_MODE: 'shadow' };
    expect(verdict('dream_state', env, { ...base, schedulers: [{ name: 'dream_state', status: 'armed_pending', last_run: null, last_error: null }] }).state).toBe('UNKNOWN');
    expect(verdict('frontier_experts', { FRONTIER_EXPERTS_SCHEDULER_ENABLED: 'true' }).state).toBe('UNKNOWN');
    expect(verdict('frontier_experts', { FRONTIER_EXPERTS_SCHEDULER_ENABLED: 'true' }, { ...base, schedulers: [executing('frontier_experts')] }).state).toBe('HEALTHY');
  });
  it('a capability anomaly a legacy detector already raised is not raised twice', () => {
    const r = detectStallsWithHealth(db, NOW, { EVOLUTION_ESTIMATORS_ENABLED: 'true', DJIMIT_SKILL_TRAINING_EVAL_RUNNER: __filename, DJIMITFLO_SKILLS_DIR: os.tmpdir() });
    expect(r.stalls.map((s) => s.subsystem)).toEqual(['estimates']);
    expect(r.capabilities.find((c) => c.component === 'evolution_estimates')?.state).toBe('STALLED');
  });
});

describe('prod replay (read-only fact probe of djimitflo-live, 2026-10-14)', () => {
  const verdicts = classifyObservations(prodFacts.observations, Date.parse(prodFacts.collected_at));
  it('classifies every watched capability', () => {
    expect(verdicts.map((v) => v.component).sort()).toEqual(CAPABILITY_SPECS.map((s) => s.name).sort());
    expect(Object.fromEntries(verdicts.map((v) => [v.component, v.state]))).toEqual({
      dream_state: 'BLOCKED',
      evolution_estimates: 'HEALTHY',
      evolution_gym: 'IDLE_EXPECTED', // EVOLUTION_GYM_ENABLED=false
      evolution_gym_remote: 'HEALTHY', // 18/20, settled run 2 min before the probe
      frontier_experts: 'IDLE_EXPECTED', // flag off
      memory_candidate_review: 'IDLE_EXPECTED', // no candidate pending promotion
      proposal_review: 'IDLE_EXPECTED', // nothing in 'proposed'
      goal_queue: 'IDLE_EXPECTED', // nothing queued
      skill_loader: 'DISABLED_BY_POLICY', // DJIMITFLO_SKILLS_DIR unset; the image provisions no skills dir
      skill_training_promotion_gate: 'UNCONFIGURED', // DJIMIT_SKILL_TRAINING_EVAL_RUNNER unset: promotion refused (fail-closed)
    });
  });
  it('reproduces the dream-state anomaly from the observed facts: on, dependency off, no ledger row since 2026-10-08 17:39Z', () => {
    const v = verdicts.find((x) => x.component === 'dream_state')!;
    expect([v.state, v.link]).toEqual(['BLOCKED', 'DEPENDENCIES_READY']);
    expect(v.facts.map((f) => f.fact)).toEqual(['DREAM_STATE_ENABLED=true', 'TYPESAFE_FAILURE_CAUSE_MODE=off (required: shadow|enforce)', 'last dream_ledger row at 2026-10-08T17:39:47.013Z']);
  });
  it('no idle-by-design component is flagged STALLED', () => {
    expect(verdicts.filter((v) => v.state === 'STALLED')).toEqual([]);
  });
});
