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

// re-20261105 A §1 / E17 / SYNTHESIS P1-8: the name pattern above misses acting flags whose name has no flag shape
// (PROPOSAL_GROUNDING_REQUIRED, SELF_IMPROVEMENT_GOAL_ON_APPROVE, LOOP_PR_BODY_V2, OPENMYTHOS_LEADERBOARD_PUBLIC) and the
// judgment modes judgmentMode() builds at run time (TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=enforce was armed in prod, unregistered).
// So: every env read the server compares with an acting value, and every TYPESAFE_<judgment id>_MODE, is registered.
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function serverSources(): Array<[string, string]> {
  const root = path.resolve(__dirname, '..');
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name)) out.push([path.relative(root, p), stripComments(fs.readFileSync(p, 'utf8'))]);
    }
  };
  walk(root);
  return out;
}
const ACTING = String.raw`['"](?:on|act|enforce|true|1)['"]`;
const ENV_NAME = String.raw`\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])`;
/** env.X === 'true' (also `?? 'off'`, `.trim()`, `.toLowerCase()`, !==) and the reversed 'true' === env.X */
const ACTING_COMPARISONS = [
  new RegExp(String.raw`${ENV_NAME}(?:\s*\?\?\s*['"][^'"]*['"])?\)?(?:\??\.(?:trim|toLowerCase)\(\))*\s*[!=]==?\s*${ACTING}`, 'g'),
  new RegExp(String.raw`${ACTING}\s*[!=]==?\s*\(?${ENV_NAME}`, 'g'),
];
function actingEnvReads(): Map<string, string> {
  const reads = new Map<string, string>();
  for (const [file, src] of serverSources()) for (const re of ACTING_COMPARISONS) for (const m of src.matchAll(re)) {
    const name = m[1] || m[2];
    if (!reads.has(name)) reads.set(name, file);
  }
  return reads;
}
/** judgmentMode(id) reads TYPESAFE_<ID>_MODE: the ids of every JudgmentDef in the source */
function judgmentModeFlags(): string[] {
  const ids = new Set<string>();
  for (const [, src] of serverSources()) for (const m of src.matchAll(/:\s*JudgmentDef\s*(?:=\s*)?\{[\s\S]{0,1000}?\bid:\s*'([a-z0-9_]+)'/g)) ids.add(m[1]);
  return [...ids].map((id) => `TYPESAFE_${id.toUpperCase()}_MODE`).sort();
}

it('P1-8: every env read compared with an acting value, and every TYPESAFE_<judgment>_MODE, is in EVOLUTION_FLAGS or NON_EVOLUTION_FLAGS', async () => {
  const { NON_EVOLUTION_FLAGS } = await import('../services/env-flags');
  const registered = new Set([...EVOLUTION_FLAGS.map((f) => f.name), ...Object.keys(NON_EVOLUTION_FLAGS)]);
  const acting = actingEnvReads();
  expect(acting.size).toBeGreaterThan(100); // the scan sees the comparisons
  const modes = judgmentModeFlags();
  expect(modes).toEqual(expect.arrayContaining(['TYPESAFE_KB_PASSAGE_RELEVANCE_MODE', 'TYPESAFE_DECISION_CONTEXT_MODE', 'TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'TYPESAFE_DISCOVERY_RELEVANCE_MODE']));
  const unregistered = [...[...acting].map(([n, f]) => `${n} (${f})`).filter((s) => !registered.has(s.split(' ')[0])),
    ...modes.filter((n) => !registered.has(n)).map((n) => `${n} (judgmentMode)`)].sort();
  expect(unregistered).toEqual([]);
});
