#!/usr/bin/env node
/**
 * UXE-00: the UI fitness ratchet (v0). Counts measured from the source tree; the expectations live in
 * docs/design/ui-fitness-baseline.json (a non-test file, so a PR that changes them is never test-only auto-merge eligible).
 *   node scripts/ui-fitness.mjs --json            counters + decision_keys_unproven
 *   node scripts/ui-fitness.mjs --check           exit 1 on a regression, or on an improvement the baseline lacks
 *   node scripts/ui-fitness.mjs --write-baseline  rewrite only the improved counters
 * Test files are read only as fixtures (decision_keys_proven); every other counter scans non-test source.
 * UXE-02a: a counter that needs `typescript` (a2, via scripts/ux-coverage.mjs) reads 'unavailable' when it does not resolve,
 * never 0; --check reports it as neither a regression nor an improvement.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** counter → direction: 'up' = higher is better, 'down' = lower is better */
export const COUNTERS = {
  decision_keys_proven: 'up', undefined_theme_token_uses: 'down', locale_less_toLocale: 'down', native_alert: 'down',
  operator_routes_ui_called: 'up', unmatched_calls: 'down', contrast_pairs_below_4_5: 'down', max_page_lines: 'down', dead_ws_subscriptions: 'down',
};
export const UNAVAILABLE = 'unavailable';

