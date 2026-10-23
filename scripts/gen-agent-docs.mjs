#!/usr/bin/env node
/**
 * Workspace files (operator 18-10): TOOLS.md and HEARTBEAT.md are generated from their sources so they cannot drift.
 *   TOOLS.md     ← docs/usage-plan-limits.json (accounts, active plans, limit texts), the runtime admission ledger
 *                  (packages/server/src/execution/runtime-admission.ts), EVOLUTION_FLAGS + the runbook flag table
 *                  (inference/failover flags) and a fixed section.
 *   HEARTBEAT.md ← every noteScheduler(name, flag, armed, interval) call in packages/server/src (the registry behind
 *                  GET /api/health/schedulers) and a fixed list of operator tasks.
 *   packages/server/src/services/config-defaults.generated.ts ← the runbook tables with a default column + the noteScheduler
 *                  gating flags; read by GET /api/health/config (DF-08) so the Configuration page shows defaults/overrides.
 * `node scripts/gen-agent-docs.mjs` writes all three; `--check` writes nothing and exits 1 when one is stale or any of the five
 * workspace files exceeds its line budget. Static parsing only: no server code runs, nothing is fetched. Output is
 * deterministic (no clock), so --check is stable in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = 'packages/server/src';
const SOURCES = {
  limits: 'docs/usage-plan-limits.json',
  admission: `${SERVER_SRC}/execution/runtime-admission.ts`,
  flags: `${SERVER_SRC}/services/evolution-evidence.ts`,
  runbook: 'docs/runbooks/self-improvement-loop-operations.md',
};
const CONFIG_DEFAULTS_FILE = `${SERVER_SRC}/services/config-defaults.generated.ts`;
export const BUDGETS = { 'AGENTS.md': 150, 'SOUL.md': 80, 'USER.md': 60, 'TOOLS.md': 120, 'HEARTBEAT.md': 100 };
export const INFERENCE_FLAG = /^(OLLAMA_|PANEL_FALLBACK_|INFERENCE_|SUBSCRIPTION_GYM_|MODEL_SELECTOR_)/;
const HEADER = (sources) => `<!-- generated — do not edit. Source: ${sources}. Regenerate: node scripts/gen-agent-docs.mjs -->`;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Names from the EVOLUTION_FLAGS array literal, in order. */
export function parseEvolutionFlags(src) {
  const start = src.indexOf('export const EVOLUTION_FLAGS');
  if (start < 0) throw new Error('EVOLUTION_FLAGS not found');
  const body = src.slice(start, src.indexOf('];', start));
  return [...body.matchAll(/\{\s*name:\s*'([A-Z0-9_]+)',\s*acting:\s*(true|false)\s*\}/g)].map((m) => ({ name: m[1], acting: m[2] === 'true' }));
}

/** `| \`NAME\` | default | …` rows of the runbook's flag tables → name → default column. */
export function parseRunbookDefaults(md) {
  const out = new Map();
  for (const m of md.matchAll(/^\| `([A-Z0-9_]+)` \| ([^|\n]*)\|/gm)) if (!out.has(m[1])) out.set(m[1], m[2].trim());
  return out;
}

/**
 * DF-08: rows of the runbook tables whose header is `| Flag | <…default…> |` (`Code default`, `Default`) → name → default
 * cell (escaped pipes kept as text, whitespace collapsed, clipped to 120). First occurrence wins; other tables are skipped.
 */
export function parseRunbookDefaultTables(md) {
  const out = new Map();
  let inTable = false;
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) { inTable = false; continue; }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (/^flag$/i.test(cells[0] ?? '')) { inTable = /default/i.test(cells[1] ?? ''); continue; }
    const name = cells[0]?.match(/^`([A-Z0-9_]+)`/)?.[1];
    if (!inTable || !name || out.has(name)) continue;
    const text = String(cells[1] ?? '').replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim();
    out.set(name, text.length > 120 ? `${text.slice(0, 119)}…` : text);
  }
  return out;
}

/** runtime_id / runtime_version / expiry of every record in RUNTIME_ADMISSIONS (legacy(...) calls and object literals). */
export function parseAdmissions(src) {
  const start = src.indexOf('export const RUNTIME_ADMISSIONS');
  if (start < 0) throw new Error('RUNTIME_ADMISSIONS not found');
  const legacyExpiry = src.match(/const LEGACY_EXPIRY = '([^']+)'/)?.[1] ?? null;
  const body = src.slice(start);
  const ver = (v) => (v === 'null' ? null : v.slice(1, -1));
  const rows = [];
  for (const m of body.matchAll(/legacy\('([^']+)', (null|'[^']*')|runtime_id: '([^']+)', runtime_version: (null|'[^']*')/g)) {
    if (m[1]) rows.push({ runtime_id: m[1], runtime_version: ver(m[2]), kind: 'legacy', expires_at: legacyExpiry, at: m.index });
    else rows.push({ runtime_id: m[3], runtime_version: ver(m[4]), kind: 'assessed', expires_at: body.slice(m.index).match(/expires_at: '([^']+)'/)?.[1] ?? null, at: m.index });
  }
  return rows.map(({ at, ...r }) => r);
}

