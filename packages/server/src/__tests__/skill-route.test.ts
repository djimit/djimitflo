import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createCapabilityRoutes } from '../routes/capabilities';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { assignmentContext } from '../services/assignment-context';
import { factoryCapabilityLines } from '../services/capability-factory';
import { LoopService, type LoopFinding, type LoopRunRecord } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { ensureCreditTable, recordCredits } from '../services/outcome-attribution';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';
import { unknownEnvFlags } from '../services/env-flags';
import { recordTreatmentEnvBoundaries } from '../services/experiment-registry';
import { genomeDelivery } from '../services/genome-registry';
import {
  goalSkillLane, observeSkillInvocation, registerSkillFromRepair, scanSkillInvocations, settleSkillRoute, skillRouteArm, skillRouteEvidence,
  skillRouteFor, skillRouteMode, validateSkillCapability,
} from '../services/skill-route';

/**
 * L1 / M2–M8 (operator 2026-11-06): a skill made from a real repair is selected by lane, delivered (on, treatment arm only),
 * its invocation is observed in the maker transcript, the daemon's own checks decide, and only then is it credited.
 * SKILL_ROUTE_MODE=off|shadow|on (default off = today, byte for byte). Gap A: strategy genome credit needs delivery.
 * scripts/skills/oracle-gate.mjs belongs to another branch: here it is a stub file whose digest is read at run time.
 */
const SCRIPT = 'scripts/skills/oracle-gate.mjs';
const STUB = "#!/usr/bin/env node\nconsole.log('ORACLE_GATE ' + JSON.stringify({ pass: true }));\n";
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let db: Database.Database; let repo: string; let admin: string; let viewer: string; let auth: ReturnType<typeof createAuthMiddleware>;
let digest: string;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skillroute-'));
  fs.mkdirSync(path.join(repo, 'scripts/skills'), { recursive: true });
  fs.writeFileSync(path.join(repo, SCRIPT), STUB);
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  digest = `sha256:${sha(STUB)}`;
  vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
  vi.stubEnv('SKILL_ROUTE_MODE', '');
  const authService = new AuthService(db);
  admin = authService.generateToken(authService.createUser('skillroute-admin@example.test', 'disposable-password', UserRole.ADMIN));
  viewer = authService.generateToken(authService.createUser('skillroute-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  auth = createAuthMiddleware(authService);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

const app = () => express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json())
  .use('/api/capabilities', auth.requireAuth, createCapabilityRoutes(db, auth)).use(errorHandler);
const SKILL = { name: 'oracle-gate', lanes: ['mutation-gap', 'test-gap'], script_path: SCRIPT, oracle: 'daemon check scripts exit 0 and mutation-gain pass:true',
  applicability: { runtimes: ['opencode'] }, provenance: { lease_ids: ['lease-a', 'lease-b'] } };
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** register + validate through the service (the route tests cover the HTTP surface) */
function liveSkill(input: Partial<typeof SKILL> = {}) {
  const env = { ...process.env, SKILL_ROUTE_MODE: process.env.SKILL_ROUTE_MODE || 'on' };
  const reg = registerSkillFromRepair(db, { ...SKILL, ...input } as typeof SKILL, 'op', env);
  return validateSkillCapability(db, reg.capability.id, { evidence_refs: ['replay:23/23'] }, 'op', env);
}
function seedGoal(goalId: string, refs: string[]) {
  const pid = `p-${goalId}`;
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES (?, 'test', 'Strengthen tests', 'd', 'r', 'mutation_gap', 'executing', 0.5, ?, ?, datetime('now'), datetime('now'))`)
    .run(pid, JSON.stringify(refs), JSON.stringify({ target: 'packages/server/src/services/a.ts', artifactPath: 'packages/server/src/__tests__/a.test.ts' }));
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, datetime('now'), datetime('now'))`).run(goalId, pid);
}
const MUTATION = ['mutation-gap:packages/server/src/services/a.ts'];
const EXPORTS = ['test-gap:packages/server/src/services/b.ts#exports'];
const goalIn = (arm: 'treatment' | 'holdout') => { for (let i = 0; ; i++) if (skillRouteArm(`goal-${i}`) === arm) return `goal-${i}`; };

