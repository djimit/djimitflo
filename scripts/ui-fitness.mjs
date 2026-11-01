#!/usr/bin/env node
/**
 * UXE-00: the UI fitness ratchet (v0). Counts measured from the source tree; the expectations live in
 * docs/design/ui-fitness-baseline.json (a non-test file, so a PR that changes them is never test-only auto-merge eligible).
 *   node scripts/ui-fitness.mjs --json            counters + decision_keys_unproven
 *   node scripts/ui-fitness.mjs --check           exit 1 on a regression, or on an improvement the baseline lacks
 *   node scripts/ui-fitness.mjs --write-baseline  rewrite only the improved counters
 * Test files are read only as fixtures (decision_keys_proven); every other counter scans non-test dashboard source.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** counter → direction: 'up' = higher is better, 'down' = lower is better */
export const COUNTERS = { decision_keys_proven: 'up', undefined_theme_token_uses: 'down', locale_less_toLocale: 'down', native_alert: 'down' };

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
  for (const f of source) {
    const s = read(f);
    tokens += [...s.matchAll(TOKEN)].filter((m) => !theme.has(m[1])).length;
    locale += count(s, /\.toLocale(?:String|DateString|TimeString)\(\s*\)/g);
    alerts += count(s, /(?<![\w.])alert\(|window\.alert\(/g);
  }
  return {
    counters: { decision_keys_proven: proven.length, undefined_theme_token_uses: tokens, locale_less_toLocale: locale, native_alert: alerts },
    decision_keys_unproven: keys.filter((k) => !proven.includes(k)),
  };
}

/** regressions = worse than the baseline; improvements = better than the baseline (= baseline not tightened) */
export function check(measured, baseline) {
  const m = measured.counters ?? measured; const b = baseline.counters ?? baseline;
  const regressions = []; const improvements = [];
  for (const [name, dir] of Object.entries(COUNTERS)) {
    const have = m[name]; const want = b[name];
    if (want === undefined) { improvements.push({ name, measured: have, baseline: null }); continue; }
    if (have === want) continue;
    ((dir === 'up') === (have > want) ? improvements : regressions).push({ name, measured: have, baseline: want });
  }
  return { regressions, improvements };
}

export const readBaseline = (root) => JSON.parse(read(join(root, BASELINE)));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const measured = measure(root);
  const arg = process.argv[2];
  if (arg === '--json') console.log(JSON.stringify(measured, null, 2));
  else if (arg === '--check') {
    const { regressions, improvements } = check(measured, readBaseline(root));
    for (const r of regressions) console.error(`regression: ${r.name} ${r.baseline} → ${r.measured}`);
    if (improvements.length) console.error(`baseline not tightened (${improvements.map((i) => i.name).join(', ')}); paste into ${BASELINE}:\n${JSON.stringify(measured.counters, null, 2)}`);
    if (regressions.length || improvements.length) process.exit(1);
    console.log('ui-fitness: ok');
  } else if (arg === '--write-baseline') {
    const base = readBaseline(root);
    for (const i of check(measured, base).improvements) base.counters[i.name] = i.measured;
    writeFileSync(join(root, BASELINE), `${JSON.stringify(base, null, 2)}\n`);
  } else { console.error('usage: ui-fitness.mjs --json | --check | --write-baseline'); process.exit(2); }
}
