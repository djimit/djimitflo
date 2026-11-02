import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  expect(check(measure(repoRoot), readBaseline(repoRoot))).toEqual({ regressions: [], improvements: [], unavailable: [] });
});

// UXE-02a: ratchet v1a — a2 route coverage, a4 contrast pairs, max_page_lines, dead_ws_subscriptions.
const ROUTES = {
  'packages/server/src/routes/index.ts': [
    "import { Router } from 'express';",
    'export function createRoutes() {',
    '  const router = Router();',
    "  router.get('/goals', (_q, s) => s.json([]));",
    "  router.post('/goals', (_q, s) => s.json({}));",
    '  return router;',
    '}',
  ].join('\n'),
  'packages/dashboard/src/lib/api.ts': "class Api { a() { return this.request('/goals'); } b() { return this.request('/nope'); } }\n",
};

it('UXE-02a: a2 counts UI-called operator routes and unmatched calls when typescript resolves from the checkout', async () => {
  const { measure } = await load();
  const root = tree(ROUTES);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(repoRoot, 'node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir');
  expect(measure(root).counters).toMatchObject({ operator_routes_ui_called: 1, unmatched_calls: 1 });
});

it('UXE-02a: a2 reads unavailable, never 0, without typescript, and check names it as neither regression nor improvement', async () => {
  const { measure, check } = await load();
  const r = measure(tree(ROUTES));
  expect(r.counters).toMatchObject({ operator_routes_ui_called: 'unavailable', unmatched_calls: 'unavailable' });
  const res = check(r, { counters: { ...r.counters, operator_routes_ui_called: 155, unmatched_calls: 0 } });
  expect(res.unavailable).toEqual([
    { name: 'operator_routes_ui_called', baseline: 155 },
    { name: 'unmatched_calls', baseline: 0 },
  ]);
  expect(res.regressions).toEqual([]);
  expect(res.improvements).toEqual([]);
});

it('UXE-02a: a4 contrast of 140/140/152 on 12/12/14 is 5.88 ± 0.01 (WCAG 2.x relative luminance)', async () => {
  const { contrastRatio } = await load();
  expect(Math.abs(contrastRatio([140, 140, 152], [12, 12, 14]) - 5.88)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(contrastRatio([12, 12, 14], [140, 140, 152]) - 5.88)).toBeLessThanOrEqual(0.01);
});

const css = (vars: string) => ({ 'packages/dashboard/src/styles/index.css': `@theme {\n  --color-status-error: red;\n}\n:root {\n${vars}\n}\n` });

it('UXE-02a: a4 counts every text/status/accent/risk × bg pair below 4.5:1, and nothing else', async () => {
  const { measure } = await load();
  const r = measure(tree(css([
    '--djimit-bg-primary: 12 12 14;', '--djimit-bg-elevated: 32 32 36;',
    '--djimit-text-muted: 100 100 115;', // 3.4:1 and 2.8:1 → 2 pairs
    '--djimit-status-idle: 100 116 139;', // 4.11:1 and 3.41:1 → 2 pairs
    '--djimit-text-primary: 250 250 252;', // passes both
    '--djimit-border-default: 45 45 50;', // not a foreground channel
  ].join('\n'))));
  expect(r.counters.contrast_pairs_below_4_5).toBe(4);
});

it('UXE-02a: a4 is 0 when every foreground token clears 4.5:1 on every bg token', async () => {
  const { measure } = await load();
  const r = measure(tree(css(['--djimit-bg-primary: 12 12 14;', '--djimit-text-muted: 140 140 152;', '--djimit-risk-medium: 250 204 21;'].join('\n'))));
  expect(r.counters.contrast_pairs_below_4_5).toBe(0);
});

it('UXE-02a: max_page_lines is the longest non-test pages/*.tsx file', async () => {
  const { measure } = await load();
  const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`;
  const r = measure(tree({
    'packages/dashboard/src/pages/A.tsx': lines(12),
    'packages/dashboard/src/pages/B.tsx': lines(30),
  }));
  expect(r.counters.max_page_lines).toBe(30);
});

it('UXE-02a: max_page_lines ignores tests, nested page folders and components', async () => {
  const { measure } = await load();
  const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`;
  const r = measure(tree({
    'packages/dashboard/src/pages/A.tsx': lines(12),
    'packages/dashboard/src/pages/A.test.tsx': lines(90),
    'packages/dashboard/src/pages/explore/Deep.tsx': lines(80),
    'packages/dashboard/src/components/Big.tsx': lines(70),
  }));
  expect(r.counters.max_page_lines).toBe(12);
});

const WS = {
  'packages/shared/src/types/websocket.ts': "export enum WebSocketEventType {\n  TASK_CREATED = 'task.created',\n  VOTE_CAST = 'discussion.vote_cast',\n  SYSTEM_HEALTH = 'system.health',\n}\n",
  'packages/dashboard/src/pages/P.tsx': [
    'subscribe(WebSocketEventType.TASK_CREATED, f);',
    'subscribe(\n  WebSocketEventType.VOTE_CAST, f);',
    'subscribe(WebSocketEventType.SYSTEM_HEALTH, f); subscribe(WebSocketEventType.SYSTEM_HEALTH, g);',
  ].join('\n'),
};

it('UXE-02a: dead_ws_subscriptions counts each subscribed member the server never emits by enum or string value', async () => {
  const { measure } = await load();
  const r = measure(tree({
    ...WS,
    'packages/server/src/services/emit.ts': "broadcast(WebSocketEventType.TASK_CREATED, {});\n",
    'packages/server/src/__tests__/emit.test.ts': "broadcast(WebSocketEventType.VOTE_CAST, {}); send('system.health');\n",
    'packages/server/src/__tests__/helpers/h.ts': "send('discussion.vote_cast');\n",
  }));
  expect(r.counters.dead_ws_subscriptions).toBe(2);
  expect(r.dead_ws_subscriptions).toEqual(['SYSTEM_HEALTH', 'VOTE_CAST']);
});

it('UXE-02a: dead_ws_subscriptions is 0 when the server emits every subscribed member (enum or string literal)', async () => {
  const { measure } = await load();
  const r = measure(tree({
    ...WS,
    'packages/server/src/services/emit.ts': "broadcast(WebSocketEventType.TASK_CREATED, {}); send(\"discussion.vote_cast\"); send(`system.health`);\n",
    'packages/dashboard/src/pages/P.test.tsx': 'subscribe(WebSocketEventType.NEVER_EMITTED, f);',
  }));
  expect(r.counters.dead_ws_subscriptions).toBe(0);
});
