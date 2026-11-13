import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
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
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { recordTreatmentEnvBoundaries } from '../services/experiment-registry';
import { skillValidationTestsMode } from '../services/skill-route';

/**
 * SKILL_VALIDATION_REQUIRES_TESTS=off|on (default off = today). Skillware (arXiv 2611.07652): a skill bundle carries its own
 * tests, and validation must prove they pass for the exact artifact being validated. on: registration needs `tests` (repo-relative
 * test files, sha256 stored next to the artifact digest); validation needs a `test_receipt` whose commit is the server's built
 * commit, whose test file shas match the registered ones and the files on disk, while the script still hashes to its digest.
 * The server never runs tests: scripts/skill-test-receipt.mjs produces the receipt in an operator/CI checkout.
 */
const SCRIPT = 'scripts/skills/oracle-gate.mjs';
const TEST = 'scripts/skills/oracle-gate.test.mjs';
const STUB = "#!/usr/bin/env node\nconsole.log('ORACLE_GATE ' + JSON.stringify({ pass: true }));\n";
const TEST_STUB = "import test from 'node:test';\ntest('gate', () => {});\n";
const COMMIT = 'a'.repeat(40);
const RECEIPT_SCRIPT = path.resolve(__dirname, '../../../../scripts/skill-test-receipt.mjs');
const sha = (s: string | Buffer) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
let db: Database.Database; let repo: string; let admin: string; let auth: ReturnType<typeof createAuthMiddleware>;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltests-'));
  fs.mkdirSync(path.join(repo, 'scripts/skills'), { recursive: true });
  fs.writeFileSync(path.join(repo, SCRIPT), STUB);
  fs.writeFileSync(path.join(repo, TEST), TEST_STUB);
  vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
  vi.stubEnv('SKILL_ROUTE_MODE', 'shadow');
  vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', '');
  vi.stubEnv('DJIMITFLO_BUILD_COMMIT', COMMIT);
  const authService = new AuthService(db);
  admin = authService.generateToken(authService.createUser('skilltests-admin@example.test', 'disposable-password', UserRole.ADMIN));
  auth = createAuthMiddleware(authService);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

const app = () => express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json())
  .use('/api/capabilities', auth.requireAuth, createCapabilityRoutes(db, auth)).use(errorHandler);
const SKILL = { name: 'oracle-gate', lanes: ['mutation-gap', 'test-gap'], script_path: SCRIPT, oracle: 'daemon check scripts exit 0 and mutation-gain pass:true' };
const register = (body: object) => request(app()).post('/api/capabilities/skills').set('Authorization', `Bearer ${admin}`).send(body);
const validate = (body: object, id = 'skill:oracle-gate') => request(app()).post(`/api/capabilities/skills/${encodeURIComponent(id)}/validate`).set('Authorization', `Bearer ${admin}`).send(body);
const receipt = (over: Record<string, unknown> = {}) => ({ commit: COMMIT, test_files: [{ path: TEST, sha256: sha(TEST_STUB) }], result: 'pass',
  runner: 'node --test scripts/skills/oracle-gate.test.mjs', ran_at: '2026-11-07T12:00:00.000Z', ...over });
const status = () => (db.prepare("SELECT status FROM swarm_capabilities WHERE id = 'skill:oracle-gate'").get() as { status: string }).status;
const meta = () => JSON.parse((db.prepare("SELECT metadata FROM swarm_capabilities WHERE id = 'skill:oracle-gate'").get() as { metadata: string }).metadata);
const boundaries = () => (db.prepare('SELECT COUNT(*) AS n FROM experiment_period_boundaries').get() as { n: number }).n;
const code = (res: request.Response) => res.body.error?.code ?? res.body.code;

describe('flag', () => {
  it('SKILL_VALIDATION_REQUIRES_TESTS is off unless on; an acting evolution flag; not a treatment variable (validation writes its own boundary)', () => {
    expect(skillValidationTestsMode({})).toBe('off');
    expect(skillValidationTestsMode({ SKILL_VALIDATION_REQUIRES_TESTS: 'shadow' })).toBe('off');
    expect(skillValidationTestsMode({ SKILL_VALIDATION_REQUIRES_TESTS: 'on' })).toBe('on');
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'SKILL_VALIDATION_REQUIRES_TESTS', acting: true });
    recordTreatmentEnvBoundaries(db, { SKILL_VALIDATION_REQUIRES_TESTS: 'off' }, Date.parse('2026-11-01T00:00:00Z'));
    expect(recordTreatmentEnvBoundaries(db, { SKILL_VALIDATION_REQUIRES_TESTS: 'on' }, Date.parse('2026-11-02T00:00:00Z'))).toEqual([]);
  });
});

describe('off: today', () => {
  it('registers without tests (metadata has no tests key) and validates without a receipt', async () => {
    expect((await register(SKILL)).status).toBe(201);
    expect(meta()).not.toHaveProperty('tests');
    const res = await validate({ evidence_refs: ['replay:23/23'] });
    expect(res.status).toBe(200);
    expect(res.body.capability).toMatchObject({ status: 'validated' });
    expect(res.body.capability.metadata).not.toHaveProperty('validation_test_receipt');
  });
});

