import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// UXE-00: the UI fitness ratchet. Expectations live in docs/design/ui-fitness-baseline.json, never in this file (R12).
const load = () => import('../../../../scripts/ui-fitness.mjs');
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ui-fitness-'));
  dirs.push(root);
  const all: Record<string, string> = {
    'packages/shared/src/contracts/operator.ts': "export const OPERATOR_CONTRACTS = { evolutionEvidence: ['a', 'b'] };\n",
    'packages/dashboard/src/styles/index.css': '@theme {\n  --color-status-error: red;\n}\n',
    ...files,
  };
  for (const [p, s] of Object.entries(all)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); }
  return root;
}
const page = (body: string) => ({ 'packages/dashboard/src/pages/Evolution.tsx': `import type { EvolutionEvidence } from '../lib/api';\n${body}\n` });
const fixture = (body: string) => ({ 'packages/dashboard/src/pages/Evolution.test.tsx': `import { X } from './Evolution';\nconst F = { ${body} };\n` });

it('UXE-00: a key counts as proven only when a consumer reads it and an Evolution test gives it a real value', async () => {
  const { measure } = await load();
  const r = measure(tree({ ...page('const v = (data: EvolutionEvidence) => data.a;'), ...fixture('a: 1') }));
  expect(r.counters.decision_keys_proven).toBe(1);
  expect(r.decision_keys_unproven).toEqual(['b']);
});

it('UXE-00: no fixture, an empty fixture or a read inside a comment proves nothing, and check reports the drop', async () => {
  const { measure, check } = await load();
  const noFixture = measure(tree(page('const v = (data: EvolutionEvidence) => data.a;')));
  const emptyFixture = measure(tree({ ...page('const v = (data: EvolutionEvidence) => data.a;'), ...fixture('a: []') }));
  const commented = measure(tree({ ...page('// data.a\nconst v = (data: EvolutionEvidence) => 1; /* data.a */'), ...fixture('a: 1') }));
  for (const r of [noFixture, emptyFixture, commented]) expect(r.counters.decision_keys_proven).toBe(0);
  const res = check(noFixture, { counters: { ...noFixture.counters, decision_keys_proven: 1 } });
  expect(res.regressions).toEqual([{ name: 'decision_keys_proven', measured: 0, baseline: 1 }]);
  expect(res.improvements).toEqual([]);
});

it('UXE-00: an improvement the baseline lacks is reported as untightened', async () => {
  const { measure, check } = await load();
  const r = measure(tree({ ...page('const v = (data: EvolutionEvidence) => data.a;'), ...fixture('a: 1') }));
  const res = check(r, { counters: { ...r.counters, decision_keys_proven: 0 } });
  expect(res.improvements).toEqual([{ name: 'decision_keys_proven', measured: 1, baseline: 0 }]);
  expect(res.regressions).toEqual([]);
});

it('UXE-00: undefined theme tokens, locale-less toLocale calls and native alerts are counted in non-test source only', async () => {
  const { measure } = await load();
  const r = measure(tree({
    'packages/dashboard/src/a.tsx': [
      'const x = <p className="text-status-nope hover:text-status-error overflow-hidden" />;',
      'const y = n.toLocaleString(); const z = n.toLocaleString(\'en-GB\'); alert(\'x\'); window.alert(\'y\'); obj.alert(1);',
    ].join('\n'),
    'packages/dashboard/src/a.test.tsx': 'const w = <p className="text-status-nope" />; n.toLocaleString(); alert(1);',
  }));
  expect(r.counters).toMatchObject({ undefined_theme_token_uses: 1, locale_less_toLocale: 1, native_alert: 2 });
});

it('UXE-00: the real tree matches the committed baseline exactly (no regressions, no untightened improvements)', async () => {
  const { measure, check, readBaseline } = await load();
  expect(check(measure(repoRoot), readBaseline(repoRoot))).toEqual({ regressions: [], improvements: [] });
});
