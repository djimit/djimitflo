/**
 * Offline replay benchmark for recoverable-context (Challenger A):
 *   npx tsx src/scripts/recoverable-context-replay.ts <evidence-root> [--budget 2000,4000,8000] [--min-chars 4000] [--until <iso>]
 * <evidence-root> is the loop evidence dir (prod: LOOP_EVIDENCE_ROOT). Reads only: <run>/worker-output|checker-output/
 * <lease>/stdout.log (opencode JSON streams) and <run>/checks/<lease>/*.log. Prints aggregates only, never log content.
 * --manifest prints the frozen evaluation manifest (relative path, bytes, sha256 per replayed file) instead; its sha256
 * is in the report, so a later run can prove it replayed the same bytes.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { quantile, replayLog, replayRun, type ClassTally, type RunReplay } from '../services/recoverable-context-replay';

const args = process.argv.slice(2);
const root = args[0];
if (!root || !fs.existsSync(root)) { console.error('usage: recoverable-context-replay <evidence-root> [--budget 2000,4000] [--min-chars 4000]'); process.exit(2); }
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const budgets = (flag('--budget') ?? '2000,4000,8000').split(',').map(Number).filter((n) => n > 0);
const minChars = Number(flag('--min-chars') ?? 4000);
/** freeze the corpus: only files last written before this instant (re-run with the same value + compare manifest sha) */
const until = flag('--until') ? Date.parse(flag('--until')!) : Infinity;
const frozen = (f: string) => fs.statSync(f).mtimeMs < until;
const SCOPES: Record<string, string[] | null> = { bash: ['bash'], all_tools_upper_bound: null };

