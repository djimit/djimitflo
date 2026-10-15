import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';

/**
 * DI-001 P3 (BENCHMARK.md §6, PREREG §6a/§6b): blind discovery-relevance labelling on /decisions.
 *
 * Queue order: the PROTECTED sample (eval-sample.json, frozen, sha256-checked at load) first; then the 20 % overlap subset
 * (stratified like the sample) as a delayed blind re-label, due ≥ 7 days after its first label; then active-learning refs
 * (outside the protected set, BENCHMARK §6.2 cells). Within a tier the order is a per-day shuffle.
 *
 * A card carries only title, note, source and link (+ ref and pass to post the answer). Never a jev verdict, a filter
 * (taxonomy) result, an admission state, the sample tier or any earlier label.
 *
 * Labels are `judgments` rows like D5: judgment 'operator_label', subject_type 'discovery', subject_id = ref,
 * state_hash 'discovery_relevance', mode 'operator_label' (the mode relevance-bench.cjs reads as L2, as attribution_audit
 * does), decision yes / no / unclear. 'unclear' is a recorded label, never a negative. One row per (ref, pass).
 */
export const EVAL_SAMPLE_SHA256 = '4830232560726ecf3900239041d84186e876b8d4f2b8ae9b0bcb679fdc7ca09d';
/** data copy of docs/research/di-001/relevance/eval-sample.json (PR #829, not merged); docs/ is not in the image */
export const EVAL_SAMPLE_PATH = join(__dirname, '..', '..', 'corpus', 'di-001', 'eval-sample.json');
export const SCOPE_SOURCES = new Set(['djimitflo-scout', 'operator-chatgpt']); // PREREG §1 primary population
export const RELABEL_DELAY_DAYS = 7;
export const DAILY_TARGET_SECONDS = 30 * 60;
const OVERLAP_SHARE = 0.2;
/** BENCHMARK §6.2: AL label quota per cell (150 in total) */
export const AL_QUOTA = { reject_jev_yes: 40, admit_jev_no: 40, admit_jev_uncertain: 25, reject_jev_uncertain: 15, random: 30 } as const;
export type AlCell = keyof typeof AL_QUOTA;
export type RelevanceLabel = 'relevant' | 'not_relevant' | 'unclear';
export type LabelPass = 'first' | 'relabel';
const DECISION: Record<RelevanceLabel, 'yes' | 'no' | 'unclear'> = { relevant: 'yes', not_relevant: 'no', unclear: 'unclear' };
const REF_RE = /^(arxiv:\d{4}\.\d{4,5}|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;

export interface EvalSample { refs: Array<{ ref: string; src: string; week: string }>; size: { N_eval: number } }
/** What the annotator sees. Nothing else is ever added (the tests pin the key set). */
export interface RelevanceCard { ref: string; pass: LabelPass; title: string; note: string; source: string; url: string }
export interface RelevanceQueue {
  cards: RelevanceCard[];
  progress: { protected: { labelled: number; total: number }; relabel: { labelled: number; total: number; due: number }; al: { labelled: number; total: number } };
  today: { day: string; labels: number; seconds: number; median_seconds: number | null; target_seconds: number; remaining_seconds: number; est_cards_left: number | null };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const loaded = new Map<string, EvalSample>();

/** Reads the frozen manifest and refuses it unless its bytes hash to the pinned sha256 (PREREG §6a freeze). */
export function loadEvalSample(path = EVAL_SAMPLE_PATH, expected = EVAL_SAMPLE_SHA256): EvalSample {
  const key = `${path}|${expected}`; const hit = loaded.get(key); if (hit) return hit;
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('EVAL_SAMPLE_SHA_MISMATCH');
  const sample = JSON.parse(bytes.toString('utf8')) as EvalSample;
  if (!Array.isArray(sample.refs) || sample.refs.length !== sample.size?.N_eval) throw new Error('EVAL_SAMPLE_INVALID');
  loaded.set(key, sample);
  return sample;
}

/** PREREG §6b: the ≥ 20 % overlap subset, stratified like the sample (largest remainder per source × week). */
export function overlapSubset(sample: EvalSample): Set<string> {
  const strata = new Map<string, string[]>();
  for (const r of sample.refs) strata.set(`${r.src}|${r.week}`, [...(strata.get(`${r.src}|${r.week}`) ?? []), r.ref]);
  const total = Math.round(sample.refs.length * OVERLAP_SHARE);
  const cells = [...strata.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, refs]) => {
    const exact = (refs.length * total) / sample.refs.length; return { key, refs, n: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - cells.reduce((a, c) => a + c.n, 0);
  for (const c of [...cells].sort((a, b) => b.rem - a.rem)) { if (left <= 0) break; c.n += 1; left -= 1; }
  return new Set(cells.flatMap((c) => c.refs.map((ref) => ({ ref, h: sha(`${ref}di001-relevance-overlap`) })).sort((a, b) => (a.h < b.h ? -1 : 1)).slice(0, c.n).map((x) => x.ref)));
}

interface LabelRow { ref: string; pass: LabelPass; decision: string; created_at: string; seconds: number | null; al_cell: AlCell | null; sample: string | null }
function labelRows(db: Database): LabelRow[] {
  return db.prepare(`SELECT subject_id AS ref, json_extract(answers_json, '$.pass') AS pass, decision, created_at,
      json_extract(answers_json, '$.seconds') AS seconds, json_extract(answers_json, '$.al_cell') AS al_cell, json_extract(answers_json, '$.sample') AS sample
    FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance' ORDER BY created_at, rowid`).all() as LabelRow[];
}

interface Discovery { ref: string; src: string; title: string | null; note: string | null; url: string | null }
/** One row per ref (first in-scope sender wins, as relevance-bench.cjs Deviation 1); text is untrusted and clipped later. */
function discoveries(db: Database): Map<string, Discovery> {
  const out = new Map<string, Discovery>();
  const rows = db.prepare(`SELECT json_extract(payload, '$.ref') AS ref, COALESCE(json_extract(payload, '$.agent'), source) AS src,
      json_extract(payload, '$.title') AS title, COALESCE(json_extract(payload, '$.note'), json_extract(payload, '$.summary'), json_extract(payload, '$.abstract')) AS note,
      json_extract(payload, '$.url') AS url
    FROM external_events WHERE event_type LIKE 'discovery.%' ORDER BY occurred_at, rowid`).all() as Discovery[];
  for (const r of rows) {
    if (typeof r.ref !== 'string') continue;
    const prev = out.get(r.ref);
    if (!prev || (!SCOPE_SOURCES.has(prev.src) && SCOPE_SOURCES.has(r.src))) out.set(r.ref, r);
  }
  return out;
}

/** BENCHMARK §6.2 cell of a ref outside the protected set: A mirrors relevance-bench.cjs, jev = first non-error verdict. Server-side only. */
function alCells(db: Database, refs: string[]): Map<string, AlCell | null> {
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const units = new Map<string, { id: string; caps: number; derived: string | null }>();
  const aliasOf = new Map<string, string>();
  for (const u of all<{ id: string; aliases_json: string; caps: number; derived: string | null }>(`SELECT e.id, e.aliases_json,
      (SELECT COUNT(*) FROM expert_capabilities c WHERE c.expert_id = e.id AND c.derived_by LIKE 'source-units:%') AS caps,
      (SELECT json_extract(v.metadata_json, '$.derived') FROM expert_evidence v WHERE v.expert_id = e.id LIMIT 1) AS derived
    FROM expert_identities e WHERE e.kind IN ('paper', 'repository')`)) {
    let aliases: string[] = []; try { aliases = JSON.parse(u.aliases_json) as string[]; } catch { /* malformed row: no alias */ }
    for (const a of aliases) units.set(a, u);
    if (aliases[0]) aliasOf.set(u.id, aliases[0]);
  }
  const jev = new Map<string, { subject_type: string; decision: string }>();
  for (const j of all<{ subject_type: string; subject_id: string; decision: string }>(`SELECT subject_type, subject_id, decision FROM judgments
    WHERE judgment = 'discovery_relevance' AND decision <> 'error' ORDER BY created_at, rowid`)) {
    const key = aliasOf.get(j.subject_id) ?? j.subject_id;
    if (!jev.has(key)) jev.set(key, j);
  }
  return new Map(refs.map((ref) => {
    const u = units.get(ref), j = jev.get(ref);
    const A = j?.subject_type === 'discovery_rejected' ? 'reject' : j?.subject_type === 'discovery_pending' ? 'admit'
      : u?.derived === 'taxonomy_override:jev' ? 'reject' : u && u.caps > 0 ? 'admit' : u ? 'reject' : null;
    const cell: AlCell | null = A === 'reject' && j?.decision === 'yes' ? 'reject_jev_yes' : A === 'admit' && j?.decision === 'no' ? 'admit_jev_no'
      : A === 'admit' && j?.decision === 'uncertain' ? 'admit_jev_uncertain' : A === 'reject' && j?.decision === 'uncertain' ? 'reject_jev_uncertain' : null;
    return [ref, cell];
  }));
}

function safeUrl(url: unknown, ref: string): string {
  if (typeof url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(url.trim())) return url.trim().slice(0, 500);
  return ref.startsWith('arxiv:') ? `https://arxiv.org/abs/${ref.slice(6)}` : `https://github.com/${ref.slice(7)}`;
}
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function card(ref: string, pass: LabelPass, d: Discovery | undefined, fallbackSrc: string): RelevanceCard {
  return { ref, pass, title: clip(d?.title, 300) || ref, note: clip(d?.note, 1500), source: clip(d?.src, 80) || fallbackSrc, url: safeUrl(d?.url, ref) };
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const shuffled = (refs: string[], now: number) => refs.map((ref) => ({ ref, h: sha(`${ref}di001-relevance-order:${day(now)}`) })).sort((a, b) => (a.h < b.h ? -1 : 1)).map((x) => x.ref);

/** The next blind cards plus today's quota. Reading never writes. */
export function relevanceQueue(db: Database, limit = 5, now = Date.now(), sample = loadEvalSample()): RelevanceQueue {
  const n = Math.max(1, Math.min(20, Math.floor(limit) || 5));
  const labels = labelRows(db);
  const first = new Map(labels.filter((l) => l.pass === 'first').map((l) => [l.ref, l]));
  const relabelled = new Set(labels.filter((l) => l.pass === 'relabel').map((l) => l.ref));
  const protectedRefs = sample.refs.map((r) => r.ref);
  const protectedSet = new Set(protectedRefs);
  const overlap = overlapSubset(sample);
  const dueBefore = new Date(now - RELABEL_DELAY_DAYS * 86_400_000).toISOString();
  const due = [...overlap].filter((ref) => !relabelled.has(ref) && first.has(ref) && first.get(ref)!.created_at <= dueBefore);
  const disc = discoveries(db);
  const srcOf = new Map(sample.refs.map((r) => [r.ref, r.src]));

  const queue: Array<[string, LabelPass]> = [
    ...shuffled(protectedRefs.filter((ref) => !first.has(ref)), now).map((ref): [string, LabelPass] => [ref, 'first']),
    ...shuffled(due, now).map((ref): [string, LabelPass] => [ref, 'relabel']),
  ];
  const alLabels = labels.filter((l) => l.pass === 'first' && l.sample === 'al');
  if (queue.length < n) {
    const pool = [...disc.values()].filter((d) => SCOPE_SOURCES.has(d.src) && !protectedSet.has(d.ref) && !first.has(d.ref) && REF_RE.test(d.ref)).map((d) => d.ref);
    const cells = alCells(db, pool);
    const picked = new Set<string>();
    for (const cell of Object.keys(AL_QUOTA) as AlCell[]) {
      const left = AL_QUOTA[cell] - alLabels.filter((l) => l.al_cell === cell).length;
      if (left <= 0) continue;
      const candidates = pool.filter((ref) => !picked.has(ref) && (cell === 'random' || cells.get(ref) === cell))
        .map((ref) => ({ ref, h: sha(`${ref}di001-relevance-al:${cell}`) })).sort((a, b) => (a.h < b.h ? -1 : 1)).slice(0, left);
      for (const c of candidates) picked.add(c.ref);
    }
    queue.push(...shuffled([...picked], now).map((ref): [string, LabelPass] => [ref, 'first']));
  }

  const today = labels.filter((l) => l.created_at.slice(0, 10) === day(now));
  const secs = today.map((l) => Number(l.seconds)).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const spent = Math.round(secs.reduce((a, b) => a + b, 0));
  const median = secs.length ? secs[Math.floor(secs.length / 2)] : null;
  const remaining = Math.max(0, DAILY_TARGET_SECONDS - spent);
  return {
    cards: queue.slice(0, n).map(([ref, pass]) => card(ref, pass, disc.get(ref), srcOf.get(ref) ?? '')),
    progress: {
      protected: { labelled: protectedRefs.filter((ref) => first.has(ref)).length, total: protectedRefs.length },
      relabel: { labelled: [...overlap].filter((ref) => relabelled.has(ref)).length, total: overlap.size, due: due.length },
      al: { labelled: alLabels.length, total: Object.values(AL_QUOTA).reduce((a, b) => a + b, 0) },
    },
    today: { day: day(now), labels: today.length, seconds: spent, median_seconds: median, target_seconds: DAILY_TARGET_SECONDS, remaining_seconds: remaining,
      est_cards_left: median ? Math.floor(remaining / median) : null },
  };
}

export interface LabelInput { ref: unknown; pass: unknown; label: unknown; seconds?: unknown }
/** Validates at the trust boundary; throws LABEL_* codes the route maps to 400 / 404 / 409. Idempotent per (ref, pass). */
export function recordRelevanceLabel(db: Database, input: LabelInput, actor: string, now = Date.now(), sample = loadEvalSample()): { recorded: boolean; ref: string; pass: LabelPass; label: RelevanceLabel } {
  const { ref, seconds } = input;
  const pass = input.pass as LabelPass, label = input.label as RelevanceLabel;
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new Error('LABEL_REF_INVALID');
  if (pass !== 'first' && pass !== 'relabel') throw new Error('LABEL_PASS_INVALID');
  if (label !== 'relevant' && label !== 'not_relevant' && label !== 'unclear') throw new Error('LABEL_VALUE_INVALID');
  if (seconds !== undefined && seconds !== null && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600)) throw new Error('LABEL_SECONDS_INVALID');
  const secs = typeof seconds === 'number' ? Math.round(seconds * 10) / 10 : null;
  return db.transaction(() => {
    const existing = db.prepare(`SELECT decision FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance' AND subject_id = ?
      AND json_extract(answers_json, '$.pass') = ? LIMIT 1`).get(ref, pass) as { decision: string } | undefined;
    if (existing) {
      if (existing.decision !== DECISION[label]) throw new Error('LABEL_ALREADY_RECORDED');
      return { recorded: false, ref, pass, label };
    }
    const stratum = sample.refs.find((r) => r.ref === ref);
    let membership: Record<string, unknown>;
    if (pass === 'relabel') {
      if (!stratum || !overlapSubset(sample).has(ref)) throw new Error('LABEL_NOT_IN_OVERLAP');
      const firstAt = (db.prepare(`SELECT created_at FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance' AND subject_id = ?
        AND json_extract(answers_json, '$.pass') = 'first' LIMIT 1`).get(ref) as { created_at: string } | undefined)?.created_at;
      if (!firstAt || firstAt > new Date(now - RELABEL_DELAY_DAYS * 86_400_000).toISOString()) throw new Error('LABEL_RELABEL_NOT_DUE');
      membership = { sample: 'protected', overlap: true, stratum: `${stratum.src}|${stratum.week}` };
    } else if (stratum) {
      membership = { sample: 'protected', overlap: overlapSubset(sample).has(ref), stratum: `${stratum.src}|${stratum.week}` };
    } else {
      const d = discoveries(db).get(ref);
      if (!d || !SCOPE_SOURCES.has(d.src)) throw new Error('LABEL_REF_UNKNOWN');
      const cell = alCells(db, [ref]).get(ref) ?? null;
      // a cell already at quota (or no cell) is the random share
      const full = cell && (db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance'
        AND json_extract(answers_json, '$.al_cell') = ?`).get(cell) as { n: number }).n >= AL_QUOTA[cell];
      membership = { sample: 'al', al_cell: cell && !full ? cell : 'random' };
    }
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, created_at)
      VALUES (?, 'operator_label', 'discovery', ?, 'discovery_relevance', 'operator_label', ?, ?, ?, ?, ?)`)
      .run(randomUUID(), ref, DECISION[label], `discovery relevance (${pass}) labelled '${label}' by ${actor}`,
        JSON.stringify({ label, pass, ...membership, actor, seconds: secs, manifest_sha256: EVAL_SAMPLE_SHA256 }), secs === null ? 0 : Math.round(secs * 1000), new Date(now).toISOString());
    return { recorded: true, ref, pass, label };
  })();
}
