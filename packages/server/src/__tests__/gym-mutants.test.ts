import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { mutate, mutantTask, mutantTier, rng } from '../services/gym-mutants';
import { RemoteGymService } from '../services/remote-gym-service';

const SOURCE = [
  "import { x } from './x';",
  '// a comment with === inside',
  'export function inRange(n: number, max: number): boolean {',
  '  if (n >= 0 && n <= max) return true;',
  '  return false;',
  '}',
  'export const next = (n: number) => n + 1;',
].join('\n');

let db: Database.Database; let repo: string;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mut-'));
  fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages/server/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages/server/src/services/range.ts'), SOURCE);
  fs.writeFileSync(path.join(repo, 'packages/server/src/__tests__/range.test.ts'), 'test');
  fs.writeFileSync(path.join(repo, 'packages/server/src/services/untested.ts'), SOURCE);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

it('Y4: mutations are deterministic per seed, touch only code lines, and apply exactly the tier count', () => {
  const a = mutate(SOURCE, 1, rng(42)); const b = mutate(SOURCE, 1, rng(42));
  expect(a).toBe(b); expect(a).not.toBe(SOURCE);
  const changed = a!.split('\n').filter((l, i) => l !== SOURCE.split('\n')[i]);
  expect(changed).toHaveLength(1);
  expect(changed[0].startsWith('import') || changed[0].startsWith('//')).toBe(false);
  expect(mutate(SOURCE, 3, rng(7))!.split('\n').filter((l, i) => l !== SOURCE.split('\n')[i])).toHaveLength(3);
  expect(mutate('const a = 1;', 1, rng(1))).toBeNull(); // nothing to mutate
});

it('Y4: a mutant task only targets services with a test, keyed by base, file, tier and seed; tried keys are skipped', () => {
  const task = mutantTask(db, repo, 'atomic@llama-router', new Set())!;
  expect(task).toMatchObject({ source: 'packages/server/src/services/range.ts', tests: ['packages/server/src/__tests__/range.test.ts'], tier: 1 });
  expect(task.commit).toMatch(/^mut:[0-9a-f]{12}:packages\/server\/src\/services\/range\.ts:1:\d+$/);
  expect(task.mutant).not.toBe(SOURCE);
  const next = mutantTask(db, repo, 'atomic@llama-router', new Set([task.commit]))!;
  expect(next.commit).not.toBe(task.commit);
});

it('Y4: the tier rises above 70 % success and falls below 30 % (≥ 10 outcomes)', () => {
  const run = (i: number, ok: boolean, tier: number) => db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, datetime('now', ?), datetime('now'))`)
    .run(`r${i}`, JSON.stringify({ gym: { commit: `mut:x:${i}`, species: 'atomic@llama-router', tier }, gym_result: { status: ok ? 'success' : 'failure' } }), `-${100 - i} minutes`);
  expect(mutantTier(db, 'atomic@llama-router')).toBe(1);
  for (let i = 0; i < 10; i++) run(i, true, 1);
  expect(mutantTier(db, 'atomic@llama-router')).toBe(2);
  for (let i = 10; i < 30; i++) run(i, false, 2);
  expect(mutantTier(db, 'atomic@llama-router')).toBe(1);
});

it('Y4: once no mined task is left, the remote gym hands out a mutant task (content to the worker, not into the row)', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  const claim = new RemoteGymService(db, () => []).claim('workstation', ['atomic@llama-router']) as { runId: string; task: { commit: string; mutant?: string; base?: string } };
  expect(claim.task.commit.startsWith('mut:')).toBe(true);
  expect(typeof claim.task.mutant).toBe('string');
  const stored = JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(claim.runId) as { metadata: string }).metadata);
  expect(stored.gym.mutant).toBeUndefined();
  expect(stored.gym).toMatchObject({ commit: claim.task.commit, base: claim.task.base, tier: 1 });
});

it('RX-5: the tier probe is off by default — claims are unchanged', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  const svc = new RemoteGymService(db, () => []);
  for (let i = 0; i < 4; i++) {
    const c = svc.claim('workstation', ['atomic']) as { task: { commit: string; tier: number }; runId: string };
    expect(c.task.commit).toMatch(/^mut:/);
    expect(db.prepare("SELECT json_extract(metadata, '$.gym.probe') AS p FROM loop_runs WHERE id = ?").get(c.runId)).toEqual({ p: null });
    svc.record(c.runId, 'workstation', { status: 'failure', reason: 'tests still red' });
  }
});

it('RX-5: every 2nd claim probes a fixed tier from the configured set, rotating, never a holdout key, tagged and excluded from the adaptive tier', () => {
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', repo);
  vi.stubEnv('GYM_TIER_PROBE_ENABLED', 'true'); vi.stubEnv('GYM_TIER_PROBE_TIERS', '2,3,99'); vi.stubEnv('GYM_TIER_PROBE_EVERY', '2');
  const svc = new RemoteGymService(db, () => []);
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // freeze a holdout key the probe would otherwise draw first
  const firstProbe = mutantTask(db, repo, 'atomic', new Set(), 2)!;
  db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run(firstProbe.commit, '{}', new Date().toISOString());
  const claims = Array.from({ length: 4 }, () => {
    const c = svc.claim('workstation', ['atomic']) as { task: { commit: string; tier: number }; runId: string };
    svc.record(c.runId, 'workstation', { status: 'failure', reason: 'tests still red' }); // a host settles before its next claim
    return c;
  });
  const probes = claims.filter((c) => (db.prepare("SELECT json_extract(metadata, '$.gym.probe') AS p FROM loop_runs WHERE id = ?").get(c.runId) as { p: number | null }).p === 1);
  expect(probes.map((c) => c.task.tier)).toEqual([2, 3]); // claims 2 and 4; tier 99 is not a valid tier
  expect(probes.every((c) => c.task.commit !== firstProbe.commit && c.task.commit.startsWith(`mut:${base.slice(0, 12)}`))).toBe(true);
  expect((db.prepare("SELECT evidence_refs_json AS e FROM skill_outcomes WHERE task_id = ?").get(probes[0].runId) as { e: string }).e).toContain('gym:probe');
  // probe outcomes do not move the species' adaptive tier: the ordinary claims stayed at tier 1
  expect(claims.filter((c) => !probes.includes(c)).map((c) => c.task.tier)).toEqual([1, 1]);
});
