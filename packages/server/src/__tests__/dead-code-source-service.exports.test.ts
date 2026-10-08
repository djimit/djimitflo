import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  discoverUnimportedFiles,
  discoverDormantRouteGroups,
  MIN_TELEMETRY_DAYS,
} from '../services/dead-code-source-service';

let repo: string;
const write = (rel: string, text: string) => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('discoverUnimportedFiles', () => {
  it('returns units for source files not imported by production code', () => {
    write('packages/server/src/index.ts', "import { live } from './services/live';\nexport {};\n");
    write('packages/server/src/services/live.ts', 'export function live() {}\n');
    write('packages/server/src/services/orphan.ts', 'export function orphan() {}\n');
    const { units } = discoverUnimportedFiles(repo);
    expect(units.some((u) => u.remove.includes('packages/server/src/services/orphan.ts'))).toBe(true);
    expect(units.some((u) => u.remove.includes('packages/server/src/services/live.ts'))).toBe(false);
  });

  it('skips entry points and test files as candidates', () => {
    write('packages/server/src/main.ts', 'export const main = 1;\n');
    write('packages/server/src/__tests__/foo.test.ts', 'export {};\n');
    write('packages/server/src/services/real.ts', 'export function real() {}\n');
    const { units } = discoverUnimportedFiles(repo);
    expect(units.every((u) => !u.remove.includes('packages/server/src/main.ts'))).toBe(true);
    expect(units.some((u) => u.remove.includes('packages/server/src/services/real.ts'))).toBe(true);
  });

  it('returns empty result when packages/server/src does not exist', () => {
    const { units, skipped } = discoverUnimportedFiles(repo);
    expect(units).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe('discoverDormantRouteGroups', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE usage_counts (day TEXT, kind TEXT, name TEXT, count INTEGER)`);
  });
  afterEach(() => { db.close(); });

  it('skips route groups when telemetry covers fewer than MIN_TELEMETRY_DAYS', () => {
    write(
      'packages/server/src/routes/index.ts',
      "import { r } from './r';\napp.use({ prefix: '/api/x', middleware: [requireAuth], router: r(\n",
    );
    write('packages/server/src/routes/r.ts', 'export function r() {}\n');
    // only today → 0 days of telemetry
    db.prepare("INSERT INTO usage_counts VALUES (?, 'api', '/api/other', 1)").run(new Date().toISOString().slice(0, 10));
    const { units, skipped } = discoverDormantRouteGroups(repo, db);
    expect(units).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes(String(MIN_TELEMETRY_DAYS)))).toBe(true);
  });

  it('returns empty units and a skip reason when routes/index.ts is missing', () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    db.prepare("INSERT INTO usage_counts VALUES (?, 'api', '/api/x', 5)").run(old);
    const { units, skipped } = discoverDormantRouteGroups(repo, db);
    expect(units).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes('not found'))).toBe(true);
  });

  it('skips public mounts that lack requireAuth', () => {
    write(
      'packages/server/src/routes/index.ts',
      "import { r } from './r';\napp.use({ prefix: '/api/pub', middleware: [], router: r(\n",
    );
    write('packages/server/src/routes/r.ts', 'export function r() {}\n');
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    db.prepare("INSERT INTO usage_counts VALUES (?, 'api', '/api/other', 1)").run(old);
    const { units, skipped } = discoverDormantRouteGroups(repo, db);
    expect(units).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes('public mount'))).toBe(true);
  });

  it('skips route groups with usage hits above zero', () => {
    write(
      'packages/server/src/routes/index.ts',
      "import { r } from './r';\napp.use({ prefix: '/hit', middleware: [requireAuth], router: r(\n",
    );
    write('packages/server/src/routes/r.ts', 'export function r() {}\n');
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    db.prepare("INSERT INTO usage_counts VALUES (?, 'api', '/api/hit', 3)").run(old);
    const { units, skipped } = discoverDormantRouteGroups(repo, db);
    expect(units).toHaveLength(0);
    expect(skipped.some((s) => s.reason.includes('hit(s) since'))).toBe(true);
  });
});