describe('on: registration requires tests and pins their sha256', () => {
  beforeEach(() => { vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', 'on'); });

  it('refuses a registration without tests, with a missing test file or a traversal', async () => {
    const none = await register(SKILL);
    expect(none.status).toBe(400);
    expect(code(none)).toBe('SKILL_TESTS_REQUIRED');
    expect((await register({ ...SKILL, tests: ['scripts/skills/missing.test.mjs'] })).status).toBe(400);
    expect((await register({ ...SKILL, tests: ['scripts/skills/../../../etc/passwd'] })).status).toBe(400);
    expect((await register({ ...SKILL, tests: ['README.md'] })).status).toBe(400); // not a test file
    expect((db.prepare('SELECT COUNT(*) AS n FROM swarm_capabilities').get() as { n: number }).n).toBe(0);
  });

  it('stores each test file sha256 next to the artifact digest', async () => {
    const res = await register({ ...SKILL, tests: [TEST] });
    expect(res.status).toBe(201);
    expect(res.body.capability.metadata).toMatchObject({ artifact_digest: sha(STUB), tests: [{ path: TEST, sha256: sha(TEST_STUB) }] });
  });

  it('an existing candidate registered without tests gets its test contract on re-registration (same version)', async () => {
    vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', '');
    await register(SKILL);
    vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', 'on');
    const res = await register({ ...SKILL, tests: [TEST] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'exists', capability: { status: 'candidate', metadata: { tests: [{ path: TEST, sha256: sha(TEST_STUB) }] } } });
  });
});

describe('on: validation needs a test receipt for the exact artifact', () => {
  beforeEach(async () => {
    vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', 'on');
    expect((await register({ ...SKILL, tests: [TEST] })).status).toBe(201);
  });
  const refused = async (body: object, why: RegExp) => {
    const res = await validate(body);
    expect(res.status).toBe(409);
    expect(code(res)).toBe('SKILL_TESTS_UNPROVEN');
    expect(res.body.error?.message ?? res.body.message).toMatch(why);
    expect(status()).toBe('candidate');
    expect(boundaries()).toBe(0);
  };

  it('refuses without a receipt', async () => {
    await refused({ evidence_refs: ['replay:23/23'] }, /test_receipt/);
  });

  it('refuses a receipt whose test file sha256 differs from the registered one', async () => {
    await refused({ evidence_refs: ['x'], test_receipt: receipt({ test_files: [{ path: TEST, sha256: sha('other') }] }) }, /sha256/);
  });

  it('refuses when the test file on disk changed after registration', async () => {
    fs.writeFileSync(path.join(repo, TEST), `${TEST_STUB}// changed\n`);
    await refused({ evidence_refs: ['x'], test_receipt: receipt() }, /on disk/);
  });

  it('refuses a receipt that misses a declared test file', async () => {
    await refused({ evidence_refs: ['x'], test_receipt: receipt({ test_files: [{ path: 'scripts/skills/other.test.mjs', sha256: sha(TEST_STUB) }] }) }, /declared/);
  });

  it('refuses a receipt from another commit than the server was built from, or when the built commit is unknown', async () => {
    await refused({ evidence_refs: ['x'], test_receipt: receipt({ commit: 'b'.repeat(40) }) }, /built commit/);
    vi.stubEnv('DJIMITFLO_BUILD_COMMIT', 'unknown');
    await refused({ evidence_refs: ['x'], test_receipt: receipt() }, /built commit/);
  });

  it('refuses a failed receipt', async () => {
    await refused({ evidence_refs: ['x'], test_receipt: receipt({ result: 'fail' }) }, /pass/);
  });

  it('refuses when the script changed since registration (the receipt does not prove this artifact)', async () => {
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}// tampered\n`);
    await refused({ evidence_refs: ['x'], test_receipt: receipt() }, /digest/);
  });

  it('accepts a good receipt, validates once and records the receipt on the validation', async () => {
    const res = await validate({ evidence_refs: ['replay:23/23'], test_receipt: receipt() });
    expect(res.status).toBe(200);
    expect(res.body.capability).toMatchObject({ status: 'validated', metadata: { validation_test_receipt: receipt() } });
    expect(boundaries()).toBeGreaterThan(0);
  });
});

describe('scripts/skill-test-receipt.mjs round trip', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const runReceipt = (cwd: string, ...files: string[]) => spawnSync(process.execPath, [RECEIPT_SCRIPT, ...files], { cwd, encoding: 'utf8' });

  it('the receipt of a passing test file in a clean checkout passes the server check; a failing or dirty one exits 1', async () => {
    git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'skill');
    const head = git(repo, 'rev-parse', 'HEAD');
    const out = runReceipt(repo, TEST);
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout);
    expect(r).toMatchObject({ commit: head, result: 'pass', test_files: [{ path: TEST, sha256: sha(TEST_STUB) }] });
    expect(typeof r.runner).toBe('string'); expect(Number.isNaN(Date.parse(r.ran_at))).toBe(false);

    vi.stubEnv('SKILL_VALIDATION_REQUIRES_TESTS', 'on');
    vi.stubEnv('DJIMITFLO_BUILD_COMMIT', head);
    expect((await register({ ...SKILL, tests: [TEST] })).status).toBe(201);
    const res = await validate({ evidence_refs: ['receipt'], test_receipt: r });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.capability.status).toBe('validated');

    // uncommitted change: the receipt would not describe the commit
    fs.writeFileSync(path.join(repo, SCRIPT), `${STUB}// dirty\n`);
    const dirty = runReceipt(repo, TEST);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toBe('');
    git(repo, 'checkout', '--', SCRIPT);

    fs.writeFileSync(path.join(repo, TEST), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('gate', () => assert.equal(1, 2));\n");
    git(repo, 'commit', '-qam', 'break');
    const failed = runReceipt(repo, TEST);
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ result: 'fail' });
    expect(runReceipt(repo).status).not.toBe(0); // no test files: usage
    expect(runReceipt(repo, '--bogus', TEST).status).not.toBe(0);
  }, 60_000);
});
