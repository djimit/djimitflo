import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';

/**
 * M2e (E-A25): the app is the only writer of the production database. A host script or a documented recipe that opens
 * /data/djimitflo.sqlite read-write (prod 29-10: cron `20 4 1 * * /srv/djimitflo/nightly-retention.sh` DELETEs
 * openmythos_eval_runs in a second process) writes outside the app's audit and contends with it. Every recipe in scripts/,
 * docs/runbooks/ and server source comments that opens that file must open it read-only.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const OPENS = [
  /new [A-Za-z_$]+\(\s*['"`]\/data\/djimitflo\.sqlite/, // better-sqlite3
  /\bsqlite3\s+(?:-\S+\s+)*['"]?\/data\/djimitflo\.sqlite/, // sqlite3 CLI
  /connect\(\s*['"]\/data\/djimitflo\.sqlite/, // python sqlite3
];
const READONLY = /readonly:\s*true|-readonly\b|mode=ro\b/;

function files(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(e.name)) files(p, keep, out); } else if (keep(p)) out.push(p);
  }
  return out;
}

it('M2e: no script, runbook or source recipe opens /data/djimitflo.sqlite without readonly', () => {
  const targets = [
    ...files(path.join(ROOT, 'scripts'), (p) => /\.(sh|mjs|cjs|js|py|ts)$/.test(p)),
    ...files(path.join(ROOT, 'docs/runbooks'), (p) => p.endsWith('.md')),
    ...files(path.join(ROOT, 'packages/server/src'), (p) => p.endsWith('.ts') && !/\.test\.ts$/.test(p)),
  ];
  expect(targets.length).toBeGreaterThan(100);
  const writers: string[] = [];
  for (const file of targets) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (OPENS.some((re) => re.test(line)) && !READONLY.test(line)) writers.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  expect(writers).toEqual([]);
});

it('M2e: the host retention script installed from main only counts, read-only', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/nightly-retention.sh'), 'utf8');
  expect(script).toMatch(READONLY);
  expect(script).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|VACUUM)\b/);
});
