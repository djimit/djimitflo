import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUDGETS, check, humanMs, lineCount, parseAdmissions, parseEvolutionFlags, parseRunbookDefaults, parseSchedulers, renderHeartbeat, renderTools } from './gen-agent-docs.mjs';

// EVOLUTION_FLAGS literal → names in order, acting parsed
const flagsSrc = `export const EVOLUTION_FLAGS: Array<{ name: string; acting: boolean }> = [
  { name: 'OLLAMA_AUTO_FAILOVER', acting: true }, { name: 'GYM_CANARY_RATE', acting: false },
];
const OTHER = [{ name: 'NOT_A_FLAG', acting: true }];`;
assert.deepEqual(parseEvolutionFlags(flagsSrc), [{ name: 'OLLAMA_AUTO_FAILOVER', acting: true }, { name: 'GYM_CANARY_RATE', acting: false }]);
assert.throws(() => parseEvolutionFlags('const x = 1;'), /EVOLUTION_FLAGS not found/);

// runbook table rows → default column; first occurrence wins
const md = '| Flag | Code default |\n|---|---|\n| `OLLAMA_THROTTLE_AT` | 0.7 | yes |\n| `OLLAMA_THROTTLE_AT` | later | no |\n';
assert.equal(parseRunbookDefaults(md).get('OLLAMA_THROTTLE_AT'), '0.7');

// admission ledger: legacy(...) calls get LEGACY_EXPIRY, object literals their own expires_at; null = not bound
const admSrc = `const LEGACY_EXPIRY = '2026-12-31T00:00:00Z';
function legacy(runtime_id: string, runtime_version: string | null) {}
export const RUNTIME_ADMISSIONS = [
  legacy('opencode', '1.18.10', 'incumbent'),
  legacy('mock', null, 'demo', {}, 'NONE'),
  { runtime_id: 'openhuman', runtime_version: null, source_revision: 'x', expires_at: '2027-04-01T00:00:00Z' },
];`;
assert.deepEqual(parseAdmissions(admSrc), [
  { runtime_id: 'opencode', runtime_version: '1.18.10', kind: 'legacy', expires_at: '2026-12-31T00:00:00Z' },
  { runtime_id: 'mock', runtime_version: null, kind: 'legacy', expires_at: '2026-12-31T00:00:00Z' },
  { runtime_id: 'openhuman', runtime_version: null, kind: 'assessed', expires_at: '2027-04-01T00:00:00Z' },
]);

// schedulers: literal, named constant, unit expression, opaque expression, no interval; the definition itself is skipped
const sched = parseSchedulers({
  'a.ts': `export function noteScheduler(name: string, flag: string, armed: boolean, intervalMs: number | null = null): boolean { return armed; }
const PROBE_INTERVAL_MS = 30 * 60_000;
if (noteScheduler('probe', 'OLLAMA_AUTO_FAILOVER', !!stop, PROBE_INTERVAL_MS)) {}
if (noteScheduler('gym', 'EVOLUTION_GYM_ENABLED', gymArmed(), 6 * 3_600_000)) {}
if (noteScheduler('review', 'X_ENABLED', s.start(), s.intervalMinutes() * 60_000)) {}
noteScheduler('goals', '(always on)', true, Number(process.env.GOALS_MS) || 3_600_000);
noteScheduler('bare', 'BARE_ENABLED', f(a, b));`,
});
assert.deepEqual(sched.map((s) => [s.name, s.flag, s.every, s.owner]), [
  ['bare', 'BARE_ENABLED', 'not reported', 'a.ts'],
  ['goals', '(always on)', '`Number(process.env.GOALS_MS) \\|\\| 3_600_000`', 'a.ts'],
  ['gym', 'EVOLUTION_GYM_ENABLED', '6 h', 'a.ts'],
  ['probe', 'OLLAMA_AUTO_FAILOVER', '30 min', 'a.ts'],
  ['review', 'X_ENABLED', '`s.intervalMinutes()` min', 'a.ts'],
]);
assert.equal(humanMs(90_000), '90 s');
assert.equal(lineCount('a\nb\n'), 2);
assert.equal(lineCount('a\nb'), 2);

// the repo itself: generated files are fresh and every workspace file is within budget
assert.deepEqual(check(), []);
assert.ok(renderTools().startsWith('<!-- generated — do not edit.'));
assert.ok(renderHeartbeat().includes('| inference_failover_probe | `OLLAMA_AUTO_FAILOVER` | 30 min |'));

// --check detects a stale file and a budget breach (temp copy of the sources)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-agent-docs-'));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const rel of ['docs/usage-plan-limits.json', 'docs/runbooks/self-improvement-loop-operations.md', 'packages/server/src/execution/runtime-admission.ts',
  'packages/server/src/services/evolution-evidence.ts', 'packages/server/src/index.ts', 'packages/server/src/services/scheduler-registry.ts']) {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
}
for (const f of Object.keys(BUDGETS)) fs.writeFileSync(path.join(tmp, f), 'x\n');
fs.writeFileSync(path.join(tmp, 'TOOLS.md'), renderTools(tmp));
fs.writeFileSync(path.join(tmp, 'HEARTBEAT.md'), renderHeartbeat(tmp));
assert.deepEqual(check(tmp), []);
fs.writeFileSync(path.join(tmp, 'HEARTBEAT.md'), 'hand edit\n');
fs.writeFileSync(path.join(tmp, 'SOUL.md'), 'x\n'.repeat(BUDGETS['SOUL.md'] + 1));
assert.deepEqual(check(tmp), ['HEARTBEAT.md is stale: run node scripts/gen-agent-docs.mjs', `SOUL.md has ${BUDGETS['SOUL.md'] + 1} lines, budget ${BUDGETS['SOUL.md']}`]);
fs.rmSync(path.join(tmp, 'USER.md'));
assert.ok(check(tmp).includes('USER.md is missing'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('gen-agent-docs assertions passed');