const run = (goalId: string | null, id = 'run-1') => ({ id, loop_name: 'mutation-gap-loop', goal_id: goalId, mode: 'closed', status: 'planning', metadata: {}, gates: [], next_actions: [], plan: {},
  state_file: null, repository_path: repo, findings: [] }) as unknown as LoopRunRecord;
const finding = { id: 'f1', type: 'test_finding', severity: 'low', file: 'packages/server/src/services/a.ts', line: 1, message: 'm', evidence: 'e', suggested_fix: 's' } as LoopFinding;
function writeAssignment(goalId: string | null, runtime = 'opencode', runId = 'run-1') {
  const loops = new LoopService(db);
  loops.writeWorkAssignment(repo, run(goalId, runId), finding, runtime);
  const text = fs.readFileSync(loops.workAssignmentPath(repo), 'utf8');
  const ev = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
  return { text, event: ev ? JSON.parse(ev.metadata) as Record<string, any> : null, file: loops.workAssignmentPath(repo) };
}

// opencode --format json transcript lines
const bash = (command: string, output = '', exit = 0) => JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command }, output, metadata: { exit, output } } } });
const text = (t: string) => JSON.stringify({ type: 'text', part: { text: t } });
const step = () => JSON.stringify({ type: 'step_finish', part: { tokens: { total: 10 } } });
const gate = (pass: boolean, d: string | null = digest) => `ORACLE_GATE ${JSON.stringify({ pass, ...(d ? { digest: d } : {}) })}\nPASS — stop, the daemon re-runs these`;
const invoked = () => [step(), bash(`node ${SCRIPT}`, gate(true)), step()].join('\n');

describe('flag', () => {
  it('SKILL_ROUTE_MODE is off unless shadow or on; an acting evolution flag; known to the env check; an oracle-population treatment variable', () => {
    expect(skillRouteMode({})).toBe('off');
    expect(skillRouteMode({ SKILL_ROUTE_MODE: 'yes' })).toBe('off');
    expect(skillRouteMode({ SKILL_ROUTE_MODE: 'shadow' })).toBe('shadow');
    expect(skillRouteMode({ SKILL_ROUTE_MODE: 'on' })).toBe('on');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'SKILL_ROUTE_MODE', acting: true });
    expect(unknownEnvFlags({ SKILL_ROUTE_MODE: 'on' })).toEqual([]);
    recordTreatmentEnvBoundaries(db, { SKILL_ROUTE_MODE: 'off' }, Date.parse('2026-11-01T00:00:00Z'));
    const rows = recordTreatmentEnvBoundaries(db, { SKILL_ROUTE_MODE: 'on' }, Date.parse('2026-11-02T00:00:00Z'));
    expect(rows.map((r) => r.experiment_id)).toEqual(expect.arrayContaining(['ACE-001', 'STE-001', 'MAKER-DEPS-001']));
  });
});

describe('M2: register an executable script capability from a repair', () => {
  const post = (b: object, token = admin) => request(app()).post('/api/capabilities/skills').set('Authorization', `Bearer ${token}`).send(b);

  it('off: 404 SKILL_ROUTE_DISABLED and nothing is written', async () => {
    const res = await post(SKILL);
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe('SKILL_ROUTE_DISABLED');
    expect(count('SELECT COUNT(*) AS n FROM swarm_capabilities')).toBe(0);
  });

  it('shadow: manage:config registers a candidate whose digest the server computes from the file; version is immutable', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    expect((await post(SKILL, viewer)).status).toBe(403);
    expect((await post({ ...SKILL, artifact_digest: 'sha256:forged' })).status).toBe(400); // strict: the client never supplies a digest
    const res = await post(SKILL);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'registered', capability: { id: 'skill:oracle-gate', status: 'candidate', version: sha(STUB).slice(0, 12), owner: 'capability-factory' } });
    expect(res.body.capability.metadata).toMatchObject({ source: 'skill_from_repair', lanes: ['mutation-gap', 'test-gap'], script_path: SCRIPT, artifact_digest: digest,
      applicability: { runtimes: ['opencode'] }, oracle: SKILL.oracle, provenance: { lease_ids: ['lease-a', 'lease-b'] }, registered_by: expect.any(String) });
    // the same file again is the same version; a changed file under the same name is refused (a new version is a new name)
    expect((await post(SKILL)).body.status).toBe('exists');
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}// changed\n`);
    const changed = await post(SKILL);
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code ?? changed.body.code).toBe('CAPABILITY_IMMUTABLE');
    expect(count('SELECT COUNT(*) AS n FROM swarm_capabilities')).toBe(1);
  });

  it('shadow: refuses a script outside scripts/skills, a missing file, a traversal and an unknown lane', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    expect((await post({ ...SKILL, script_path: 'README.md' })).status).toBe(400);
    expect((await post({ ...SKILL, script_path: 'scripts/skills/missing.mjs' })).status).toBe(400);
    expect((await post({ ...SKILL, script_path: 'scripts/skills/../../etc/passwd' })).status).toBe(400);
    expect((await post({ ...SKILL, lanes: ['doc-drift'] })).status).toBe(400);
    expect((await post({ ...SKILL, lanes: [] })).status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM swarm_capabilities')).toBe(0);
  });
});

