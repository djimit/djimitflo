import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * P1 — G15 security-enforcement unit tests for the runtime spawn boundary.
 * Covers the three controls added to LoopService:
 *   - parent-env strip (buildRuntimeEnv allowlist, no blanket process.env leak)
 *   - cwd boundary check (assertWithinWorktreeRoot)
 *   - per-task skipPermissions gating (resolveSkipPermissions + bypass flags)
 *
 * The helpers are private, so we reach them through a typed `as any` view — this
 * tests the real logic without spawning children or writing evidence into the repo.
 */
let db: Database.Database;
let tempDir: string;
let worktreeRoot: string;
const snapshot = new Map<string, string | undefined>();

function remember(name: string) {
  snapshot.set(name, process.env[name]);
}

function restoreEnv() {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  snapshot.clear();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-runtime-sec-'));
  worktreeRoot = path.join(os.tmpdir(), `.djimitflo-loop-worktrees-sec-${path.basename(tempDir)}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
  remember('LOOP_WORKTREE_ROOT');
  remember('RUNTIME_ALLOW_SKIP_PERMISSIONS');
  remember('RUNTIME_ENV_PASSTHROUGH');
  remember('DJIMITFLO_TEST_LEAK_MARKER');
  remember('OLLAMA_HOST');
  delete process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS;
  delete process.env.RUNTIME_ENV_PASSTHROUGH;
  delete process.env.DJIMITFLO_TEST_LEAK_MARKER;
  delete process.env.OLLAMA_HOST;
});

afterEach(() => {
  restoreEnv();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
});

function service(): LoopService {
  return new LoopService(db, path.join(tempDir, 'agent-evidence'));
}

describe('P1 runtime env strip (buildRuntimeEnv)', () => {
  it('drops server-only env vars and forwards only the allowlist + markers', () => {
    process.env.DJIMITFLO_TEST_LEAK_MARKER = 'should-not-leak';
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    const env = (service() as any).buildRuntimeEnv() as NodeJS.ProcessEnv;

    // Sandboxing markers are always set so a child can know its context.
    expect(env.RUNTIME_SANDBOX).toBe('1');
    expect(env.DJIMITFLO_RUNTIME_CHILD).toBe('1');

    // Standard process env the runtime genuinely needs is forwarded.
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();

    // An allowlisted model-provider endpoint var is forwarded.
    expect(env.OLLAMA_HOST).toBe('http://localhost:11434');

    // An arbitrary server-only var is NOT forwarded (no blanket process.env leak).
    expect(env.DJIMITFLO_TEST_LEAK_MARKER).toBeUndefined();
  });

  it('honors RUNTIME_ENV_PASSTHROUGH as an explicit operator opt-in', () => {
    process.env.DJIMITFLO_TEST_LEAK_MARKER = 'opt-in-value';
    process.env.RUNTIME_ENV_PASSTHROUGH = 'DJIMITFLO_TEST_LEAK_MARKER';
    const env = (service() as any).buildRuntimeEnv() as NodeJS.ProcessEnv;
    expect(env.DJIMITFLO_TEST_LEAK_MARKER).toBe('opt-in-value');
  });
});

describe('P1 per-task skipPermissions gating (resolveSkipPermissions + buildRuntimeCommand)', () => {
  it('default-denies bypass when the env gate is unset, even if requested', () => {
    delete process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS;
    expect((service() as any).resolveSkipPermissions(true)).toBe(false);
  });

  it('default-denies bypass when the env gate is not the literal "true"', () => {
    process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS = 'false';
    expect((service() as any).resolveSkipPermissions(true)).toBe(false);
  });

  it('grants bypass only when requested AND the env gate is "true"', () => {
    process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS = 'true';
    expect((service() as any).resolveSkipPermissions(true)).toBe(true);
    expect((service() as any).resolveSkipPermissions(false)).toBe(false);
    expect((service() as any).resolveSkipPermissions(undefined)).toBe(false);
  });

  it('injects the codex bypass flag only when skipPermissions is true', () => {
    const s = service() as any;
    const off = s.buildRuntimeCommand('codex', '/tmp/wt', 'prompt', false);
    expect(off.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    const on = s.buildRuntimeCommand('codex', '/tmp/wt', 'prompt', true);
    expect(on.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    // bypass precedes the json/cd/prompt tail
    expect(on.args.indexOf('--dangerously-bypass-approvals-and-sandbox')).toBeLessThan(on.args.indexOf('--json'));
  });

  it('injects the opencode bypass flag only when skipPermissions is true', () => {
    const s = service() as any;
    const off = s.buildRuntimeCommand('opencode', '/tmp/wt', 'prompt', false);
    expect(off.args).not.toContain('--dangerously-skip-permissions');
    const on = s.buildRuntimeCommand('opencode', '/tmp/wt', 'prompt', true);
    expect(on.args).toContain('--dangerously-skip-permissions');
  });
});

describe('P1 cwd boundary check (assertWithinWorktreeRoot)', () => {
  it('accepts a cwd inside the configured worktree root', () => {
    const inside = path.join(worktreeRoot, 'run-1', 'finding-1');
    fs.mkdirSync(inside, { recursive: true });
    expect(() => (service() as any).assertWithinWorktreeRoot(inside)).not.toThrow();
  });

  it('accepts a cwd inside the system tmpdir (test placement)', () => {
    const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-boundary-ok-'));
    expect(() => (service() as any).assertWithinWorktreeRoot(inside)).not.toThrow();
  });

  it('rejects an arbitrary cwd outside any worktree root', () => {
    expect(() => (service() as any).assertWithinWorktreeRoot('/etc')).toThrow(/RUNTIME_CWD_OUTSIDE_WORKTREE/);
  });

  it('rejects the main repo directory itself', () => {
    const repo = process.cwd();
    expect(() => (service() as any).assertWithinWorktreeRoot(repo)).toThrow(/RUNTIME_CWD_OUTSIDE_WORKTREE/);
  });
});