/** Top-level arguments of the call whose '(' is at `open` (quotes and nested parens respected). */
function callArgs(src, open) {
  const args = []; let depth = 0; let cur = ''; let quote = null;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { cur += c; if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) { args.push(cur.trim()); return args; } depth--; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  throw new Error('unterminated noteScheduler call');
}

const NUMERIC = /^[\d_\s*]+$/;
const evalNumeric = (expr) => expr.replace(/_/g, '').split('*').reduce((a, n) => a * Number(n.trim()), 1);
export function humanMs(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}

/** noteScheduler(name, flag, armed, interval?) calls in the given files ({ relPath: source }). */
export function parseSchedulers(files) {
  const consts = new Map();
  for (const src of Object.values(files)) for (const m of src.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]+) = ([\d_\s*]+);/g)) consts.set(m[1], evalNumeric(m[2]));
  const out = [];
  for (const [file, src] of Object.entries(files)) {
    for (const m of src.matchAll(/noteScheduler\(/g)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition itself
      const [name, flag, , interval] = callArgs(src, m.index + m[0].length - 1);
      if (!/^'[^']*'$/.test(name ?? '') || !/^'[^']*'$/.test(flag ?? '')) continue;
      let every = 'not reported';
      if (interval) {
        if (NUMERIC.test(interval)) every = humanMs(evalNumeric(interval));
        else if (consts.has(interval)) every = humanMs(consts.get(interval));
        else {
          const unit = interval.match(/^(.+?)\s*\*\s*(60_?000|3_?600_?000)$/);
          every = unit ? `\`${clip(unit[1], 50)}\` ${unit[2].replace(/_/g, '') === '60000' ? 'min' : 'h'}` : `\`${clip(interval, 70)}\``;
        }
      }
      out.push({ name: name.slice(1, -1), flag: flag.slice(1, -1), every, owner: file });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function walkTs(dir, root, acc = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walkTs(p, root, acc); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) acc[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
  }
  return acc;
}

export function renderTools(root = ROOT) {
  const limits = JSON.parse(read(root, SOURCES.limits));
  const admissions = parseAdmissions(read(root, SOURCES.admission));
  const defaults = parseRunbookDefaults(read(root, SOURCES.runbook));
  const flags = parseEvolutionFlags(read(root, SOURCES.flags)).filter((f) => INFERENCE_FLAG.test(f.name));
  const L = [HEADER(`${SOURCES.limits}, ${SOURCES.admission}, ${SOURCES.flags} (EVOLUTION_FLAGS), ${SOURCES.runbook}`), '', '# TOOLS — accounts, runtimes, inference flags', '',
    'What agents can use and under which limits. Facts only; a missing number stays "not published" (never invent one).', '',
    '## Accounts and active plans', '', '| Account | Active plan | Window | Limit |', '|---|---|---|---|'];
  for (const [account, plan] of Object.entries(limits.account_plan ?? {})) {
    const rows = (limits.provider_plan_limits ?? []).filter((r) => r.account === account && (plan === 'unknown' || r.plan === plan));
    if (plan === 'unknown') { L.push(`| ${account} | unknown (${rows.length} candidate plan row(s) in the source) | — | — |`); continue; }
    if (!rows.length) { L.push(`| ${account} | ${clip(plan, 40)} | — | no row in the source |`); continue; }
    for (const r of rows) L.push(`| ${account} | ${clip(plan, 40)} | ${r.window} | ${r.limit == null ? 'no published number: ' : `${r.limit} ${r.unit}: `}${clip(r.limit_text, 110)} |`);
  }
  L.push('', '## Runtimes (admission ledger)', '', 'A registered runtime is not an admitted one; the decision per version is in `GET /api/health/runtimes`.', '',
    '| Runtime | Pinned version | Record | Expires |', '|---|---|---|---|');
  for (const a of admissions) L.push(`| ${a.runtime_id} | ${a.runtime_version ?? 'not bound'} | ${a.kind} | ${a.expires_at ? a.expires_at.slice(0, 10) : 'unknown'} |`);
  L.push('', '## Inference and failover flags', '', `From EVOLUTION_FLAGS; default as in the runbook flag table (${SOURCES.runbook}).`, '',
    '| Flag | Acting | Default |', '|---|---|---|');
  for (const f of flags) L.push(`| \`${f.name}\` | ${f.acting ? 'yes' : 'no'} | ${clip(defaults.get(f.name) ?? 'not in the runbook', 90)} |`);
  L.push('', '## Fixed rules', '',
    '- Production reads are read-only probes: a small `better-sqlite3` script opened with `{ readonly: true }`, copied into the',
    '  container and run with `docker exec … node` (runbook "Read-only probes"). Never write to the prod DB, never run branch code there.',
    '- Merging goes only through `scripts/merge-train.sh` (or a chain of it) with a pinned head (`<pr>@<headsha>`); agents never merge.',
    '- Sandbox caveat: codex runs its sandbox through bubblewrap, which cannot run inside the production container.', '');
  return L.join('\n');
}

export function renderHeartbeat(root = ROOT) {
  const schedulers = parseSchedulers(walkTs(path.join(root, SERVER_SRC), root));
  const L = [HEADER(`noteScheduler(...) calls in ${SERVER_SRC} (registry behind GET /api/health/schedulers)`), '', '# HEARTBEAT — what runs on its own', '',
    'Background schedulers registered at boot. Armed = its flag is set in runtime.env; live status (executing / armed_not_ticking /',
    'unknown …) is `GET /api/health/schedulers` (admins). Armed is intent, not execution: UNKNOWN is not HEALTHY.', '',
    '| Scheduler | Gating flag | Interval | Owner |', '|---|---|---|---|'];
  for (const s of schedulers) L.push(`| ${s.name} | \`${s.flag}\` | ${s.every} | \`${s.owner}\` |`);
  L.push('', '## Operator tasks (daily)', '',
    '- Read the operator digest (`GET /api/health/digest`; Telegram when `OPERATOR_DIGEST_ENABLED`).',
    '- Answer pending approvals and the needs-you list before their TTL (`APPROVAL_TTL_MS`, prod 12 h).',
    '- Check scheduler health (`GET /api/health/schedulers`: BREACHED or UNKNOWN needs a look) and stalls (`GET /api/health/stalls`).',
    '- Check provider usage against the plan limits (`/usage`; TOOLS.md) and the Ollama failover state (`inference.failover`).',
    '- Review loop draft PRs; merge only via `scripts/merge-train.sh` with a pinned head.',
    '- Before a legacy runtime admission expires, re-assess it (TOOLS.md "Runtimes"; `expiringAdmissions`).',
    '- Production deploys itself from green `main` (`scripts/auto-deploy.sh`); stop with `/srv/djimitflo/AUTO_DEPLOY_DISABLED`.', '');
  return L.join('\n');
}

/** DF-08: the runbook defaults and scheduler gating flags as a TS module the server imports (docs/ is not in the image). */
export function renderConfigDefaults(root = ROOT) {
  const defaults = [...parseRunbookDefaultTables(read(root, SOURCES.runbook))].sort(([a], [b]) => a.localeCompare(b));
  const flags = [...new Set(parseSchedulers(walkTs(path.join(root, SERVER_SRC), root)).map((s) => s.flag).filter((f) => /^[A-Z][A-Z0-9_]+$/.test(f)))].sort();
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return [`// generated — do not edit. Source: ${SOURCES.runbook} (flag tables with a default column) and the gating flags of the`,
    `// scheduler registry calls in ${SERVER_SRC}. Regenerate: node scripts/gen-agent-docs.mjs`, '',
    '/** Flag → its documented code default (runbook prose, clipped). Read by runtime-config-view (GET /api/health/config). */',
    'export const RUNBOOK_DEFAULTS: Readonly<Record<string, string>> = {',
    ...defaults.map(([k, v]) => `  ${k}: ${q(v)},`), '};', '',
    '/** Env flags that arm a background scheduler at boot (HEARTBEAT.md). */',
    'export const SCHEDULER_FLAGS: readonly string[] = [', ...flags.map((f) => `  ${q(f)},`), '];', ''].join('\n');
}

export function lineCount(text) { return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length; }

/** Problems for --check: stale generated files and line budgets of the five workspace files. */
export function check(root = ROOT) {
  const problems = [];
  for (const [file, render] of [['TOOLS.md', renderTools], ['HEARTBEAT.md', renderHeartbeat], [CONFIG_DEFAULTS_FILE, renderConfigDefaults]]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== render(root)) problems.push(`${file} is stale: run node scripts/gen-agent-docs.mjs`);
  }
  for (const [file, max] of Object.entries(BUDGETS)) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) { problems.push(`${file} is missing`); continue; }
    const n = lineCount(fs.readFileSync(p, 'utf8'));
    if (n > max) problems.push(`${file} has ${n} lines, budget ${max}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = check();
    for (const p of problems) console.error(`gen-agent-docs: ${p}`);
    if (problems.length) process.exit(1);
    console.log('gen-agent-docs: TOOLS.md, HEARTBEAT.md and config defaults fresh; line budgets ok');
  } else {
    fs.writeFileSync(path.join(ROOT, 'TOOLS.md'), renderTools());
    fs.writeFileSync(path.join(ROOT, 'HEARTBEAT.md'), renderHeartbeat());
    fs.writeFileSync(path.join(ROOT, CONFIG_DEFAULTS_FILE), renderConfigDefaults());
    console.log(`gen-agent-docs: wrote TOOLS.md, HEARTBEAT.md, ${CONFIG_DEFAULTS_FILE}`);
  }
}
