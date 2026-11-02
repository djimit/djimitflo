import { expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { renderWorkAssignment } from '../services/loop-service';
import { tangoInterval } from '../services/tg-001';

/**
 * QP-001 (docs/research/qp-001/QP-001_PROTOCOL.md): the frozen pre-registration of the retrieved-context comparison
 * (Advisory Past Experience + K1 examples, present vs absent; memory rules absent in both arms since EXP-3).
 * Nothing here runs an attempt; it pins the text, the decision rule and the arm construction the protocol names.
 */
const QP001_PREREG_SHA256 = '62102a9ed217e4f9efdd7c0acf7672d2781176df5b2bfc56f3383167e37515e7';
const N_PAIRS = 150;
const MARGIN = 0.10;

/** The frozen decision rule on the primary Tango interval (survival and scope conditions are applied on top). */
const verdict = (b: number, c: number, n: number): 'KEEP' | 'SIMPLIFY' | 'INCONCLUSIVE' => {
  const [lo, hi] = tangoInterval(b, c, n);
  return lo > 0 ? 'KEEP' : hi < MARGIN ? 'SIMPLIFY' : 'INCONCLUSIVE';
};

it('the QP-001 protocol fingerprint matches its body', () => {
  const doc = readFileSync(join(__dirname, '../../../../docs/research/qp-001/QP-001_PROTOCOL.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(createHash('sha256').update(body).digest('hex')).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(QP001_PREREG_SHA256);
  expect(body).toContain('margin **Δ = 0.10**');
  expect(body).toContain('n = 150 complete pairs');
  // scoped against EXP-3 (rules) and ACE-001 (example source, KB pages): neither factor is a QP-001 treatment
  expect(body).toContain('`LOOP_MEMORY_RULES_ENABLED=false`');
  expect(body).toContain('`ACE_001_MODE=off`');
});

it('the decision rule keeps its pre-registered error rates and power at n = 150 (exact, discordance 0.36)', () => {
  const lf = [0]; for (let i = 1; i <= N_PAIRS; i++) lf[i] = lf[i - 1] + Math.log(i);
  const cache = new Map<number, string>();
  const share = (psi: number, d: number, want: string): number => {
    const pb = (psi + d) / 2; const pc = (psi - d) / 2; let p = 0;
    for (let b = 0; b <= N_PAIRS; b++) for (let c = 0; b + c <= N_PAIRS; c++) {
      const m = N_PAIRS - b - c;
      const lp = lf[N_PAIRS] - lf[b] - lf[c] - lf[m] + b * Math.log(pb) + c * Math.log(pc) + m * Math.log(1 - psi);
      if (lp < -30) continue;
      const k = b * 1000 + c; if (!cache.has(k)) cache.set(k, verdict(b, c, N_PAIRS));
      if (cache.get(k) === want) p += Math.exp(lp);
    }
    return p;
  };
  expect(share(0.36, MARGIN, 'SIMPLIFY')).toBeLessThanOrEqual(0.026); // false SIMPLIFY at a true 10-point loss
  expect(share(0.36, 0, 'KEEP')).toBeLessThanOrEqual(0.026); // false KEEP at a neutral stack
  expect(share(0.36, 0.15, 'KEEP')).toBeCloseTo(0.880, 2);
  expect(share(0.36, 0, 'SIMPLIFY')).toBeCloseTo(0.527, 2);
  expect(share(0.36, -0.05, 'SIMPLIFY')).toBeCloseTo(0.863, 2);
});

it('arm S is arm C without the retrieved context: same finding, ids and policy, no rules in either arm', () => {
  const run = { id: 'qp-run-1', loop_name: 'doc-drift-and-small-fix-loop' };
  const finding = { id: 'qp-f1', type: 'gym_repair', severity: 'warning' as const, file: 'packages/server/src/services/x.ts',
    message: 'packages/server/src/__tests__/x.test.ts fails.', evidence: 'Failing at base: packages/server/src/__tests__/x.test.ts',
    suggested_fix: 'Change only packages/server/src/services/x.ts so that the named tests pass; do not edit the tests.' };
  // arm C as production renders it now: K1 examples, no memory rules (LOOP_MEMORY_RULES_ENABLED=false since 2026-10-27)
  const ctx = { examples: ['packages/server/src/__tests__/y.test.ts — y covered'], rules: [] };
  const C = renderWorkAssignment(run, finding, 'remote', 'Episode 1: fixed x.', ctx);
  const S = renderWorkAssignment(run, finding, 'remote', '', { examples: [], rules: [] }, { omit: ['advisory'] });
  const retrieved = ['## Advisory Past Experience', 'Episode 1: fixed x.', '## Proven Examples', 'y covered'];
  for (const line of retrieved) { expect(C).toContain(line); expect(S).not.toContain(line); }
  for (const arm of [C, S]) expect(arm).not.toContain('## Engineering Rules');
  // every line of S appears in C, in order: S adds nothing the current setup lacks
  const cLines = C.split('\n'); let at = 0;
  for (const line of S.split('\n')) { at = cLines.indexOf(line, at); expect(at).toBeGreaterThanOrEqual(0); at++; }
});

it('both arms reach the maker through the same worker path, and the goal digest tells them apart', async () => {
  const worker = await import(resolve(__dirname, '../../../../scripts/gym-worker.mjs'));
  const task = { commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'] };
  const sentC = worker.makerInput({ prompt_override: '# A\n\nwith stack' }, task, false);
  const sentS = worker.makerInput({ prompt_override: '# A\n\nwithout' }, task, false);
  expect(sentC).toBe('# A with stack\n');
  expect(sentS).toBe('# A without\n');
  expect(worker.fireCheck(sentC).goal_sha256).toBe(createHash('sha256').update(sentC).digest('hex'));
  expect(worker.fireCheck(sentC).goal_sha256).not.toBe(worker.fireCheck(sentS).goal_sha256);
});