describe('M8: validation writes an oracle-population period boundary', () => {
  it('validate promotes the candidate (digest re-checked) and writes one boundary row per oracle-population experiment, once', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    await request(app()).post('/api/capabilities/skills').set('Authorization', `Bearer ${admin}`).send(SKILL);
    const validate = () => request(app()).post(`/api/capabilities/skills/${encodeURIComponent('skill:oracle-gate')}/validate`).set('Authorization', `Bearer ${admin}`)
      .send({ evidence_refs: ['replay:23/23'] });
    expect((await request(app()).post(`/api/capabilities/skills/${encodeURIComponent('skill:oracle-gate')}/validate`).set('Authorization', `Bearer ${viewer}`).send({ evidence_refs: ['x'] })).status).toBe(403);
    const res = await validate();
    expect(res.status).toBe(200);
    expect(res.body.capability).toMatchObject({ id: 'skill:oracle-gate', status: 'validated' });
    const rows = db.prepare('SELECT experiment_id, env_name, previous, current FROM experiment_period_boundaries').all() as Array<Record<string, string>>;
    expect(rows.map((r) => r.experiment_id)).toEqual(expect.arrayContaining(['ACE-001', 'STE-001', 'MAKER-DEPS-001']));
    expect(rows.every((r) => r.env_name === 'capability:skill:oracle-gate' && r.previous === 'candidate' && r.current === `validated@${sha(STUB).slice(0, 12)}`)).toBe(true);
    const n = rows.length;
    expect((await validate()).status).toBe(200); // idempotent: already validated, no second boundary
    expect(count('SELECT COUNT(*) AS n FROM experiment_period_boundaries')).toBe(n);
  });

  it('a file that changed after registration is not validated (DIGEST_CHANGED) and writes no boundary', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    await request(app()).post('/api/capabilities/skills').set('Authorization', `Bearer ${admin}`).send(SKILL);
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}// tampered\n`);
    const res = await request(app()).post(`/api/capabilities/skills/${encodeURIComponent('skill:oracle-gate')}/validate`).set('Authorization', `Bearer ${admin}`).send({ evidence_refs: ['x'] });
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('SKILL_DIGEST_CHANGED');
    expect(count("SELECT COUNT(*) AS n FROM swarm_capabilities WHERE status = 'validated'")).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM experiment_period_boundaries')).toBe(0);
  });
});

