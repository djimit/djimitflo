import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEnv, render, OUT } from './env-inventory.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'djimitflo-env-inventory-'));
  const src = join(root, 'packages/server/src');
  mkdirSync(join(src, 'services'), { recursive: true });
  mkdirSync(join(src, '__tests__'), { recursive: true });
  mkdirSync(join(root, 'docs/runbooks'), { recursive: true });
  try { run(root, src); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('finds every read form, skips tests, and marks registry and runbook membership', () => fixture((root, src) => {
  writeFileSync(join(src, 'services/a.ts'), `const a = process.env.ALPHA_MODE; const b = env['BETA_LIMIT']; const c = getEnvInt('PORT', 1);
    function f(env: NodeJS.ProcessEnv) { return env.GAMMA_ENABLED === 'true' && environment.NOT_A_READ; }`);
  writeFileSync(join(src, 'services/b.ts'), `export const x = process.env.ALPHA_MODE ?? process.env.lowercase;`);
  writeFileSync(join(src, 'services/evolution-evidence.ts'), `export const EVOLUTION_FLAGS = [{ name: 'ALPHA_MODE', acting: true }];`);
  writeFileSync(join(src, '__tests__/a.test.ts'), `process.env.ONLY_IN_TEST = '1';`);
  writeFileSync(join(root, 'docs/runbooks/self-improvement-loop-operations.md'), '| Flag | Default |\n|---|---|\n| `BETA_LIMIT` | 5 |\n');

  assert.deepEqual([...scanEnv(root)], [
    ['ALPHA_MODE', ['services/a.ts', 'services/b.ts']], ['BETA_LIMIT', ['services/a.ts']],
    ['GAMMA_ENABLED', ['services/a.ts']], ['PORT', ['services/a.ts']],
  ]);
  const doc = render(root);
  assert.match(doc, /\| `ALPHA_MODE` \| yes \| no \| `services\/a\.ts`, `services\/b\.ts` \|/);
  assert.match(doc, /\| `BETA_LIMIT` \| no \| yes \|/);
  assert.match(doc, /- In neither: 2\n/);
  assert.equal(render(root), doc, 'deterministic');
}));

test('the committed inventory matches the source', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(readFileSync(join(root, OUT), 'utf8'), render(root), `run \`node scripts/env-inventory.mjs\``);
});
