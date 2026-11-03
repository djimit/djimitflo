import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importedServices } from '../services/test-gap-source-service';

let repo: string;
const write = (rel: string, text: string) => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-svc-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

it('returns the set of service names imported by other production files, excluding self-imports', () => {
  write('packages/server/src/services/alpha.ts', 'export function alpha() {}\n');
  write('packages/server/src/services/beta.ts', 'export function beta() {}\n');
  write('packages/server/src/services/gamma.ts', 'export const gamma = 1;\n');
  // index imports alpha and beta, gamma imports nothing, beta self-imports (must be excluded)
  write(
    'packages/server/src/index.ts',
    "import { alpha } from './services/alpha';\nimport * as beta from './services/beta';\n",
  );
  write('packages/server/src/services/beta.ts', "import { beta } from './services/beta';\nexport function beta() {}\n");

  const live = importedServices(repo);
  expect(live.has('alpha')).toBe(true);
  expect(live.has('beta')).toBe(true);
  expect(live.has('gamma')).toBe(false);
  expect(live.has('index')).toBe(false);
});

it('skips the __tests__ directory and node_modules', () => {
  write('packages/server/src/services/alpha.ts', 'export function alpha() {}\n');
  write('packages/server/src/index.ts', "import { alpha } from './services/alpha';\n");
  // a test file imports gamma, and a node_modules file imports delta — neither counts
  write('packages/server/src/__tests__/alpha.test.ts', "import { gamma } from '../services/gamma';\n");
  write('packages/server/src/node_modules/pkg/delta.ts', "export function delta() {}\n");

  const live = importedServices(repo);
  expect(live.has('alpha')).toBe(true);
  expect(live.has('gamma')).toBe(false);
  expect(live.has('delta')).toBe(false);
});

it('returns an empty set when packages/server/src does not exist', () => {
  expect(importedServices(repo).size).toBe(0);
});

it('handles dynamic import() and .js extensions', () => {
  write('packages/server/src/services/alpha.ts', 'export function alpha() {}\n');
  write('packages/server/src/index.ts', "const m = await import('./services/alpha.js');\n");

  const live = importedServices(repo);
  expect(live.has('alpha')).toBe(true);
});