describe('M3: selection by lane (+ applicability), not by file or keyword', () => {
  it('a mutation goal and a test-gap #exports goal both select a skill listed for both lanes; other goals and runtimes do not', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    liveSkill();
    seedGoal('gm', MUTATION); seedGoal('ge', EXPORTS); seedGoal('gd', ['doc-drift:README.md']);
    expect(goalSkillLane(db, 'gm')).toBe('mutation-gap');
    expect(goalSkillLane(db, 'ge')).toBe('test-gap-exports');
    expect(goalSkillLane(db, 'gd')).toBeNull();
    expect(skillRouteFor(db, run('gm'), repo, 'opencode')?.capability_id).toBe('skill:oracle-gate');
    expect(skillRouteFor(db, run('ge'), repo, 'opencode')?.capability_id).toBe('skill:oracle-gate');
    expect(skillRouteFor(db, run('gd'), repo, 'opencode')).toBeUndefined();
    expect(skillRouteFor(db, run('gm'), repo, 'codex')).toBeUndefined(); // applicability: opencode only (the only observable transcript)
  });

  it('a skill listed for the mutation lane only is not selected for an exports goal; a candidate is never selected', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    registerSkillFromRepair(db, { ...SKILL, name: 'cand-only' }, 'op');
    seedGoal('gm', MUTATION); seedGoal('ge', EXPORTS);
    expect(skillRouteFor(db, run('gm'), repo, 'opencode')).toBeUndefined();
    liveSkill({ lanes: ['mutation-gap'] });
    expect(skillRouteFor(db, run('gm'), repo, 'opencode')?.lane).toBe('mutation-gap');
    expect(skillRouteFor(db, run('ge'), repo, 'opencode')).toBeUndefined();
  });

  it('the factory file/keyword lines never list a skill capability (it reaches a maker only through the route)', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on'); vi.stubEnv('CAPABILITY_FACTORY_MODE', 'on');
    liveSkill();
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
      VALUES ('pk', 'test', 'oracle gate mutation daemon check scripts', 'oracle gate mutation daemon check scripts pass', 'r', 'mutation_gap', 'executing', 0.5, '[]', ?, datetime('now'), datetime('now'))`)
      .run(JSON.stringify({ target: SCRIPT, artifactPath: SCRIPT }));
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('gk', 'o', 'low', 'running', '{}', 'pk', datetime('now'), datetime('now'))`).run();
    expect(factoryCapabilityLines(db, 'gk')).toEqual([]);
  });
});