const dirs = (p: string) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const streams: Array<{ role: string; file: string; mtime: number }> = [];
const checkLogs: string[] = [];
for (const run of dirs(root)) {
  for (const role of ['worker-output', 'checker-output']) {
    for (const lease of dirs(path.join(root, run, role))) {
      const file = path.join(root, run, role, lease, 'stdout.log');
      if (fs.existsSync(file) && frozen(file)) streams.push({ role, file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  for (const lease of dirs(path.join(root, run, 'checks'))) {
    for (const f of fs.readdirSync(path.join(root, run, 'checks', lease))) if (f.endsWith('.log') && frozen(path.join(root, run, 'checks', lease, f))) checkLogs.push(path.join(root, run, 'checks', lease, f));
  }
}

const round = (n: number | null, d = 3) => (n === null ? null : Number(n.toFixed(d)));
/** distribution of per-run context tokens; sd_log feeds the power calculation of the paired experiment */
function tokenSpread(xs: number[]) {
  const logs = xs.map(Math.log); const mean = logs.reduce((a, b) => a + b, 0) / (logs.length || 1);
  const sdLog = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, logs.length - 1));
  return { runs: xs.length, p10: quantile(xs, 0.1), median: quantile(xs, 0.5), p90: quantile(xs, 0.9), sd_log: round(sdLog) };
}
const report: Record<string, unknown> = {
  label: 'ESTIMATE: tokens = chars/4; saving = chars saved × later steps of the run; upper bound if the runtime prunes old tool output',
  evidence_root: root, min_chars: minChars, budgets, until: Number.isFinite(until) ? new Date(until).toISOString() : null,
  streams: streams.length,
  window: streams.length ? [new Date(Math.min(...streams.map((s) => s.mtime))).toISOString(), new Date(Math.max(...streams.map((s) => s.mtime))).toISOString()] : null,
};

const base = streams.map((s) => ({ ...s, text: fs.readFileSync(s.file, 'utf8') }));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const manifest = [...base.map((s) => ({ path: path.relative(root, s.file), bytes: Buffer.byteLength(s.text), sha256: sha(s.text) })),
  ...checkLogs.map((f) => { const b = fs.readFileSync(f); return { path: path.relative(root, f), bytes: b.length, sha256: sha(b) }; })]
  .sort((a, b) => (a.path < b.path ? -1 : 1));
const manifestJson = JSON.stringify(manifest);
if (args.includes('--manifest')) { fs.writeSync(1, `${manifestJson}\n`); process.exit(0); } // sync write: exit would truncate a piped console.log
report.manifest = { files: manifest.length, bytes: manifest.reduce((n, m) => n + m.bytes, 0), sha256: sha(manifestJson), canonical: 'JSON.stringify of [{path,bytes,sha256}] sorted by path' };
const sumTally = (ts: ClassTally[]) => ts.reduce((acc, t) => {
  for (const k of Object.keys(t) as Array<keyof ClassTally>) { acc[k] = acc[k] ?? { seen: 0, dropped: 0 }; acc[k].seen += t[k].seen; acc[k].dropped += t[k].dropped; }
  return acc;
}, {} as ClassTally);
const inventory = base.map((s) => ({ role: s.role, r: replayRun(s.text, { budget: Infinity, tools: [], minChars }) }));
const byTool: Record<string, { outputs: number; chars: number; over_min_chars: number }> = {};
for (const { r } of inventory) for (const o of r.outputs) {
  const t = byTool[o.tool] ?? (byTool[o.tool] = { outputs: 0, chars: 0, over_min_chars: 0 });
  t.outputs++; t.chars += o.chars; if (o.chars >= minChars) t.over_min_chars++;
}
report.coverage = Object.fromEntries(['worker-output', 'checker-output'].map((role) => {
  const rs = inventory.filter((x) => x.role === role).map((x) => x.r);
  return [role, { streams: rs.length, opencode_json: rs.filter((r) => r.opencodeJson).length, with_step_tokens: rs.filter((r) => r.measuredContextTokens > 0).length,
    with_tool_output: rs.filter((r) => r.outputs.length).length, steps: rs.reduce((n, r) => n + r.steps, 0),
    measured_context_tokens: rs.reduce((n, r) => n + r.measuredContextTokens, 0),
    per_run_context_tokens: tokenSpread(rs.map((r) => r.measuredContextTokens).filter((n) => n > 0)) }];
}));
report.tool_outputs_by_tool = byTool;

const results: Record<string, unknown> = {};
for (const [scope, tools] of Object.entries(SCOPES)) {
  for (const budget of budgets) {
    for (const role of ['worker-output', 'checker-output']) {
      const runs: RunReplay[] = base.filter((s) => s.role === role).map((s) => replayRun(s.text, { budget, tools, minChars })).filter((r) => r.measuredContextTokens > 0);
      const affected = runs.filter((r) => r.integrity.compressed > 0);
      const perRun = runs.map((r) => r.estimatedSavedTokens / r.measuredContextTokens);
      const saved = runs.reduce((n, r) => n + r.estimatedSavedTokens, 0);
      const ctx = runs.reduce((n, r) => n + r.measuredContextTokens, 0);
      results[`${scope}/budget=${budget}/${role}`] = {
        runs_with_tokens: runs.length, runs_affected: affected.length, share_affected: round(affected.length / (runs.length || 1)),
        outputs_compressed: runs.reduce((n, r) => n + r.integrity.compressed, 0),
        estimated_saved_tokens: Math.round(saved), measured_context_tokens: ctx, pooled_reduction: round(saved / (ctx || 1)),
        per_run_reduction: { p10: round(quantile(perRun, 0.1)), median: round(quantile(perRun, 0.5)), p90: round(quantile(perRun, 0.9)), max: round(quantile(perRun, 1)) },
        per_affected_run_reduction_median: round(quantile(affected.map((r) => r.estimatedSavedTokens / r.measuredContextTokens), 0.5)),
        structured_pass_through: runs.reduce((n, r) => n + r.integrity.structuredPassThrough, 0),
        integrity: { recovery_failures: runs.reduce((n, r) => n + r.integrity.recoveryFailures, 0), preserved_lines: sumTally(runs.map((r) => r.integrity.preserved)) },
      };
    }
  }
}
report.replay = results;

const logs = checkLogs.map((f) => replayLog(fs.readFileSync(f, 'utf8'), budgets[0], minChars));
report.check_logs = {
  note: 'deterministic-check logs; not re-sent per step, so ratio only', budget: budgets[0], files: logs.length,
  over_min_chars: logs.filter((l) => l.chars >= minChars).length, compressed: logs.filter((l) => l.compressed).length,
  chars: logs.reduce((n, l) => n + l.chars, 0), compressed_chars: logs.reduce((n, l) => n + l.compressedChars, 0),
  files_with_failing_assertion_lines: logs.filter((l) => l.preserved.error.seen > 0).length,
  integrity: { recovery_failures: logs.filter((l) => l.recoveryFailure).length, preserved_lines: sumTally(logs.map((l) => l.preserved)) },
};
console.log(JSON.stringify(report, null, 2));
