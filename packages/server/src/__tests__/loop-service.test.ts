import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createGoalRoutes } from '../routes/goals';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let tempDir: string;
let worktreeRoot: string;
let previousCodexBinPath: string | undefined;
let previousOpencodeBinPath: string | undefined;
let previousJwtSecret: string | undefined;
let previousRuntimeEnvPassthrough: string | undefined;
const JWT_SECRET_ENV = ['JWT', 'SECRET'].join('_');

const auth = {
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
} as any;

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/goals', createGoalRoutes(db, auth));
  app.use('/loops', createLoopRoutes(db, auth, path.join(tempDir, 'agent-evidence')));
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function installFakeCodex(lines: string[]) {
  const fakeCodexPath = path.join(tempDir, 'fake-codex.js');
  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    'if (process.argv.includes("--help")) { console.log("Usage: codex exec [OPTIONS] [PROMPT]\\n      --json\\n      --cd <DIR>"); process.exit(0); }',
    'if (process.argv.includes("exec") && process.argv.includes("--help")) { console.log("Usage: codex exec [OPTIONS] [PROMPT]"); process.exit(0); }',
    ...lines,
    '',
  ].join('\n'));
  fs.chmodSync(fakeCodexPath, 0o755);
  process.env.CODEX_BIN_PATH = fakeCodexPath;
  return fakeCodexPath;
}

function installFakeOpencode(lines: string[]) {
  const fakeOpencodePath = path.join(tempDir, 'fake-opencode.js');
  fs.writeFileSync(fakeOpencodePath, [
    '#!/usr/bin/env node',
    'if (process.argv[2] === \"--version\") { console.log(\"fake-opencode 1.0.0\"); process.exit(0); }',
    'if (process.argv.includes(\"run\") && process.argv.includes(\"--help\")) { console.log(\"Usage: opencode run --format json --dir <DIR> [PROMPT]\"); process.exit(0); }',
    ...lines,
    '',
  ].join('\n'));
  fs.chmodSync(fakeOpencodePath, 0o755);
  process.env.OPENCODE_BIN_PATH = fakeOpencodePath;
  return fakeOpencodePath;
}