describe('M4: delivery receipt + per-goal holdout', () => {
  it('off: a validated skill changes nothing — context, LOOP_WORK.md and events are byte-identical to no skill at all', () => {
    const t = goalIn('treatment');
    seedGoal(t, MUTATION);
    const before = writeAssignment(t, 'opencode', 'run-a');
    new SwarmIntelligenceService(db).registerCapability({ id: 'skill:oracle-gate', kind: 'deterministic_harness', owner: 'capability-factory', version: sha(STUB).slice(0, 12),
      status: 'validated', risk_ceiling: 'low', input_schema_ref: 'lanes', output_schema_ref: 'oracle', allowed_actions: ['deliver_in_assignment'], forbidden_actions: ['deploy'],
      required_evidence: ['transcript:invocation'], eval_score: 1, removal_strategy: 'deprecate',
      metadata: { source: 'skill_from_repair', name: 'oracle-gate', lanes: ['mutation-gap'], script_path: SCRIPT, artifact_digest: digest, oracle: 'o' } });
    fs.rmSync(path.join(repo, '.djimitflo'), { recursive: true, force: true });
    const after = writeAssignment(t, 'opencode', 'run-b');
    expect(after.text.replace(/run-b/g, 'run-a')).toBe(before.text);
    expect(before.event).toBeNull(); expect(after.event).toBeNull();
    expect(assignmentContext(db, { id: 'run-b', goal_id: t }, repo, 'maker', {})).toEqual({ examples: [], rules: [] });
    expect(observeSkillInvocation(db, 'run-b', invoked(), repo, {})).toBeNull();
  });

  it('shadow: records what WOULD be delivered (ids, digest, block sha, LOOP_WORK.md sha, arm) and delivers nothing', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    liveSkill();
    const t = goalIn('treatment');
    seedGoal(t, MUTATION);
    const { text: work, event } = writeAssignment(t);
    expect(work).not.toContain(SCRIPT);
    expect(work).not.toContain('ORACLE_GATE');
    expect(event?.skill_route).toMatchObject({ mode: 'shadow', capability_id: 'skill:oracle-gate', version: sha(STUB).slice(0, 12), artifact_digest: digest,
      script_path: SCRIPT, lane: 'mutation-gap', arm: 'treatment', delivered: false, would_deliver: true, block_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      assignment_sha256: sha(work) });
    expect(event?.skill_route.lines).toBeUndefined();
  });

  it('on: the treatment arm gets the block (script path + how to run, no mutants or diff hints); the holdout arm gets nothing', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    liveSkill();
    const t = goalIn('treatment'); const h = goalIn('holdout');
    seedGoal(t, MUTATION); seedGoal(h, EXPORTS);
    const treat = writeAssignment(t, 'opencode', 'run-t');
    expect(treat.text).toContain(`node ${SCRIPT}`);
    expect(treat.event?.skill_route).toMatchObject({ mode: 'on', arm: 'treatment', delivered: true, assignment_sha256: sha(treat.text) });
    // the receipt's block sha is the sha of the block that is in LOOP_WORK.md
    const start = treat.text.indexOf('## Skill: ');
    const block = treat.text.slice(start, treat.text.indexOf('\n\n', treat.text.indexOf(`Oracle: `, start)));
    expect(sha(block)).toBe(treat.event?.skill_route.block_sha256);
    expect(block.toLowerCase()).not.toMatch(/surviv|mutatorname|replacement|location|diff|@@/);
    const hold = writeAssignment(h, 'opencode', 'run-h');
    expect(hold.text).not.toContain(SCRIPT);
    expect(hold.event?.skill_route).toMatchObject({ mode: 'on', arm: 'holdout', delivered: false, would_deliver: false, lane: 'test-gap-exports' });
  });

  it('the arm is a deterministic hash of the goal id with its own salt, about half each', () => {
    const arms = Array.from({ length: 400 }, (_, i) => skillRouteArm(`g-${i}`));
    expect(arms.filter((a) => a === 'holdout').length).toBeGreaterThan(160);
    expect(arms.filter((a) => a === 'holdout').length).toBeLessThan(240);
    expect(skillRouteArm('g-7')).toBe(skillRouteArm('g-7'));
  });

  it('on: a script missing from the maker checkout, or with another digest there, is not delivered (recorded)', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    liveSkill();
    const t = goalIn('treatment'); seedGoal(t, MUTATION);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'skillroute-wt-'));
    try {
      expect(skillRouteFor(db, run(t), other, 'opencode')).toMatchObject({ delivered: false, would_deliver: false, reason: 'script_missing_in_checkout' });
      fs.mkdirSync(path.join(other, 'scripts/skills'), { recursive: true }); fs.writeFileSync(path.join(other, SCRIPT), '// other\n');
      expect(skillRouteFor(db, run(t), other, 'opencode')).toMatchObject({ delivered: false, reason: 'digest_mismatch_in_checkout' });
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

describe('M5: observed invocation', () => {
  it('a bash tool call that runs the script is an invocation; reading, mentioning or pasting its output is not', () => {
    expect(scanSkillInvocations(invoked(), SCRIPT)).toMatchObject({ observable: true, invoked: true, invocations: 1, exit_code: 0, step: 2, oracle_gate: { pass: true, digest } });
    expect(scanSkillInvocations([step(), bash(`cat ${SCRIPT}`), bash(`grep -n x ${SCRIPT}`)].join('\n'), SCRIPT)).toMatchObject({ observable: true, invoked: false });
    // label/hash only: the ORACLE_GATE line with the right digest, but in text, not a bash run
    expect(scanSkillInvocations([step(), text(`I ran node ${SCRIPT}: ${gate(true)}`)].join('\n'), SCRIPT)).toMatchObject({ observable: true, invoked: false, oracle_gate: null });
    expect(scanSkillInvocations([bash(`cd /w && npm ci && node ./${SCRIPT} --doctor`, gate(false), 1)].join('\n'), SCRIPT)).toMatchObject({ invoked: true, exit_code: 1, oracle_gate: { pass: false } });
    expect(scanSkillInvocations('plain remote stdout\n', SCRIPT)).toMatchObject({ observable: false, invoked: false });
  });

  it('records applied / shown_unused / unobservable and verifies the digest in the worktree and on the ORACLE_GATE line', () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    liveSkill();
    const t = goalIn('treatment'); seedGoal(t, MUTATION);
    writeAssignment(t);
    expect(observeSkillInvocation(db, 'run-1', invoked(), repo)).toMatchObject({ state: 'applied', invoked: true, digest_ok: true, worktree_digest: digest, arm: 'treatment', delivered: true });
    expect(observeSkillInvocation(db, 'run-1', [step(), bash('npm test')].join('\n'), repo)).toMatchObject({ state: 'shown_unused', invoked: false });
    expect(observeSkillInvocation(db, 'run-1', 'no json', repo)).toMatchObject({ state: 'unobservable', observable: false });
    expect(observeSkillInvocation(db, 'run-1', [bash(`node ${SCRIPT}`, gate(true, 'sha256:0000'))].join('\n'), repo)).toMatchObject({ invoked: true, digest_ok: false });
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}// maker edited the skill\n`);
    expect(observeSkillInvocation(db, 'run-1', invoked(), repo)).toMatchObject({ invoked: true, digest_ok: false, worktree_digest: expect.not.stringMatching(digest) });
  });
});

