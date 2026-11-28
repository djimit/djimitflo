/**
 * system-one-replay (GLD-001, docs/research/gld-001/PREREG.md): replay the stored proposal_prescreen states to a second
 * System One endpoint and score both models against the proposals' real outcome. Offline: reads a COPY of the database
 * (readonly), writes one JSON file, records nothing, changes no decision. jev's side is the stored row, never re-drawn.
 *
 *   npx tsx packages/server/src/scripts/system-one-replay.ts --db <copy.sqlite> [--since 2026-10-03T00:00:00.000Z]
 *       [--url http://127.0.0.1:8000] [--out result.json]
 *
 * Without --url it only counts the cases (dry run, no request). The challenger host must be loopback or a private /
 * tailnet address: proposal text does not leave the operator's hosts.
 * ponytail: sequential requests, one retry; ~300 cases at a few ms each need no pool.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { auc, forecastOf, RESOLVED } from '../services/forecast-scoring';
import { rng } from '../services/gym-mutants';
import '../services/judgment-service'; // first: judgment-service ↔ judgments/* is an import cycle that only resolves from this side
import { proposalPrescreen } from '../services/judgments/proposal-prescreen';

type Answers = Record<string, { noul?: number }>;
export interface ReplayCase { id: string; source: string; outcome: 0 | 1; description: string; state: unknown; a: Answers }
export interface ScoredCase { source: string; outcome: 0 | 1; description: string; a: Answers; b: Answers | null }

export const MIN_N = 200; export const MIN_CLASS = 30; export const MAX_ERROR_RATE = 0.1; export const MARGIN = 0.05;
const PATH_RE = /(?:[\w@.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|ya?ml|sql)\b/; // same shape as namedPathsExist
const VERIFIED = new Set(['verified', 'applied']);

/** Loopback, RFC 1918 or CGNAT (tailnet 100.64/10) hosts only. */
export function privateHost(url: string): boolean {
  let h: string; try { h = new URL(url).hostname; } catch { return false; }
  return h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
}

/** PREREG §2: resolved proposals since `since`, earliest non-error jev prescreen row, state byte-identical to that row's hash. */
export function replayCases(db: Database.Database, since: string): { cases: ReplayCase[]; dropped_hash_mismatch: number } {
  const rows = db.prepare(`SELECT s.id, s.source, s.status, s.type, s.title, s.description, s.rationale, j.state_hash, j.answers_json
    FROM self_improvements s JOIN judgments j ON j.subject_id = s.id AND j.judgment = 'proposal_prescreen' AND j.decision <> 'error'
    WHERE s.created_at >= ? AND s.status IN (${RESOLVED.map(() => '?').join(',')})
      AND j.created_at = (SELECT MIN(x.created_at) FROM judgments x WHERE x.judgment = 'proposal_prescreen' AND x.subject_id = s.id AND x.decision <> 'error')
    ORDER BY s.created_at, s.id`).all(since, ...RESOLVED) as Array<Record<string, string | null>>;
  const cases: ReplayCase[] = []; let dropped = 0;
  for (const r of rows) {
    const state = { proposal: { type: r.type, title: r.title, description: r.description, rationale: r.rationale } };
    let a: Answers; try { a = JSON.parse(r.answers_json ?? '') as Answers; } catch { dropped += 1; continue; }
    if (createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16) !== r.state_hash) { dropped += 1; continue; }
    cases.push({ id: r.id as string, source: r.source ?? 'unknown', outcome: VERIFIED.has(r.status as string) ? 1 : 0, description: r.description ?? '', state, a });
  }
  return { cases, dropped_hash_mismatch: dropped };
}

const round = (x: number | null) => (x === null ? null : +x.toFixed(4));
const brier = (pairs: Array<[number, number]>) => pairs.reduce((s, [p, o]) => s + (p - o) ** 2, 0) / pairs.length;

function side(rows: Array<{ p: number; outcome: number; base: number; answers: Answers; description: string }>) {
  const pairs = rows.map((r) => [r.p, r.outcome] as [number, number]);
  const b = brier(pairs), base = brier(rows.map((r) => [r.base, r.outcome] as [number, number]));
  const named = rows.filter((r) => typeof r.answers.names_file?.noul === 'number');
  return { auc: round(auc(pairs)), brier: round(b), baseline_brier: round(base), skill: base > 0 ? round(1 - b / base) : null,
    names_file_accuracy: named.length ? round(named.filter((r) => (r.answers.names_file.noul as number) >= 0.5 === PATH_RE.test(r.description)).length / named.length) : null };
}