describe('doc-drift-and-small-fix-loop', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-loop-'));
    worktreeRoot = path.join(os.tmpdir(), `.djimitflo-loop-worktrees-${path.basename(tempDir)}`);
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
    previousCodexBinPath = process.env.CODEX_BIN_PATH;
    previousJwtSecret = process.env[JWT_SECRET_ENV];
    previousRuntimeEnvPassthrough = process.env.RUNTIME_ENV_PASSTHROUGH;
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        'type-check': 'node -e "process.exit(0)"',
      },
    }, null, 2));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'loop-test@example.invalid'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: tempDir });
    await startApp();
    previousOpencodeBinPath = process.env.OPENCODE_BIN_PATH;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    delete process.env.LOOP_WORKTREE_ROOT;
    if (previousCodexBinPath) {
      process.env.CODEX_BIN_PATH = previousCodexBinPath;
    } else {
      delete process.env.CODEX_BIN_PATH;
    }
    if (previousOpencodeBinPath) {
      process.env.OPENCODE_BIN_PATH = previousOpencodeBinPath;
    } else {
      delete process.env.OPENCODE_BIN_PATH;
    }
    if (previousJwtSecret) {
      process.env[JWT_SECRET_ENV] = previousJwtSecret;
    } else {
      delete process.env[JWT_SECRET_ENV];
    }
    if (previousRuntimeEnvPassthrough) {
      process.env.RUNTIME_ENV_PASSTHROUGH = previousRuntimeEnvPassthrough;
    } else {
      delete process.env.RUNTIME_ENV_PASSTHROUGH;
    }
  });

  it('rejects goals without measurable acceptance criteria', async () => {
    const response = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'Improve docs', acceptance_criteria: [] }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
  });

  it('creates a goal and decomposes it to the doc drift loop', async () => {
    const createResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Find low-risk docs drift',
        acceptance_criteria: ['Loop emits bounded findings without editing files'],
      }),
    });
    expect(createResponse.status).toBe(201);
    const goal = await createResponse.json() as any;

    const updateResponse = await fetch(`${baseUrl}/goals/${goal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constraints: ['read-only first slice'] }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as any;
    expect(updated.constraints).toEqual(['read-only first slice']);

    const decomposeResponse = await fetch(`${baseUrl}/goals/${goal.id}/decompose`, { method: 'POST' });
    expect(decomposeResponse.status).toBe(200);
    const decomposed = await decomposeResponse.json() as any;
    expect(decomposed.candidates[0]).toMatchObject({
      loop_name: 'doc-drift-and-small-fix-loop',
      mode: 'closed',
      recommended_first: true,
    });
  });

  it('runs read-only discovery, writes state, and proposes bounded small-fix tasks', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), [
      '# Test Repo',
      '',
      'Run `npm run missing-script` before release.',
      '',
      'See [Missing](docs/missing.md).',
      '',
      'TODO: replace stale setup note.',
      '',
    ].join('\n'));

    const response = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir, max_findings: 10 }),
    });

    expect(response.status).toBe(201);
    const run = await response.json() as any;
    expect(run.loop_name).toBe('doc-drift-and-small-fix-loop');
    expect(run.mode).toBe('closed');
    expect(run.status).toBe('completed');
    expect(run.metadata).toMatchObject({ dry_run: true, workers_leased: 0, mutating_actions: false });
    expect(run.findings.map((finding: any) => finding.type)).toEqual(expect.arrayContaining([
      'missing_script_reference',
      'broken_relative_link',
      'doc_todo',
    ]));
    expect(run.plan.proposed_tasks).toHaveLength(run.findings.length);
    expect(fs.existsSync(run.state_file)).toBe(true);
    const state = fs.readFileSync(run.state_file, 'utf8');
    expect(state).toContain('read_only_discovery: pass');
    expect(state).toContain('Review proposed small-fix tasks');
  });

  it('supports generic loop start, step, and stop aliases', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');

    const startResponse = await fetch(`${baseUrl}/loops/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loop_name: 'doc-drift-and-small-fix-loop',
        repository_path: tempDir,
      }),
    });
    expect(startResponse.status).toBe(201);
    const run = await startResponse.json() as any;
    expect(run.loop_name).toBe('doc-drift-and-small-fix-loop');

    const stepResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/step`, { method: 'POST' });
    expect(stepResponse.status).toBe(200);
    const step = await stepResponse.json() as any;
    expect(step.decision).toBe('continue');
    expect(step.next_actions).toEqual(expect.arrayContaining([
      'Review proposed small-fix tasks',
    ]));

    const stopResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/stop`, { method: 'POST' });
    expect(stopResponse.status).toBe(200);
    const stopped = await stopResponse.json() as any;
    expect(stopped.run.status).toBe('cancelled');
    expect(stopped.events.map((event: any) => event.event_type)).toContain('loop_stopped');
  });

  it('exposes and starts the closed-loop catalog beyond doc drift', { timeout: 20_000 }, async () => {
    fs.mkdirSync(path.join(tempDir, 'packages', 'knowledge', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'packages', 'knowledge', 'skills', 'draft-loop.md'), [
      '---',
      'type: Skill',
      'title: "Draft Loop"',
      'description: "Draft loop skill"',
      'status: draft',
      'trust_level: proposed',
      'actions_allowed: [read_repo]',
      'actions_forbidden: [deploy]',
      'gates: [checker_verdict]',
      'escalation: [high_risk_scope]',
      '---',
      '',
      '# Draft Loop',
      '',
    ].join('\n'));

    const catalogResponse = await fetch(`${baseUrl}/loops/catalog`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as any;
    expect(catalog.loops.map((loop: any) => loop.name)).toEqual(expect.arrayContaining([
      'doc-drift-and-small-fix-loop',
      'repo-maintenance-loop',
      'skill-quality-loop',
      'mcp-connector-validation-loop',
      'security-regression-loop',
      'okf-synchronization-loop',
      'overwatch-policy-drift-loop',
    ]));
    expect(catalog.loops.find((loop: any) => loop.name === 'security-regression-loop')).toMatchObject({
      mode: 'closed',
      risk_class: 'high',
      status: 'implemented',
    });

    const skillLoopResponse = await fetch(`${baseUrl}/loops/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loop_name: 'skill-quality-loop',
        repository_path: tempDir,
      }),
    });
    expect(skillLoopResponse.status).toBe(201);
    const skillRun = await skillLoopResponse.json() as any;
    expect(skillRun.loop_name).toBe('skill-quality-loop');
    expect(skillRun.findings.map((finding: any) => finding.type)).toContain('draft_loop_skill');
    expect(skillRun.plan.proposed_tasks[0]).toMatchObject({
      maker_role: 'skill-quality-loop-maker',
      checker_role: 'skill-quality-loop-checker',
      risk_class: 'medium',
    });

    const unsupportedResponse = await fetch(`${baseUrl}/loops/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loop_name: 'unknown-loop',
        repository_path: tempDir,
      }),
    });
    expect(unsupportedResponse.status).toBe(400);
    const unsupported = await unsupportedResponse.json() as any;
    expect(unsupported.error.code).toBe('LOOP_NAME_UNSUPPORTED');
  });

  it('enforces security checker leases for high-risk catalog loops', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document auth token handling\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loop_name: 'security-regression-loop',
        repository_path: tempDir,
      }),
    });
    expect(startResponse.status).toBe(201);
    const run = await startResponse.json() as any;
    expect(run.metadata.risk_class).toBe('high');
    expect(run.findings.length).toBeGreaterThan(0);
    expect(run.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'security_checker_verdict', status: 'skipped' }),
    ]));

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'manual' }),
    });
    expect(continueResponse.status).toBe(201);
    const continued = await continueResponse.json() as any;
    expect(continued.leases.filter((lease: any) => lease.role === 'maker')).toHaveLength(1);
    expect(continued.leases.filter((lease: any) => lease.role === 'checker')).toHaveLength(1);
    expect(continued.leases.filter((lease: any) => lease.role === 'security_checker')).toHaveLength(1);
  });

  it('continues by preparing isolated maker/checker leases and verifies gates', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), [
      'TODO: document setup',
      'Run `npm run missing-script` before release.',
      '',
    ].join('\n'));
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 2, runtime: 'manual' }),
    });

    expect(continueResponse.status).toBe(201);
    const continued = await continueResponse.json() as any;
    expect(continued.run.status).toBe('running');
    expect(continued.leases).toHaveLength(4);
    const makers = continued.leases.filter((lease: any) => lease.role === 'maker');
    const checkers = continued.leases.filter((lease: any) => lease.role === 'checker');
    expect(makers).toHaveLength(2);
    expect(checkers).toHaveLength(2);
    expect(new Set(makers.map((lease: any) => lease.worktree_path)).size).toBe(2);
    for (const maker of makers) {
      expect(fs.existsSync(maker.worktree_path)).toBe(true);
      expect(fs.existsSync(path.join(maker.worktree_path, '.djimitflo', 'LOOP_WORK.md'))).toBe(true);
      expect(fs.existsSync(path.join(maker.worktree_path, 'LOOP_WORK.md'))).toBe(false);
      expect(maker.metadata.assignment_packet_file).toBe(path.join(maker.worktree_path, '.djimitflo', 'ASSIGNMENT_PACKET.json'));
      expect(fs.existsSync(maker.metadata.assignment_packet_file)).toBe(true);
      const packet = JSON.parse(fs.readFileSync(maker.metadata.assignment_packet_file, 'utf8'));
      expect(packet).toMatchObject({
        loop_run_id: run.id,
        runtime: 'manual',
        allowed_actions: ['read_repo', 'edit_files', 'run_tests', 'write_artifacts'],
        forbidden_actions: ['merge', 'push', 'deploy', 'modify_secrets', 'modify_policy', 'delete_data'],
        expected_artifacts: ['diff', 'stdout_log', 'stderr_log', 'deterministic_check_results'],
      });
      expect(packet.finding.id).toBe(maker.finding_id);
    }

    const verifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });

    expect(verifyResponse.status).toBe(200);
    const verified = await verifyResponse.json() as any;
    expect(verified.run.status).toBe('verifying');
    expect(verified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'maker_checker_separation', status: 'pass' }),
      expect.objectContaining({ name: 'worktree_isolation', status: 'pass' }),
      expect.objectContaining({ name: 'assignment_file_present', status: 'pass' }),
    ]));
  });

  it('blocks worker leasing when maker budget would be exceeded', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), [
      'TODO: document setup',
      'Run `npm run missing-script` before release.',
      '',
    ].join('\n'));
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Bounded doc loop',
        acceptance_criteria: ['Worker budget blocks excess maker leases'],
        budget: { max_maker_workers: 1 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    expect(run.findings.length).toBeGreaterThanOrEqual(2);

    const overBudgetResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 2, runtime: 'manual' }),
    });

    expect(overBudgetResponse.status).toBe(409);
    const body = await overBudgetResponse.json() as any;
    expect(body.error.code).toBe('LOOP_WORKER_BUDGET_EXHAUSTED');

    const runsResponse = await fetch(`${baseUrl}/loops/runs/${run.id}`);
    const unchangedRun = await runsResponse.json() as any;
    expect(unchangedRun.status).toBe('completed');
  });

  it('blocks Codex worker leasing when runtime probe fails', async () => {
    process.env.CODEX_BIN_PATH = path.join(tempDir, 'missing-codex');
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });

    expect(continueResponse.status).toBe(409);
    const body = await continueResponse.json() as any;
    expect(body.error.code).toBe('RUNTIME_UNAVAILABLE');

    const runResponse = await fetch(`${baseUrl}/loops/runs/${run.id}`);
    const unchangedRun = await runResponse.json() as any;
    expect(unchangedRun.status).toBe('completed');
  });

  it('executes a codex maker lease, captures output, and enforces diff threshold', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'if (!process.argv.includes("--json")) { console.error("missing --json"); process.exit(2); }',
      'if (!process.argv.includes("--cd")) { console.error("missing --cd"); process.exit(2); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", "Setup is documented."));',
      'console.log(JSON.stringify({ type: "text", part: { type: "text", text: "patched README" } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });

    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease.status).toBe('completed');
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'pass' }),
      expect.objectContaining({ name: 'diff_under_threshold', status: 'pass' }),
    ]));
    expect(fs.readFileSync(path.join(maker.worktree_path, 'README.md'), 'utf8')).toContain('Setup is documented.');
    expect(fs.existsSync(executed.stdout_path)).toBe(true);
    expect(fs.readFileSync(executed.stdout_path, 'utf8')).toContain('patched README');

    process.env[JWT_SECRET_ENV] = 'server side check script secret';
    delete process.env.RUNTIME_ENV_PASSTHROUGH;
    expect(maker.worktree_path).toBeTruthy();
    const worktreePackagePath = path.join(maker.worktree_path, 'package.json');
    const worktreePackage = JSON.parse(fs.readFileSync(worktreePackagePath, 'utf8'));
    worktreePackage.scripts.test = 'node -e "require(\'fs\').writeFileSync(\'env-leak.txt\', process.env.JWT_SECRET || \'missing\')"';
    fs.writeFileSync(worktreePackagePath, JSON.stringify(worktreePackage, null, 2));

    const preCheckerVerifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(preCheckerVerifyResponse.status).toBe(200);
    const preCheckerVerified = await preCheckerVerifyResponse.json() as any;
    expect(preCheckerVerified.run.status).toBe('blocked');
    expect(preCheckerVerified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'checker_verdict', status: 'fail' }),
      expect.objectContaining({ name: 'tests_lint_typecheck', status: 'fail' }),
    ]));

    const blockedCompleteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, { method: 'POST' });
    expect(blockedCompleteResponse.status).toBe(409);
    const blockedComplete = await blockedCompleteResponse.json() as any;
    expect(blockedComplete.error.code).toBe('LOOP_COMPLETION_BLOCKED');

    const checksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    expect(checksResponse.status).toBe(200);
    const checks = await checksResponse.json() as any;
    expect(checks.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'test', status: 'pass' }),
      expect.objectContaining({ name: 'lint', status: 'pass' }),
      expect.objectContaining({ name: 'type-check', status: 'pass' }),
    ]));
    expect(fs.existsSync(checks.checks[0].stdout_path)).toBe(true);
    expect(fs.readFileSync(path.join(maker.worktree_path, 'env-leak.txt'), 'utf8')).toBe('missing');

    const checker = continued.leases.find((lease: any) => lease.role === 'checker');
    const verdictResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/checker-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: checker.id, verdict: 'accepted', notes: 'Small docs fix accepted.' }),
    });
    expect(verdictResponse.status).toBe(200);
    const verdict = await verdictResponse.json() as any;
    expect(verdict.checker.status).toBe('completed');
    expect(verdict.checker.metadata.verdict).toBe('accepted');
    expect(verdict.run.status).toBe('ready_for_human_merge');

    const postCheckerVerifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(postCheckerVerifyResponse.status).toBe(200);
    const postCheckerVerified = await postCheckerVerifyResponse.json() as any;
    expect(postCheckerVerified.run.status).toBe('ready_for_human_merge');
    expect(postCheckerVerified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'diff_threshold_all_makers', status: 'pass' }),
      expect.objectContaining({ name: 'checker_verdict', status: 'pass' }),
      expect.objectContaining({ name: 'tests_lint_typecheck', status: 'pass' }),
    ]));

    const unapprovedCompleteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, { method: 'POST' });
    expect(unapprovedCompleteResponse.status).toBe(409);
    const unapprovedComplete = await unapprovedCompleteResponse.json() as any;
    expect(unapprovedComplete.error.code).toBe('LOOP_HUMAN_APPROVAL_REQUIRED');

    const completeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ human_approval_ref: 'approval:small-docs-fix' }),
    });
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as any;
    expect(completed.run.status).toBe('completed');
    expect(completed.run.completed_at).toEqual(expect.any(String));
    expect(completed.run.metadata.human_approval_ref).toBe('approval:small-docs-fix');

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.run.id).toBe(run.id);
    expect(bundle.leases.length).toBeGreaterThanOrEqual(2);
    expect(bundle.events.map((event: any) => event.event_type)).toEqual(expect.arrayContaining([
      'maker_executed',
      'deterministic_checks_completed',
      'checker_verdict_submitted',
      'loop_completed',
    ]));
    expect(bundle.state_content).toContain('doc-drift-and-small-fix-loop');
  });

  it('executes a prepared worker through the spawn bridge with mock runtime, traces, checkpoints, and artifacts', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'mock' }),
    });
    expect(continueResponse.status).toBe(201);
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');
    expect(maker).toMatchObject({ runtime: 'mock', status: 'prepared' });
    expect(fs.lstatSync(path.join(maker.worktree_path, 'node_modules')).isSymbolicLink()).toBe(true);

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-worker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });

    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease).toMatchObject({
      id: maker.id,
      status: 'completed',
      metadata: {
        runtime_adapter: 'mock',
        checkpoint_before_id: expect.any(String),
        checkpoint_after_id: expect.any(String),
        trace_id: expect.any(String),
        runtime_usage: {
          total_tokens: 3,
          usage_source: 'runtime_stdout',
        },
      },
    });
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'pass' }),
      expect.objectContaining({ name: 'diff_under_threshold', status: 'pass' }),
    ]));
    expect(fs.existsSync(executed.stdout_path)).toBe(true);
    // L1: the mock runtime now logs a stable `[mock-worker]` marker (it is a real
    // best-effort nested-spawn client, not the old "mock worker completed" echo).
    expect(fs.readFileSync(executed.stdout_path, 'utf8')).toContain('[mock-worker] starting');
    expect(executed.checkpoint_before.id).toBe(executed.lease.metadata.checkpoint_before_id);
    expect(executed.checkpoint_after.id).toBe(executed.lease.metadata.checkpoint_after_id);
    expect(executed.checkpoint_before.leases.find((lease: any) => lease.id === maker.id).status).toBe('prepared');
    expect(executed.checkpoint_after.leases.find((lease: any) => lease.id === maker.id).status).toBe('completed');
    expect(executed.trace.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ span_type: 'worker', status: 'running' }),
      expect.objectContaining({ span_type: 'worker', status: 'ok' }),
    ]));

    const checksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    expect(checksResponse.status).toBe(200);

    const checker = continued.leases.find((lease: any) => lease.role === 'checker');
    const checkerResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-checker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: checker.id, runtime: 'mock', timeout_ms: 10_000 }),
    });
    expect(checkerResponse.status).toBe(200);
    const checkerExecuted = await checkerResponse.json() as any;
    expect(checkerExecuted.lease).toMatchObject({
      id: checker.id,
      runtime: 'mock',
      status: 'completed',
      metadata: {
        runtime_adapter: 'mock',
        verdict: 'accepted',
        runtime_usage: {
          total_tokens: 3,
          usage_source: 'runtime_stdout',
        },
      },
    });
    expect(checkerExecuted.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'checker_runtime_exit_zero', status: 'pass' }),
      expect.objectContaining({ name: 'checker_verdict', status: 'pass' }),
      expect.objectContaining({ name: 'checker_read_only_contract', status: 'pass' }),
    ]));
    expect(fs.existsSync(checkerExecuted.stdout_path)).toBe(true);

    const verifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(verifyResponse.status).toBe(200);
    const verified = await verifyResponse.json() as any;
    expect(verified.run.status).toBe('ready_for_human_merge');
    expect(verified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'checker_verdict', status: 'pass' }),
      expect.objectContaining({ name: 'tests_lint_typecheck', status: 'pass' }),
    ]));

    const traceRows = db.prepare('SELECT * FROM agent_trace_spans WHERE trace_id = ? ORDER BY created_at ASC').all(executed.trace.trace_id) as any[];
    const checkpointRows = db.prepare('SELECT * FROM loop_checkpoints WHERE loop_run_id = ? ORDER BY created_at ASC').all(run.id) as any[];
    expect(traceRows.length).toBeGreaterThanOrEqual(2);
    expect(checkpointRows.map((row) => row.id)).toEqual(expect.arrayContaining([
      executed.checkpoint_before.id,
      executed.checkpoint_after.id,
      checkerExecuted.checkpoint_before.id,
      checkerExecuted.checkpoint_after.id,
    ]));
    const manifests = db.prepare('SELECT action, lease_id FROM swarm_runner_manifests WHERE loop_run_id = ? ORDER BY created_at ASC').all(run.id) as any[];
    expect(manifests).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'start', lease_id: maker.id }),
      expect.objectContaining({ action: 'complete', lease_id: maker.id }),
      expect.objectContaining({ action: 'start', lease_id: checker.id }),
      expect.objectContaining({ action: 'complete', lease_id: checker.id }),
    ]));
  });

  it('marks spawned worker execution failed on timeout while preserving trace and checkpoint evidence', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'setTimeout(() => {}, 10_000);',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-worker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 1_000 }),
    });

    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease.status).toBe('failed');
    expect(executed.lease.metadata).toMatchObject({
      timed_out: true,
      runtime_adapter: 'codex',
      checkpoint_before_id: expect.any(String),
      checkpoint_after_id: expect.any(String),
    });
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'maker_runtime_exit_zero', status: 'fail' }),
    ]));
    expect(executed.trace.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ span_type: 'worker', status: 'running' }),
      expect.objectContaining({ span_type: 'worker', status: 'error' }),
    ]));
    expect(executed.run.status).toBe('blocked');
    const manifests = db.prepare('SELECT action, lease_id FROM swarm_runner_manifests WHERE loop_run_id = ? ORDER BY created_at ASC').all(run.id) as any[];
    expect(manifests.find((manifest: any) => manifest.action === 'fail' && manifest.lease_id === maker.id)).toBeTruthy();
  });

  it('retries a maker after checker revision and verifies only the active maker chain', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'const replacement = dir.includes("-retry-1") ? "Setup is fully documented." : "Setup draft documented."; ',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", replacement));',
      'console.log(JSON.stringify({ type: "text", part: { type: "text", text: replacement } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Retry doc fix once',
        acceptance_criteria: ['A rejected maker can be superseded by one retry'],
        budget: { max_retries: 1 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');
    const checker = continued.leases.find((lease: any) => lease.role === 'checker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);

    const checksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    expect(checksResponse.status).toBe(200);

    const revisionResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/checker-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: checker.id, verdict: 'needs_revision', notes: 'Draft wording is insufficient.' }),
    });
    expect(revisionResponse.status).toBe(200);

    const blockedVerifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(blockedVerifyResponse.status).toBe(200);
    const blockedVerify = await blockedVerifyResponse.json() as any;
    expect(blockedVerify.run.status).toBe('blocked');
    expect(blockedVerify.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'checker_verdict', status: 'fail' }),
    ]));

    const retryResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maker_lease_id: maker.id, runtime: 'codex' }),
    });
    expect(retryResponse.status).toBe(201);
    const retry = await retryResponse.json() as any;
    expect(retry.retry_maker.metadata).toMatchObject({
      retry_of_maker_lease_id: maker.id,
      retry_root_maker_lease_id: maker.id,
      retry_attempt: 1,
    });
    expect(retry.retry_maker.worktree_path).not.toBe(maker.worktree_path);
    const supersededOriginal = retry.leases.find((lease: any) => lease.id === maker.id);
    expect(supersededOriginal.metadata.superseded_by_maker_lease_id).toBe(retry.retry_maker.id);

    const retryExecuteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: retry.retry_maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(retryExecuteResponse.status).toBe(200);

    const retryChecksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: retry.retry_maker.id, timeout_ms: 10_000 }),
    });
    expect(retryChecksResponse.status).toBe(200);

    const acceptedRetryResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/checker-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: retry.retry_checker.id, verdict: 'accepted', notes: 'Retry output accepted.' }),
    });
    expect(acceptedRetryResponse.status).toBe(200);

    const verifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(verifyResponse.status).toBe(200);
    const verified = await verifyResponse.json() as any;
    expect(verified.run.status).toBe('ready_for_human_merge');
    expect(verified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'maker_checker_separation', status: 'pass' }),
      expect.objectContaining({ name: 'checker_verdict', status: 'pass' }),
      expect.objectContaining({ name: 'tests_lint_typecheck', status: 'pass' }),
    ]));
    expect(verified.gates.find((gate: any) => gate.name === 'maker_checker_separation').evidence).toContain('1 superseded maker lease');

    const unapprovedCompleteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, { method: 'POST' });
    expect(unapprovedCompleteResponse.status).toBe(409);
    const completeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ human_approval_ref: 'approval:retry-output' }),
    });
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as any;
    expect(completed.run.status).toBe('completed');
  });

  it('blocks retry when the retry budget is exhausted', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'console.error("maker failed intentionally");',
      'process.exit(1);',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Block retry budget',
        acceptance_criteria: ['Retry budget prevents retry leasing'],
        budget: { max_retries: 0 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease.status).toBe('failed');

    const retryResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maker_lease_id: maker.id, runtime: 'codex' }),
    });
    expect(retryResponse.status).toBe(409);
    const body = await retryResponse.json() as any;
    expect(body.error.code).toBe('LOOP_RETRY_BUDGET_EXHAUSTED');
  });

  it('escalates after the configured failure threshold and blocks retry', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", "Setup draft documented."));',
      'console.log("draft patch");',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Escalate repeated doc loop failure',
        acceptance_criteria: ['Failure threshold escalates before another worker is leased'],
        budget: { max_failure_count: 1, max_retries: 1 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');
    const checker = continued.leases.find((lease: any) => lease.role === 'checker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);

    const checksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    expect(checksResponse.status).toBe(200);

    const verdictResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/checker-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: checker.id, verdict: 'needs_revision', notes: 'Escalate after first failed review.' }),
    });
    expect(verdictResponse.status).toBe(200);
    const verdict = await verdictResponse.json() as any;
    expect(verdict.run.status).toBe('escalated');
    expect(verdict.run.next_actions).toEqual(expect.arrayContaining([
      'Human review required before leasing more workers',
    ]));

    const retryResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maker_lease_id: maker.id, runtime: 'codex' }),
    });
    expect(retryResponse.status).toBe(409);
    const retryBody = await retryResponse.json() as any;
    expect(retryBody.error.code).toBe('LOOP_ESCALATED_REQUIRES_HUMAN');

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.events.map((event: any) => event.event_type)).toContain('loop_escalated');
  });

  it('splits an oversized finding into child findings without leasing workers automatically', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup and release process\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    const parentFinding = run.findings.find((finding: any) => finding.type === 'doc_todo');
    expect(parentFinding).toBeTruthy();

    const splitResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        finding_id: parentFinding.id,
        reason: 'Setup and release process should be handled as separate documentation fixes.',
        children: [
          {
            message: 'Document setup process.',
            suggested_fix: 'Replace the TODO with concrete setup documentation.',
          },
          {
            message: 'Document release process.',
            suggested_fix: 'Add a bounded release process note.',
          },
        ],
      }),
    });
    expect(splitResponse.status).toBe(201);
    const split = await splitResponse.json() as any;
    expect(split.run.status).toBe('planning');
    expect(split.parent.metadata.status).toBe('split');
    expect(split.children).toHaveLength(2);
    expect(split.children.every((finding: any) => finding.parent_finding_id === parentFinding.id)).toBe(true);
    expect(split.leases).toHaveLength(0);
    expect(split.run.plan.proposed_tasks.map((task: any) => task.finding_id)).not.toContain(parentFinding.id);

    const blockedParentContinueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finding_ids: [parentFinding.id], max_assignments: 1, runtime: 'manual' }),
    });
    expect(blockedParentContinueResponse.status).toBe(409);
    const blockedParent = await blockedParentContinueResponse.json() as any;
    expect(blockedParent.error.code).toBe('LOOP_FINDING_ALREADY_SPLIT');

    const childContinueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finding_ids: [split.children[0].id], max_assignments: 1, runtime: 'manual' }),
    });
    expect(childContinueResponse.status).toBe(201);
    const continued = await childContinueResponse.json() as any;
    expect(continued.leases.filter((lease: any) => lease.role === 'maker')).toHaveLength(1);
    expect(continued.leases.find((lease: any) => lease.role === 'maker').finding_id).toBe(split.children[0].id);

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.events.map((event: any) => event.event_type)).toContain('finding_split');
  });

  it('captures real runtime token usage and blocks new workers when the token budget is exhausted', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", "Setup is documented."));',
      'console.log(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), [
      'TODO: document setup',
      'TODO: document release',
      '',
    ].join('\n'));
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Enforce token budget',
        acceptance_criteria: ['Real runtime token usage blocks additional workers'],
        budget: { max_tokens: 20, max_maker_workers: 2 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    expect(run.findings.filter((finding: any) => finding.type === 'doc_todo')).toHaveLength(2);

    const firstFinding = run.findings.find((finding: any) => finding.type === 'doc_todo');
    const secondFinding = run.findings.find((finding: any) => finding.type === 'doc_todo' && finding.id !== firstFinding.id);
    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finding_ids: [firstFinding.id], max_assignments: 1, runtime: 'codex' }),
    });
    expect(continueResponse.status).toBe(201);
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease.metadata.runtime_usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 15,
      total_tokens: 25,
      usage_source: 'runtime_stdout',
    });
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'token_budget', status: 'fail' }),
    ]));
    expect(executed.run.status).toBe('blocked');

    const blockedContinueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finding_ids: [secondFinding.id], max_assignments: 1, runtime: 'codex' }),
    });
    expect(blockedContinueResponse.status).toBe(409);
    const blocked = await blockedContinueResponse.json() as any;
    expect(blocked.error.code).toBe('LOOP_TOKEN_BUDGET_EXHAUSTED');

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.events.map((event: any) => event.event_type)).toContain('loop_budget_exhausted');
  });

  it('marks low-risk workers as budget-risk when token efficiency exceeds threshold without exhausting hard budget', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", "Setup is documented."));',
      'console.log(JSON.stringify({ usage: { prompt_tokens: 8000, completion_tokens: 1000, total_tokens: 9000 } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial budget risk repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Flag inefficient token usage',
        acceptance_criteria: ['Inefficient small workers create budget-risk evidence'],
        budget: {
          max_tokens: 20_000,
          max_tokens_per_worker: 20_000,
          max_tokens_per_diff_line: 1,
        },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');
    const assignmentPacket = JSON.parse(fs.readFileSync(maker.metadata.assignment_packet_file, 'utf8'));
    expect(assignmentPacket.runtime_profile).toMatchObject({
      name: 'djimitflo-worker',
      token_budget: {
        max_tokens: 20_000,
        max_tokens_per_worker: 20_000,
        max_tokens_per_diff_line: 1,
        source: 'goal',
      },
    });

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'token_budget', status: 'pass' }),
    ]));
    expect(executed.run.metadata.budget_risk).toMatchObject({
      type: 'token_efficiency',
      lease_id: maker.id,
      runtime_usage: { total_tokens: 9000 },
      budget: {
        maxTokens: 20_000,
        maxTokensPerWorker: 20_000,
        maxTokensPerDiffLine: 1,
        efficiency_exceeded: true,
      },
    });
    expect(executed.run.status).toBe('verifying');

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.events.map((event: any) => event.event_type)).toContain('token_efficiency_budget_risk');
  });

  it('captures runtime warnings and keeps low-risk warning gates advisory', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("TODO: document setup", "Setup is documented."));',
      'console.error("failed to parse plugin hooks config: ignored malformed hook");',
      'console.error("Skill descriptions were shortened to fit context budget");',
      'console.log(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial warning repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    const executed = await executeResponse.json() as any;

    expect(executed.lease.status).toBe('completed');
    expect(executed.lease.metadata.runtime_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ class_name: 'plugin_hook_config_parse' }),
      expect.objectContaining({ class_name: 'skill_context_budget' }),
    ]));
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'runtime_warning_gate', status: 'pass', evidence: expect.stringContaining('advisory') }),
    ]));
  });

  it('blocks high-risk worker completion when runtime warnings affect a trust boundary', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("TODO: update auth policy", "Auth policy is documented."));',
      'console.error("auth trust boundary warning: permission capability changed");',
      'console.log(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: update auth policy\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial high-risk warning repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Update auth policy docs',
        acceptance_criteria: ['Trust-boundary warnings block high-risk workers'],
        risk_class: 'high',
      }),
    });
    const goal = await goalResponse.json() as any;
    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    const executed = await executeResponse.json() as any;

    expect(executed.lease.status).toBe('failed');
    expect(executed.run.status).toBe('blocked');
    expect(executed.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'runtime_warning_gate', status: 'fail', evidence: expect.stringContaining('trust boundary') }),
    ]));
  });

  it('captures OpenCode token usage from structured output', async () => {
    installFakeOpencode([
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--dir") + 1] || process.argv[process.argv.indexOf("-d") + 1] || ".";',
      'if (!dir || dir.startsWith("--")) { process.exit(1); }',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document setup", "Setup complete by OpenCode."));',
      'console.log(JSON.stringify({ type: "text", part: { type: "text", text: "setup documented." } }));',
      'console.log(JSON.stringify({ type: "step_finish", step: { output: "ok" }, tokens: { input: 12, output: 13, total: 25, reasoning: 0 } }));',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'opencode' }),
    });
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-worker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000, diff_max_lines: 20 }),
    });

    expect(executeResponse.status).toBe(200);
    const executed = await executeResponse.json() as any;
    expect(executed.lease.metadata.runtime_usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 13,
      total_tokens: 25,
      usage_source: 'runtime_stdout',
    });
  });

  it('blocks new worker leasing when the wall-clock loop budget is exhausted', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document setup\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'Enforce wall-clock budget',
        acceptance_criteria: ['Loop runtime budget blocks worker leasing'],
        budget: { max_runtime_ms: 1 },
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'manual' }),
    });
    expect(continueResponse.status).toBe(409);
    const body = await continueResponse.json() as any;
    expect(body.error.code).toBe('LOOP_WALL_CLOCK_BUDGET_EXHAUSTED');

    const bundleResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/review-bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as any;
    expect(bundle.events.map((event: any) => event.event_type)).toContain('loop_budget_exhausted');
  });

  it('requires a security checker verdict before high-risk loop completion', async () => {
    installFakeCodex([
      'if (process.argv.includes("--version")) { console.log("fake-codex 1.0.0"); process.exit(0); }',
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[process.argv.indexOf("--cd") + 1];',
      'const readme = path.join(dir, "README.md");',
      'const raw = fs.readFileSync(readme, "utf8");',
      'fs.writeFileSync(readme, raw.replace("TODO: document auth policy", "Auth policy is documented."));',
      'console.log("high-risk patch");',
    ]);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document auth policy\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });

    const goalResponse = await fetch(`${baseUrl}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'High-risk auth policy doc update',
        acceptance_criteria: ['High-risk work requires security checker verdict'],
        risk_class: 'high',
      }),
    });
    const goal = await goalResponse.json() as any;

    const startResponse = await fetch(`${baseUrl}/loops/doc-drift-and-small-fix/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_id: goal.id, repository_path: tempDir }),
    });
    const run = await startResponse.json() as any;

    const continueResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_assignments: 1, runtime: 'codex' }),
    });
    expect(continueResponse.status).toBe(201);
    const continued = await continueResponse.json() as any;
    const maker = continued.leases.find((lease: any) => lease.role === 'maker');
    const checker = continued.leases.find((lease: any) => lease.role === 'checker');
    const securityChecker = continued.leases.find((lease: any) => lease.role === 'security_checker');
    expect(securityChecker).toBeTruthy();
    expect(securityChecker.metadata.maker_lease_id).toBe(maker.id);

    const executeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/execute-maker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, diff_max_lines: 20, timeout_ms: 10_000 }),
    });
    expect(executeResponse.status).toBe(200);

    const checksResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/run-checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: maker.id, timeout_ms: 10_000 }),
    });
    expect(checksResponse.status).toBe(200);

    const checkerResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/checker-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: checker.id, verdict: 'accepted', notes: 'Regular checker accepted.' }),
    });
    expect(checkerResponse.status).toBe(200);

    const blockedCompleteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, { method: 'POST' });
    expect(blockedCompleteResponse.status).toBe(409);
    const blockedComplete = await blockedCompleteResponse.json() as any;
    expect(blockedComplete.error.code).toBe('HIGH_RISK_SECURITY_CHECK_REQUIRED');

    const securityResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/security-verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease_id: securityChecker.id, verdict: 'accepted', notes: 'Security review accepted.' }),
    });
    expect(securityResponse.status).toBe(200);
    const security = await securityResponse.json() as any;
    expect(security.security_checker.status).toBe('completed');
    expect(security.security_checker.metadata.verdict).toBe('accepted');

    const verifyResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/verify`, { method: 'POST' });
    expect(verifyResponse.status).toBe(200);
    const verified = await verifyResponse.json() as any;
    expect(verified.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'security_checker_verdict', status: 'pass' }),
    ]));

    const unapprovedCompleteResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, { method: 'POST' });
    expect(unapprovedCompleteResponse.status).toBe(409);
    const unapprovedComplete = await unapprovedCompleteResponse.json() as any;
    expect(unapprovedComplete.error.code).toBe('LOOP_HUMAN_APPROVAL_REQUIRED');

    const completeResponse = await fetch(`${baseUrl}/loops/runs/${run.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ human_approval_ref: 'approval:security-reviewed' }),
    });
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as any;
    expect(completed.run.status).toBe('completed');
  });
});