describe('M6/M7: credit only on invoked ∧ daemon checks pass ∧ verified', () => {
  const stubLoops = (gates: Array<{ name: string; status: string }>) => ({
    startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'finding-1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
    continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'opencode' }, { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' }] })),
    executeWorker: vi.fn(async () => ({})),
    runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
    retryLoopRun: vi.fn(),
    executeChecker: vi.fn(async () => ({})),
    verifyLoopRun: vi.fn(() => ({ gates })),
    pruneOrphanedWorktrees: vi.fn(),
  });
  const PASS = [{ name: 'test', status: 'pass', exit_status: 0 }, { name: 'lint', status: 'pass', exit_status: 0 }];
  async function daemonRun(leaseMeta: Record<string, unknown>, opts: { gates?: Array<{ name: string; status: string }>; leaseStatus?: string; runtime?: string } = {}) {
    vi.stubEnv('OUTCOME_ATTRIBUTION_ENABLED', 'true');
    const goal = new GoalService(db).createGoal({ objective: 'Kill surviving mutants in a.ts', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('maker-1', 'run-1', 'maker', ?, ?, ?, ?, ?)`)
      .run(opts.runtime ?? 'opencode', opts.leaseStatus ?? 'completed', JSON.stringify(leaseMeta), now, now);
    const daemon = new LoopDaemon(db, stubLoops(opts.gates ?? [{ name: 'checker_verdict', status: 'pass' }]) as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
  }
  const outcome = () => db.prepare('SELECT capability_id, artifact_digest, evidence_refs_json AS refs FROM skill_outcomes').get() as { capability_id: string | null; artifact_digest: string | null; refs: string };
  const credits = () => (ensureCreditTable(db), db).prepare("SELECT ref FROM outcome_credits WHERE kind = 'skill_invoked'").all() as Array<{ ref: string }>;
  const leaseCap = () => (db.prepare("SELECT capability_id FROM worker_leases WHERE id = 'maker-1'").get() as { capability_id: string | null }).capability_id;
  const leaseRoute = () => JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'maker-1'").get() as { metadata: string }).metadata).skill_route as Record<string, unknown>;
  function observed(arm: 'treatment' | 'holdout', transcript: string) {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    const cap = liveSkill();
    const g = goalIn(arm); seedGoal(g, MUTATION);
    writeAssignment(g);
    return { cap, route: observeSkillInvocation(db, 'run-1', transcript, repo)! };
  }

  it('treatment + invoked + digest ok + checks pass + verified → skill_outcomes capability_id/digest, one skill_invoked credit, lease capability_id', async () => {
    const { cap, route } = observed('treatment', invoked());
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(outcome()).toMatchObject({ capability_id: 'skill:oracle-gate', artifact_digest: digest });
    expect(JSON.parse(outcome().refs)).toContain('skill_route:treatment:credited');
    expect(credits()).toEqual([{ ref: `skill:oracle-gate@${cap.version}` }]);
    expect(leaseCap()).toBe('skill:oracle-gate');
    expect(leaseRoute()).toMatchObject({ checks_pass: true, lease_completed: true, run_verified: true, credited: true,
      daemon_checks: [{ name: 'test', status: 'pass', exit_status: 0 }, { name: 'lint', status: 'pass', exit_status: 0 }] });
    // duplicate events / passes: one credit
    recordCredits(db, 'run-1', 'maker-1');
    settleSkillRoute(db, 'run-1', 'maker-1', true);
    expect(credits()).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM skill_outcomes')).toBe(1);
  });

  it('delivered but not invoked: recorded, no credit', async () => {
    const { route } = observed('treatment', [step(), bash('npm test')].join('\n'));
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(outcome()).toMatchObject({ capability_id: null, artifact_digest: null });
    expect(JSON.parse(outcome().refs)).toContain('skill_route:treatment:shown_unused');
    expect(credits()).toEqual([]); expect(leaseCap()).toBeNull();
    expect(leaseRoute()).toMatchObject({ credited: false, invoked: false });
  });

  it('invoked but a daemon check failed, or the run not verified: no credit', async () => {
    const { route } = observed('treatment', invoked());
    await daemonRun({ skill_route: route, deterministic_checks: [PASS[0], { name: 'lint', status: 'fail', exit_status: 1 }] }, { gates: [{ name: 'deterministic_checks', status: 'fail' }] });
    expect(outcome().capability_id).toBeNull();
    expect(credits()).toEqual([]); expect(leaseCap()).toBeNull();
    expect(leaseRoute()).toMatchObject({ checks_pass: false, run_verified: false, credited: false });
  });

  it('label/hash only (the ORACLE_GATE line pasted as text, no bash run): no credit', async () => {
    const { route } = observed('treatment', [step(), text(`node ${SCRIPT}\n${gate(true)}`)].join('\n'));
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(outcome().capability_id).toBeNull(); expect(credits()).toEqual([]);
  });

  it('changed digest (the maker edited the script): invoked and verified, still no credit; the mismatch is recorded', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    liveSkill(); const g = goalIn('treatment'); seedGoal(g, MUTATION); writeAssignment(g);
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}process.exit(0)\n`);
    const route = observeSkillInvocation(db, 'run-1', invoked(), repo)!;
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(leaseRoute()).toMatchObject({ invoked: true, digest_ok: false, credited: false });
    expect(JSON.parse(outcome().refs)).toContain('skill_route:treatment:digest_mismatch');
    expect(outcome().capability_id).toBeNull(); expect(credits()).toEqual([]);
  });

  it('holdout arm: even a spontaneous invocation that passes is recorded, never credited', async () => {
    const { route } = observed('holdout', invoked());
    expect(route).toMatchObject({ arm: 'holdout', delivered: false, invoked: true });
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(JSON.parse(outcome().refs)).toContain('skill_route:holdout:applied');
    expect(outcome().capability_id).toBeNull(); expect(credits()).toEqual([]); expect(leaseCap()).toBeNull();
  });

  it('shadow: an invocation is recorded, nothing is credited', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    liveSkill(); const g = goalIn('treatment'); seedGoal(g, MUTATION); writeAssignment(g);
    const route = observeSkillInvocation(db, 'run-1', invoked(), repo)!;
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    expect(leaseRoute()).toMatchObject({ mode: 'shadow', invoked: true, credited: false });
    expect(credits()).toEqual([]); expect(outcome().capability_id).toBeNull();
  });

  it('shadow/on: a factory capability that was merely shown no longer stamps the lease capability_id (off keeps today, see capability-lineage)', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES ('e1', 'run-1', 'assignment_context', 'info', 'x', ?, datetime('now'))`)
      .run(JSON.stringify({ examples: [], rule_ids: [], capabilities: ['line'], capability_ids: ['capfac:a@1'] }));
    await daemonRun({ deterministic_checks: PASS }, { runtime: 'codex' });
    expect(leaseCap()).toBeNull();
    expect(JSON.parse(outcome().refs)).toContain('capability:capfac:a@1'); // the label stays a label
  });

  it('readout: selected / delivered / invoked / passed / verified / credited per arm and lane; the contrast is descriptive, no effect below n 30 per arm', async () => {
    const { route } = observed('treatment', invoked());
    await daemonRun({ skill_route: route, deterministic_checks: PASS });
    const ev = skillRouteEvidence(db, { SKILL_ROUTE_MODE: 'on' }, '2000-01-01T00:00:00Z');
    expect(ev.mode).toBe('on');
    expect(ev.by_arm_lane).toContainEqual({ arm: 'treatment', lane: 'mutation-gap', selected: 1, delivered: 1, invoked: 1, passed: 1, verified: 1, credited: 1 });
    expect(ev.contrast).toMatchObject({ treatment: { n: 1, verified: 1 }, holdout: { n: 0, verified: 0 }, difference: null, withheld: expect.stringContaining('30') });
    expect(buildEvolutionEvidence(db, { SKILL_ROUTE_MODE: 'on' }, Date.now()).skill_route).toMatchObject({ mode: 'on' });
  });
});

describe('Gap A: strategy genome credit needs delivery', () => {
  const stubLoops = () => ({
    startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'finding-1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
    continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'codex' }, { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' }] })),
    executeWorker: vi.fn(async () => ({})),
    runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
    retryLoopRun: vi.fn(), executeChecker: vi.fn(async () => ({})),
    verifyLoopRun: vi.fn(() => ({ gates: [{ name: 'checker_verdict', status: 'pass' }] })),
    pruneOrphanedWorktrees: vi.fn(),
  });
  const LINE = 'Run the narrowest failing test first, then the package suite.';
  async function daemonWithGenome(assignment: string) {
    vi.stubEnv('OUTCOME_ATTRIBUTION_ENABLED', 'true'); vi.stubEnv('DREAM_EVOLUTION_SPECIES', 'codex');
    db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-play', 'baseline', 'playbook', ?, 'dream', 'active', datetime('now'), datetime('now'))`)
      .run(JSON.stringify([LINE]));
    const file = path.join(repo, 'LOOP_WORK.md'); fs.writeFileSync(file, assignment);
    const goal = new GoalService(db).createGoal({ objective: 'Fix a small doc drift issue', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('maker-1', 'run-1', 'maker', 'codex', 'prepared', ?, ?, ?)`)
      .run(JSON.stringify({ assignment_file: file }), now, now);
    const daemon = new LoopDaemon(db, stubLoops() as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
    const meta = JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'maker-1'").get() as { metadata: string }).metadata) as Record<string, any>;
    const refs = JSON.parse((db.prepare('SELECT evidence_refs_json AS r FROM skill_outcomes').get() as { r: string }).r) as string[];
    const strategy = (db.prepare("SELECT ref FROM outcome_credits WHERE kind = 'genome' AND ref LIKE 'strategy:%'").all() as Array<{ ref: string }>).map((r) => r.ref);
    return { meta, refs, strategy };
  }

  it('genomeDelivery reuses the gym fire check: all lines in the maker text = delivered; baseline (no lines) has nothing to deliver', () => {
    const g = { id: 'g-x', parent_id: null, gene: 'playbook', lines: [LINE], origin: 'dream', status: 'active' };
    db.prepare(`INSERT INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, created_at, updated_at) VALUES ('g-x', NULL, 'playbook', ?, 'dream', 'active', datetime('now'), datetime('now'))`).run(JSON.stringify([LINE]));
    expect(genomeDelivery(db, g, `# A\n- ${LINE}\n`)).toMatchObject({ delivered: true, genome_lines: 1, genome_lines_found: 1 });
    expect(genomeDelivery(db, g, '# A\n')).toMatchObject({ delivered: false, genome_lines: 1, genome_lines_found: 0, reason: expect.stringContaining('fire_check') });
    expect(genomeDelivery(db, { ...g, id: 'baseline', lines: [] }, '')).toMatchObject({ delivered: true, genome_lines: 0 });
  });

  it('shadow/on: a promoted genome whose lines never reached the maker is stamped undelivered — no strategy credit, ref or content hash', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
    const { meta, refs, strategy } = await daemonWithGenome('# Assignment\n\n## Rules\n');
    expect(meta.genome_id).toBeUndefined();
    expect(meta.genome_undelivered).toMatchObject({ genome_id: 'g-play', genome_lines: 1, genome_lines_found: 0 });
    expect(refs).toContain('strategy_genome_undelivered:g-play');
    expect(refs.some((r) => r.startsWith('strategy_genome:'))).toBe(false);
    expect(strategy).toEqual([]);
  });

  it('shadow/on: lines that are in the maker assignment → stamped and credited as before', async () => {
    vi.stubEnv('SKILL_ROUTE_MODE', 'on');
    const { meta, refs, strategy } = await daemonWithGenome(`# Assignment\n\n- ${LINE}\n`);
    expect(meta.genome_id).toBe('g-play');
    expect(meta.genome_delivery).toMatchObject({ delivered: true, genome_lines_found: 1 });
    expect(refs).toContain('strategy_genome:g-play');
    expect(strategy).toEqual(['strategy:g-play']);
  });

  it('off: today (stamped and credited without a delivery check)', async () => {
    const { meta, strategy } = await daemonWithGenome('# Assignment\n');
    expect(meta.genome_id).toBe('g-play');
    expect(meta.genome_undelivered).toBeUndefined();
    expect(strategy).toEqual(['strategy:g-play']);
  });
});