const BASELINE = 'docs/design/ui-fitness-baseline.json';
const DASH = 'packages/dashboard/src';
const isTest = (f) => /\.test\.tsx?$/.test(f);
const read = (f) => readFileSync(f, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // ponytail: no string awareness; '://' kept
const count = (s, re) => (s.match(re) ?? []).length;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(p)) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function evolutionKeys(root) {
  const f = join(root, 'packages/shared/src/contracts/operator.ts');
  const m = existsSync(f) ? /evolutionEvidence:\s*\[([\s\S]*?)\]/.exec(read(f)) : null;
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

function themeTokens(root) {
  const f = join(root, DASH, 'styles/index.css');
  const block = existsSync(f) ? /@theme\s*\{([\s\S]*?)\}/.exec(read(f)) : null;
  return new Set(block ? [...block[1].matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((x) => x[1]) : []);
}

// a2: ux-coverage.mjs imports `typescript`; load it only when typescript resolves, both here and from the measured checkout.
const tsResolves = (dir) => { try { createRequire(join(dir, 'noop.js')).resolve('typescript'); return true; } catch { return false; } };
const coverage = tsResolves(dirname(fileURLToPath(import.meta.url)))
  ? { ...(await import('./ux-coverage.mjs')), ...(await import('./route-source-inventory.mjs')) } : null;

function routeCoverage(root) {
  if (!coverage || !tsResolves(root)) return { operator_routes_ui_called: UNAVAILABLE, unmatched_calls: UNAVAILABLE };
  const { mounted } = coverage.inventoryRouteSource(root);
  const { totals } = coverage.coverageByRouter(mounted, coverage.inventoryDashboardClient(root, mounted).calls);
  return { operator_routes_ui_called: totals.operator.covered, unmatched_calls: totals.unmatched_calls };
}

/** a4: WCAG 2.x contrast ratio of two sRGB channel triples (0–255). */
export function contrastRatio(fg, bg) {
  const lum = (rgb) => rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** a4: every --djimit-(text|status|accent|risk)-* triple × every --djimit-bg-* triple in styles/index.css below 4.5:1. */
function contrastPairsBelow(root) {
  const f = join(root, DASH, 'styles/index.css');
  const css = existsSync(f) ? read(f) : '';
  const triples = (re) => [...new Map([...css.matchAll(re)].map((m) => [m[1], m[2].trim().split(/\s+/).map(Number)])).values()];
  const fg = triples(/--djimit-((?:text|status|accent|risk)-[a-z0-9-]+)\s*:\s*(\d+\s+\d+\s+\d+)\s*;/g);
  const bg = triples(/--djimit-(bg-[a-z0-9-]+)\s*:\s*(\d+\s+\d+\s+\d+)\s*;/g);
  return fg.reduce((n, t) => n + bg.filter((b) => contrastRatio(t, b) < 4.5).length, 0);
}

/** max line count over packages/dashboard/src/pages/*.tsx (top level only), tests excluded. */
function maxPageLines(root) {
  const dir = join(root, DASH, 'pages');
  const pages = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tsx') && !isTest(f)) : [];
  return Math.max(0, ...pages.map((f) => read(join(dir, f))).map((s) => s.split('\n').length - (s.endsWith('\n') ? 1 : 0)));
}

/** WebSocketEventType members X the dashboard subscribes to (`subscribe(WebSocketEventType.X`) that non-test server source
 *  never names, neither as `WebSocketEventType.X` nor as a string literal of the member's value. */
function deadWsSubscriptions(root, dashSource) {
  const f = join(root, 'packages/shared/src/types/websocket.ts');
  const m = existsSync(f) ? /enum WebSocketEventType\s*\{([\s\S]*?)\}/.exec(read(f)) : null;
  const values = new Map(m ? [...m[1].matchAll(/(\w+)\s*=\s*'([^']+)'/g)].map((x) => [x[1], x[2]]) : []);
  const subscribed = new Set(dashSource.flatMap((s) => [...s.matchAll(/subscribe\(\s*WebSocketEventType\.(\w+)/g)].map((x) => x[1])));
  const server = walk(join(root, 'packages/server/src')).filter((p) => !isTest(p) && !/[\\/]__tests__[\\/]/.test(p)).map(read).join('\n');
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...subscribed].filter((x) => !new RegExp(`\\bWebSocketEventType\\.${x}\\b`).test(server)
    && !(values.has(x) && new RegExp(`(['"\`])${esc(values.get(x))}\\1`).test(server))).sort();
}

const TOKEN = /(?<![\w-])(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|placeholder|caret)-((?:status|accent|risk|foreground|background)(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;

export function measure(root) {
  const files = walk(join(root, DASH));
  const source = files.filter((f) => !isTest(f));
  const tests = files.filter(isTest).map(read).filter((s) => /from '\.\/Evolution|from '\.\.\/pages\/Evolution/.test(s));
  const skip = new Set(['lib/api.ts', 'lib/api-contracts.ts']);
  const consumers = source.filter((f) => !skip.has(relative(join(root, DASH), f).split('\\').join('/')))
    .map(read).filter((s) => s.includes('EvolutionEvidence')).map(stripComments);
  const keys = evolutionKeys(root);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const proven = keys.filter((k) => consumers.some((s) => new RegExp(`\\b(?:data|d|ev|evidence)\\??\\.${esc(k)}\\b`).test(s))
    && tests.some((s) => new RegExp(`\\b${esc(k)}\\s*:\\s*(?!null\\b|undefined\\b|\\{\\s*\\}|\\[\\s*\\]|0\\b|false\\b|''|"")\\S`).test(s)));
  const theme = themeTokens(root);
  let tokens = 0; let locale = 0; let alerts = 0;
  const sourceText = source.map(read);
  for (const s of sourceText) {
    tokens += [...s.matchAll(TOKEN)].filter((m) => !theme.has(m[1])).length;
    locale += count(s, /\.toLocale(?:String|DateString|TimeString)\(\s*\)/g);
    alerts += count(s, /(?<![\w.])alert\(|window\.alert\(/g);
  }
  const dead = deadWsSubscriptions(root, sourceText);
  return {
    counters: {
      decision_keys_proven: proven.length, undefined_theme_token_uses: tokens, locale_less_toLocale: locale, native_alert: alerts,
      ...routeCoverage(root), contrast_pairs_below_4_5: contrastPairsBelow(root), max_page_lines: maxPageLines(root), dead_ws_subscriptions: dead.length,
    },
    decision_keys_unproven: keys.filter((k) => !proven.includes(k)),
    dead_ws_subscriptions: dead,
  };
}

/** regressions = worse than the baseline; improvements = better than the baseline (= baseline not tightened);
 *  unavailable = could not be measured here (e.g. no `typescript`): neither a regression nor an improvement. */
export function check(measured, baseline) {
  const m = measured.counters ?? measured; const b = baseline.counters ?? baseline;
  const regressions = []; const improvements = []; const unavailable = [];
  for (const [name, dir] of Object.entries(COUNTERS)) {
    const have = m[name]; const want = b[name];
    if (have === UNAVAILABLE) { unavailable.push({ name, baseline: want ?? null }); continue; }
    if (typeof want !== 'number') { improvements.push({ name, measured: have, baseline: null }); continue; }
    if (have === want) continue;
    ((dir === 'up') === (have > want) ? improvements : regressions).push({ name, measured: have, baseline: want });
  }
  return { regressions, improvements, unavailable };
}

export const readBaseline = (root) => JSON.parse(read(join(root, BASELINE)));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const measured = measure(root);
  const arg = process.argv[2];
  if (arg === '--json') console.log(JSON.stringify(measured, null, 2));
  else if (arg === '--check') {
    const { regressions, improvements, unavailable } = check(measured, readBaseline(root));
    for (const u of unavailable) console.error(`unavailable: ${u.name} (typescript does not resolve) — neither a regression nor an improvement; baseline ${u.baseline} kept`);
    for (const r of regressions) console.error(`regression: ${r.name} ${r.baseline} → ${r.measured}`);
    if (improvements.length) console.error(`baseline not tightened (${improvements.map((i) => i.name).join(', ')}); paste into ${BASELINE}:\n${JSON.stringify({ ...measured.counters, ...Object.fromEntries(unavailable.map((u) => [u.name, u.baseline])) }, null, 2)}`);
    if (regressions.length || improvements.length) process.exit(1);
    console.log(`ui-fitness: ok${unavailable.length ? ` (${unavailable.length} unavailable, not compared)` : ''}`);
  } else if (arg === '--write-baseline') {
    const base = readBaseline(root);
    for (const i of check(measured, base).improvements) base.counters[i.name] = i.measured;
    writeFileSync(join(root, BASELINE), `${JSON.stringify(base, null, 2)}\n`);
  } else { console.error('usage: ui-fitness.mjs --json | --check | --write-baseline'); process.exit(2); }
}
