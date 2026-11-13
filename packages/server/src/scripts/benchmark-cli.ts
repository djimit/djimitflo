/**
 * Periodic benchmarks: the operator runner's (scripts/benchmark-run.sh) only door into the prod DB. Run inside the prod container:
 *   node dist/scripts/benchmark-cli.js idle                 read-only; exit 0 when no real lease runs, 5 when one does (JSON names them)
 *   node dist/scripts/benchmark-cli.js plan <sec-f1|f1>     read-only; due / overdue / slot, the token cap, idle state
 *   node dist/scripts/benchmark-cli.js ingest --benchmark <id> --results <results.jsonl> [--score <score.json>] [--meta <run-meta.json>]
 *        [--abort <abort.json>] [--manifest-sha <sha256>] [--source-sha <sha>] [--apply]
 * ingest is a DRY RUN by default (prints the row it would write); --apply inserts exactly one benchmark_runs row (idempotent on its
 * id) and writes nothing else. It never migrates: a DB without the table (not deployed yet) is refused.
 * Common: [--db <path>] (default DB_PATH). Exit: 0 ok, 2 refused, 5 busy, 64 usage.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { resolveDbPath } from '../database/path';
import { benchmarkDef, benchmarkState, benchmarkTokenCap, realLeasesRunning, recordBenchmarkRun, reviewerRun, type ReviewerResult } from '../services/benchmark-schedule';

type Db = InstanceType<typeof Database>;
export interface CliIo { open: (path: string, readonly: boolean) => Db; print: (s: string) => void; env: NodeJS.ProcessEnv; now: () => number }
const defaultIo: CliIo = { open: (p, readonly) => new Database(p, readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true }), print: (s) => console.log(s), env: process.env, now: () => Date.now() };

const readJson = (f: string | undefined): unknown => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const readJsonl = (f: string): ReviewerResult[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ReviewerResult) : []);

export function benchmarkCli(argv: string[], io: CliIo = defaultIo): number {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string | true> = {}; const pos: string[] = [];
  const valued = new Set(['db', 'benchmark', 'results', 'score', 'meta', 'abort', 'manifest-sha', 'source-sha']);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k === 'apply') { opts.apply = true; continue; }
    if (!valued.has(k) || i + 1 >= rest.length) { io.print(JSON.stringify({ error: `unknown or incomplete option ${a}` })); return 64; }
    opts[k] = rest[++i];
  }
  const dbPath = typeof opts.db === 'string' ? opts.db : resolveDbPath(io.env);
  if (cmd === 'idle' || cmd === 'plan') {
    const def = cmd === 'plan' ? benchmarkDef(pos[0] ?? '') : null;
    if (cmd === 'plan' && (!def || def.execution !== 'operator_runner')) { io.print(JSON.stringify({ error: 'usage: plan <sec-f1|f1>' })); return 64; }
    const db = io.open(dbPath, true);
    try {
      const running = realLeasesRunning(db);
      const base = { idle: running.length === 0, running };
      if (def) { const st = benchmarkState(db, def, io.now()); io.print(JSON.stringify({ id: def.id, role: def.role, items: def.items, token_cap: benchmarkTokenCap(io.env), slot: st.slot, due: st.due, overdue: st.overdue, owed_at: st.owed_at, last: st.last?.started_at ?? null, ...base })); }
      else io.print(JSON.stringify(base));
      return running.length ? 5 : 0;
    } finally { db.close(); }
  }
  if (cmd === 'ingest') {
    const def = benchmarkDef(String(opts.benchmark ?? ''));
    if (!def || def.execution !== 'operator_runner' || typeof opts.results !== 'string') { io.print(JSON.stringify({ error: 'usage: ingest --benchmark <sec-f1|f1> --results <results.jsonl> [--score f] [--meta f] [--abort f] [--apply]' })); return 64; }
    const run = reviewerRun(def, {
      results: readJsonl(opts.results), score: readJson(opts.score as string | undefined) as never, meta: readJson(opts.meta as string | undefined) as never,
      abort: readJson(opts.abort as string | undefined) as never, manifestSha256: typeof opts['manifest-sha'] === 'string' ? opts['manifest-sha'] : null,
      sourceSha: typeof opts['source-sha'] === 'string' ? opts['source-sha'] : null,
    });
    if (!opts.apply) { io.print(JSON.stringify({ dry_run: true, would_write: run })); return 0; }
    const db = io.open(dbPath, false);
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'benchmark_runs'").get()) { io.print(JSON.stringify({ error: 'benchmark_runs missing: deploy the build that adds it first' })); return 2; }
      const written = recordBenchmarkRun(db, run);
      io.print(JSON.stringify({ written, id: run.id, status: run.status, value: run.value, reason: run.reason }));
      return 0;
    } finally { db.close(); }
  }
  io.print(JSON.stringify({ error: 'usage: benchmark-cli.js idle | plan <id> | ingest --benchmark <id> --results <f> [--apply]' }));
  return 64;
}

if (require.main === module && /benchmark-cli\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) process.exit(benchmarkCli(process.argv.slice(2)));