/** PREREG §4–5. Only cases both models scored count; missing is reported as null / INSUFFICIENT_EVIDENCE, never as zero. */
export function score(all: ScoredCase[], opts: { boot?: number; seed?: number } = {}) {
  const rate: Record<string, number> = {};
  for (const s of new Set(all.map((c) => c.source))) { const xs = all.filter((c) => c.source === s); rate[s] = xs.reduce((n, c) => n + c.outcome, 0) / xs.length; }
  const rows = all.flatMap((c) => {
    const pa = forecastOf('proposal_prescreen', c.a), pb = c.b ? forecastOf('proposal_prescreen', c.b) : null;
    return pa === null || pb === null ? [] : [{ ...c, b: c.b as Answers, pa, pb, base: rate[c.source] }];
  });
  const errors = all.length - rows.length; const pos = rows.filter((r) => r.outcome === 1).length;
  const delta = (xs: typeof rows) => { const a = auc(xs.map((r) => [r.pa, r.outcome])), b = auc(xs.map((r) => [r.pb, r.outcome])); return a === null || b === null ? null : b - a; };
  const sufficient = rows.length >= MIN_N && pos >= MIN_CLASS && rows.length - pos >= MIN_CLASS && errors / Math.max(all.length, 1) <= MAX_ERROR_RATE;
  let ci: [number, number] | null = null;
  if (sufficient) {
    const random = rng(opts.seed ?? 1); const ds: number[] = [];
    while (ds.length < (opts.boot ?? 2000)) { const d = delta(rows.map(() => rows[Math.floor(random() * rows.length)])); if (d !== null) ds.push(d); }
    ds.sort((x, y) => x - y); ci = [ds[Math.floor(0.025 * ds.length)], ds[Math.ceil(0.975 * ds.length) - 1]];
  }
  const verdict = !ci ? 'INSUFFICIENT_EVIDENCE' : ci[0] > 0 ? 'SUPPORTED' : ci[1] < 0 ? 'NOT_SUPPORTED' : ci[0] >= -MARGIN && ci[1] <= MARGIN ? 'EQUIVALENT' : 'INCONCLUSIVE';
  const decide = (a: Answers) => proposalPrescreen.decide(a as never, undefined).decision;
  const gap = rows.filter((r) => r.source === 'gap_analysis');
  return { verdict, n_cases: all.length, n_scored: rows.length, positives: pos, errors,
    delta_auc: round(delta(rows)), delta_auc_ci95: ci ? [round(ci[0]), round(ci[1])] : null,
    primary: rows.length ? side(rows.map((r) => ({ p: r.pa, outcome: r.outcome, base: r.base, answers: r.a, description: r.description }))) : null,
    challenger: rows.length ? side(rows.map((r) => ({ p: r.pb, outcome: r.outcome, base: r.base, answers: r.b, description: r.description }))) : null,
    delta_auc_gap_analysis: round(delta(gap)), n_gap_analysis: gap.length,
    decision_agreement: rows.length ? round(rows.filter((r) => decide(r.a) === decide(r.b)).length / rows.length) : null,
    note: 'delta = challenger − primary (stored jev row). Verdict rules: docs/research/gld-001/PREREG.md §5. No decision reads this (NE-001).' };
}

async function main() {
  const arg = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
  const dbPath = arg('db'), url = arg('url').replace(/\/$/, ''), out = arg('out', 'system-one-replay.json');
  if (!dbPath) { console.error('usage: system-one-replay --db <copy.sqlite> [--since <iso>] [--url <private host>] [--out <file>]'); process.exit(2); }
  if (url && !privateHost(url)) { console.error(`refused: ${url} is not a loopback or private address`); process.exit(2); }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const { cases, dropped_hash_mismatch } = replayCases(db, arg('since', '2026-10-03T00:00:00.000Z'));
  const sha = createHash('sha256'); const fd = fs.openSync(dbPath, 'r'); const buf = Buffer.alloc(1 << 20); // chunked: the copy can exceed 2 GB
  for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) sha.update(buf.subarray(0, n));
  fs.closeSync(fd);
  const header = { db_sha256: sha.digest('hex'), n_cases: cases.length, positives: cases.filter((c) => c.outcome).length, dropped_hash_mismatch };
  if (!url) { console.log(JSON.stringify({ ...header, dry_run: 'pass --url to replay' }, null, 2)); return; }
  const scored: ScoredCase[] = []; const latency: number[] = []; let model: string | null = null;
  for (const c of cases) {
    let b: Answers | null = null;
    for (let attempt = 0; attempt < 2 && !b; attempt++) {
      const t = Date.now();
      try {
        const r = await fetch(`${url}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({ state: c.state, questions: proposalPrescreen.questions }) });
        if (r.ok) { const j = await r.json() as { model?: string; answers?: Answers }; b = j.answers ?? null; model = j.model ?? model; latency.push(Date.now() - t); }
      } catch { /* an error is counted by score(), never imputed */ }
    }
    scored.push({ source: c.source, outcome: c.outcome, description: c.description, a: c.a, b });
  }
  latency.sort((x, y) => x - y);
  const result = { ...header, challenger_model: model, median_latency_ms: latency.length ? latency[Math.floor(latency.length / 2)] : null, ...score(scored) };
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module && /system-one-replay\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) void main();
