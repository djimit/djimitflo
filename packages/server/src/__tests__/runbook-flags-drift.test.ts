import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

it('RX-2: every evolution flag the evidence endpoint reports is documented in the operations runbook', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  expect(EVOLUTION_FLAGS.map((f) => f.name).filter((name) => !runbook.includes(`\`${name}\``))).toEqual([]);
});

it('every operator push / triage flag is documented in the operations runbook', async () => {
  const { OPERATOR_PUSH_FLAGS } = await import('../services/operator-push');
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  expect(OPERATOR_PUSH_FLAGS).toContain('TELEGRAM_TRIAGE_ENABLED');
  expect(OPERATOR_PUSH_FLAGS.filter((name) => !runbook.includes(`\`${name}\``))).toEqual([]);
});

// M2c / E-A28: a decision flag the server reads but nobody registered is invisible on the evidence page. Every env name the
// server source reads (env.X, env['X'], getEnv('X') …) that has a flag shape must be in EVOLUTION_FLAGS or in the explicit
// NON_EVOLUTION_FLAGS allow-list; the boot warning (unknownEnvFlags) relies on the same two lists.
function serverEnvReads(): Map<string, string> {
  const root = path.resolve(__dirname, '..');
  const reads = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])|\b[A-Za-z]*[Ee]nv[A-Za-z]*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
        const name = m[1] || m[2] || m[3];
        if (!reads.has(name)) reads.set(name, path.relative(root, p));
      }
    }
  };
  walk(root);
  return reads;
}

it('M2c: every flag-shaped env name the server reads is in EVOLUTION_FLAGS or NON_EVOLUTION_FLAGS', async () => {
  const { FLAG_NAME_PATTERN, NON_EVOLUTION_FLAGS } = await import('../services/env-flags');
  const registered = new Set(EVOLUTION_FLAGS.map((f) => f.name));
  const reads = serverEnvReads();
  expect(reads.size).toBeGreaterThan(300); // the scan sees the source tree
  const unlisted = [...reads.keys()].filter((n) => FLAG_NAME_PATTERN.test(n) && !registered.has(n) && !(n in NON_EVOLUTION_FLAGS)).sort();
  expect(unlisted.map((n) => `${n} (${reads.get(n)})`)).toEqual([]);
  // the allow-list stays honest: no name in both lists, no name nobody reads any more, a one-word reason each
  expect(Object.keys(NON_EVOLUTION_FLAGS).filter((n) => registered.has(n))).toEqual([]);
  expect(Object.keys(NON_EVOLUTION_FLAGS).filter((n) => !reads.has(n))).toEqual([]);
  expect(Object.entries(NON_EVOLUTION_FLAGS).filter(([, why]) => !/^[a-z-]+$/.test(why))).toEqual([]);
});

it('M2c: decision-changing flags found unregistered on 29-10 are registered as acting', () => {
  for (const name of ['FRONTIER_UNITS_REQUIRE_RELEVANCE', 'ORACLE_LANES_SKIP_PANEL', 'LOOP_AUTO_APPROVE_MUTATION_GAP', 'APPROVAL_INHERIT_ENABLED',
    'LOOP_REVIEWER_APPROVAL_INHERIT', 'KB_CONTEXT_ENABLED', 'COMMONS_THREAD_GATE_ENABLED', 'LOOP_SKILL_CARDS_ENABLED', 'LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED']) {
    expect(EVOLUTION_FLAGS).toContainEqual({ name, acting: true });
  }
});

it('review #1094: READ_SELECTOR_ENV is exactly the runtime/model selector names server code reads or passes to child runtimes', async () => {
  const { SELECTOR_NAME_PATTERN, READ_SELECTOR_ENV } = await import('../services/env-flags');
  const reads = [...serverEnvReads().keys()].filter((n) => SELECTOR_NAME_PATTERN.test(n));
  const root = path.resolve(__dirname, '..');
  for (const file of ['execution/executors/executor-env.ts', 'services/loop-service.ts']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const list = src.match(/(?:const ALLOWLIST|RUNTIME_ENV_ALLOWLIST) = \[([\s\S]*?)\];/);
    expect(list, file).not.toBeNull();
    for (const m of list![1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) if (SELECTOR_NAME_PATTERN.test(m[1])) reads.push(m[1]);
  }
  expect([...READ_SELECTOR_ENV]).toEqual([...new Set(reads)].sort());
});
