import type { Database } from 'better-sqlite3';
import { createHash } from 'crypto';
import { enqueueEvent } from './event-outbox-service';
import { failureUnits } from './intelligence-metrics';
import { insertJudgmentRow } from './judgment-service';
import { AgentCommunicationService } from './agent-communication-service';
import { loadNegativeEvidence, neGeneratorCheckMode, type NeEntry } from './negative-evidence-check';
import { tokenize } from './expert-resolver-service';

/**
 * K5 (EVO-K, 16-10): evolution output flows back outward. Until now only the interest profile reached the agents
 * (interest-feedback.ts). Once a day this composes one evolution digest from data that already exists:
 *   lanes          verified / regressed production maker outcomes per lane (skill_outcomes, 7 d)
 *   skill_patterns most-credited memory rules, examples and genomes of verified runs (outcome_credits, 30 d)
 *   skill_cards    K4 `skill_cards` per kind/status + the most frequent survived (lane, target pattern); null until the table exists
 *   anti_patterns  most recurring production failure signatures (§16 failureSignature: hash, lane, gate; 7 d)
 *   open_gaps      K2 `knowledge_gap` judgments whose latest decision is 'open' (hashed signature, lane, gate); null until one exists
 *   negative_evidence K3 registry (NEGATIVE_EVIDENCE.yaml via loadNegativeEvidence): entries decided in 7 d + `negative_evidence_match`
 *                  judgment counts per entry (state_hash = entry id, 7 d); null parts when the registry / judgments are unreadable
 *   gym            win rate per gym species (skill_outcomes domain gym, 7 d; null rate below n = 10)
 *   experiments    ACE-001 / STE-001 / TG-001 / MAKER-DEPS-001 status LABELS only — never arm counts or interim results
 * Missing data is null (E2 invariant), never 0. Content is built only from numbers, ids and titles Djimitflo generated:
 * no reason text, abstract, agent message or model output is copied in (every string passes `safeId`/`safeTitle`).
 *   EVOLUTION_FEEDBACK_MODE=off (default) | shadow | on
 * shadow: store the digest as an `evolution_digest` judgment row (mode shadow), served on GET /api/health/evolution-digest.
 * on: additionally (a) enqueue `djimitflo.feedback.evolution` on the outbox (payload ≤ PAYLOAD_CAP bytes), (b) open one
 * Agent Commons thread per day from EVOLUTION_DIGEST_AUTHOR (residents may react; the author never replies, so a thread
 * never reaches a learning, reflection or proposal), (c) annotate Frontier Experts areas whose capability matches an open
 * gap with a read-only `gap_demand` counter. Nothing here changes what a maker, checker or panel sees.
 */
export type EvolutionFeedbackMode = 'off' | 'shadow' | 'on';
export const evolutionFeedbackMode = (env: NodeJS.ProcessEnv = process.env): EvolutionFeedbackMode =>
  env.EVOLUTION_FEEDBACK_MODE === 'on' ? 'on' : env.EVOLUTION_FEEDBACK_MODE === 'shadow' ? 'shadow' : 'off';
export const EVOLUTION_DIGEST_AUTHOR = 'djimitflo:evolution-digest';
export const EVOLUTION_DIGEST_EVENT = 'djimitflo.feedback.evolution';
export const PAYLOAD_CAP = 16_000;
const DAY = 86_400_000;
const TOP = 5;
const MIN_GYM_N = 10;
/** Pre-registered experiments whose interim results must never leave the process: only the mode label is published. */
export const EXPERIMENT_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['ACE-001', 'ACE_001_MODE'], ['STE-001', 'STE_001_MODE'], ['TG-001', 'TG_001_MODE'], ['MAKER-DEPS-001', 'MAKER_DEPS_001_MODE'],
];

/** An id we generated: lane, gate, ref, hash. Anything else (spaces, quotes, prose) is dropped. */
const safeId = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.:@/+-]{1,120}$/.test(v) ? v : null);
/** A target pattern we built from changed-file paths (`dir/*.test.ts`). */
const safeGlob = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.@/*+-]{1,160}$/.test(v) ? v : null);
/** A title we authored (negative-evidence entry): printable, no markup, clipped. */
const safeTitle = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^\p{L}\p{N} ,.;:()/'%+=≥≤-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 120) : null;
};

export interface EvolutionDigest {
  date: string; generated_at: string; window_days: number;
  lanes: Array<{ lane: string; verified: number; regressed: number }> | null;
  skill_patterns: Array<{ kind: string; ref: string; credits: number }> | null;
  skill_cards: { by_status: Array<{ kind: string; status: string; cards: number }>; top_survived: Array<{ lane: string | null; pattern: string | null; cards: number }> } | null;
  anti_patterns: Array<{ signature: string; lane: string | null; gate: string | null; occurrences: number }> | null;
  open_gaps: { total: number; top: Array<{ gap: string; source: string | null; lane: string | null; gate: string | null; since: string }> } | null;
  negative_evidence: { registry_entries: number | null; new_entries: Array<{ id: string; verdict: string | null; title: string | null }> | null;
    matches: Array<{ id: string; matches: number }> | null } | null;
  gym: Array<{ species: string; outcomes: number; wins: number; win_rate: number | null; status: 'ok' | 'insufficient' }> | null;
  experiments: Array<{ id: string; status: 'running' | 'off' }>;
  /** capability id → open gaps matching it (input for the Frontier Experts `gap_demand` annotation) */
  gap_demand: Record<string, number> | null;
}

const hasTable = (db: Database, name: string): boolean => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); } catch { return false; }
};
const query = <T>(db: Database, sql: string, ...args: unknown[]): T[] | null => { try { return db.prepare(sql).all(...args) as T[]; } catch { return null; } };

export function buildEvolutionDigest(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env,
  opts: { neRegistry?: NeEntry[] | null } = {}): EvolutionDigest {
  const since7 = new Date(now - 7 * DAY).toISOString();
  const since30 = new Date(now - 30 * DAY).toISOString();
  const notFailure = "(instr(COALESCE(evidence_refs_json, ''), 'outcome_class:no_change') > 0 OR instr(COALESCE(evidence_refs_json, ''), 'evolve:lost_eligible') > 0)";

  const lanes = hasTable(db, 'skill_outcomes') ? (query<{ lane: string; verified: number; regressed: number }>(db,
    `SELECT substr(skill_id, 12) AS lane, COALESCE(SUM(success = 1), 0) AS verified, COALESCE(SUM(success = 0 AND NOT ${notFailure}), 0) AS regressed
       FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%' AND domain NOT IN ('gym', 'merge') AND created_at >= ? GROUP BY 1 ORDER BY verified + regressed DESC, 1 LIMIT 20`, since7)
    ?.flatMap((r) => { const lane = safeId(r.lane); return lane ? [{ lane, verified: r.verified, regressed: r.regressed }] : []; }) ?? null) : null;

  const skill_patterns = hasTable(db, 'outcome_credits') ? (query<{ kind: string; ref: string; credits: number }>(db,
    `SELECT kind, ref, COUNT(*) AS credits FROM outcome_credits WHERE kind IN ('memory_rule', 'example', 'genome') AND created_at >= ?
       GROUP BY 1, 2 ORDER BY credits DESC, 1, 2 LIMIT ?`, since30, TOP * 2)
    ?.flatMap((r) => { const ref = safeId(r.ref); return ref ? [{ kind: r.kind, ref, credits: r.credits }] : []; }).slice(0, TOP) ?? null) : null;

  // K4 (#862): distilled cards; the target pattern is built from our own changed-file paths (skill-distillation targetPattern)
  let skill_cards: EvolutionDigest['skill_cards'] = null;
  if (hasTable(db, 'skill_cards')) {
    const by_status = query<{ kind: string; status: string; cards: number }>(db, 'SELECT kind, status, COUNT(*) AS cards FROM skill_cards GROUP BY 1, 2 ORDER BY 1, 2');
    const survived = query<{ lane: string | null; pattern: string | null; cards: number }>(db,
      `SELECT lane, json_extract(card_json, '$.target_pattern[0]') AS pattern, COUNT(*) AS cards FROM skill_cards WHERE kind = 'skill' AND status = 'survived'
         GROUP BY 1, 2 ORDER BY cards DESC, 1, 2 LIMIT ?`, TOP * 2);
    if (by_status && survived) skill_cards = { by_status: by_status.filter((r) => safeId(r.kind) && safeId(r.status)),
      top_survived: survived.map((r) => ({ lane: safeId(r.lane), pattern: safeGlob(r.pattern), cards: r.cards })).slice(0, TOP) };
  }

  let anti_patterns: EvolutionDigest['anti_patterns'] = null;
  if (hasTable(db, 'skill_outcomes')) {
    const bySig = new Map<string, { lane: string | null; gate: string | null; n: number }>();
    for (const u of failureUnits(db, since7)) {
      if (!u.failed || !u.signature) continue;
      const c = bySig.get(u.signature.signature) ?? { lane: safeId(u.signature.lane), gate: safeId(u.signature.gate), n: 0 };
      c.n++; bySig.set(u.signature.signature, c);
    }
    // signature = sha256 prefix of lane|gate|error class: the error class itself is derived from reason text and stays out
    anti_patterns = [...bySig.entries()].filter(([, c]) => c.n >= 2).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, TOP)
      .map(([signature, c]) => ({ signature, lane: c.lane, gate: c.gate, occurrences: c.n }));
  }

  // K2 (#864): one judgment per gap (subject_id = hashed signature, decision 'open'); answers carry lane/gate/files/terms
  let open_gaps: EvolutionDigest['open_gaps'] = null;
  const gapTerms: string[][] = [];
  const gapRows = query<{ subject_id: string; decision: string; answers_json: string | null; first: string }>(db,
    `SELECT j.subject_id, j.decision, j.answers_json, (SELECT MIN(created_at) FROM judgments f WHERE f.judgment = 'knowledge_gap' AND f.subject_id = j.subject_id) AS first
       FROM judgments j WHERE j.judgment = 'knowledge_gap' AND j.created_at = (SELECT MAX(created_at) FROM judgments x WHERE x.judgment = 'knowledge_gap' AND x.subject_id = j.subject_id)
       GROUP BY j.subject_id`);
  if (gapRows && gapRows.length) {
    const open = gapRows.filter((r) => r.decision === 'open').flatMap((r) => {
      const gap = safeId(r.subject_id); if (!gap) return [];
      let a: Record<string, unknown> = {}; try { a = JSON.parse(r.answers_json || '{}') as Record<string, unknown>; } catch { /* malformed: ids only */ }
      // matching words only (never published): stored terms (expert abstention tokens) + lane/gate parts, letters only
      const words = [...(Array.isArray(a.terms) ? a.terms : []), a.lane, a.gate].filter((w): w is string => typeof w === 'string')
        .flatMap((w) => w.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 3 && w.length <= 40);
      return [{ gap, source: safeId(a.source), lane: safeId(a.lane), gate: safeId(a.gate), since: r.first, words }];
    }).sort((a, b) => a.since.localeCompare(b.since) || a.gap.localeCompare(b.gap));
    for (const g of open) gapTerms.push(g.words);
    open_gaps = { total: open.length, top: open.slice(0, TOP * 2).map(({ words: _w, ...g }) => g) };
  }

  // K3 (#861): the registry file + negative_evidence_match judgments (shadow, state_hash = entry id); no table exists
  const registry = opts.neRegistry !== undefined ? opts.neRegistry : loadNegativeEvidence();
  const new_entries = registry ? (registry as Array<NeEntry & { title?: unknown; decided_on?: unknown }>)
    .filter((e) => typeof e.decided_on === 'string' && e.decided_on >= since7.slice(0, 10))
    .flatMap((e) => { const id = safeId(e.id); return id ? [{ id, verdict: safeId(e.verdict), title: safeTitle(e.title) }] : []; }).slice(0, TOP * 2) : null;
  // matches are only counted while the K3 check runs: with NE_GENERATOR_CHECK_MODE off, 'no match' is unknown, not 0
  const matches = neGeneratorCheckMode(env) === 'off' ? null : query<{ id: string; matches: number }>(db, `SELECT state_hash AS id, COUNT(*) AS matches FROM judgments
      WHERE judgment = 'negative_evidence_match' AND created_at >= ? GROUP BY 1 ORDER BY matches DESC, 1 LIMIT ?`, since7, TOP * 2)
    ?.flatMap((r) => { const id = safeId(r.id); return id ? [{ id, matches: r.matches }] : []; }) ?? null;
  const negative_evidence: EvolutionDigest['negative_evidence'] = registry === null && matches === null ? null
    : { registry_entries: registry ? registry.length : null, new_entries, matches };

  // gym species: TG-001 attempts earn no gym skill outcome (tg-001.ts), so no experiment arm is counted here
  const gym = hasTable(db, 'skill_outcomes') ? (query<{ species: string; outcomes: number; wins: number }>(db,
    `SELECT replace(skill_id, 'loop-maker:gym:', '') || COALESCE('@' || model, '') AS species, COUNT(*) AS outcomes, COALESCE(SUM(success), 0) AS wins
       FROM skill_outcomes WHERE domain = 'gym' AND created_at >= ? GROUP BY skill_id, model ORDER BY outcomes DESC LIMIT 12`, since7)
    ?.flatMap((r) => {
      const species = safeId(r.species); if (!species) return [];
      const ok = r.outcomes >= MIN_GYM_N;
      return [{ species, outcomes: r.outcomes, wins: r.wins, win_rate: ok ? Math.round((1000 * r.wins) / r.outcomes) / 1000 : null, status: ok ? 'ok' as const : 'insufficient' as const }];
    }) ?? null) : null;

  const experiments = EXPERIMENT_FLAGS.map(([id, flag]) => ({ id, status: env[flag] === 'on' ? 'running' as const : 'off' as const }));

  // FE annotation: an area capability matches a gap when its id/label/alias words are all among the gap's words
  let gap_demand: Record<string, number> | null = null;
  if (open_gaps && hasTable(db, 'expert_capability_taxonomy')) {
    try {
      const caps = (db.prepare('SELECT id, label, aliases_json FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string }>)
        .map((c) => ({ id: c.id, phrases: [c.id.replace(/_/g, ' '), c.label, ...(JSON.parse(c.aliases_json || '[]') as string[])].map((p) => tokenize(p)).filter((t) => t.length) }));
      gap_demand = {};
      for (const words of gapTerms) {
        const set = new Set(words);
        for (const c of caps) if (c.phrases.some((p) => p.every((t) => set.has(t)))) gap_demand[c.id] = (gap_demand[c.id] ?? 0) + 1;
      }
    } catch { gap_demand = null; }
  }

  return { date: new Date(now).toISOString().slice(0, 10), generated_at: new Date(now).toISOString(), window_days: 7,
    lanes, skill_patterns, skill_cards, anti_patterns, open_gaps, negative_evidence, gym, experiments, gap_demand };
}

const digestId = (date: string) => `evolution-digest-${date}`;

/** The newest stored digest (shadow and on both store it), or null. */
export function latestEvolutionDigest(db: Database): (EvolutionDigest & { judgment_id: string }) | null {
  try {
    const row = db.prepare("SELECT id, answers_json FROM judgments WHERE judgment = 'evolution_digest' ORDER BY subject_id DESC, created_at DESC LIMIT 1")
      .get() as { id: string; answers_json: string } | undefined;
    return row ? { ...(JSON.parse(row.answers_json) as EvolutionDigest), judgment_id: row.id } : null;
  } catch { return null; }
}

/** Outbox payload under PAYLOAD_CAP: lists shrink to their top 3, then to counts only. */
export function digestPayload(d: EvolutionDigest): Record<string, unknown> {
  const fits = (p: unknown) => Buffer.byteLength(JSON.stringify(p)) <= PAYLOAD_CAP;
  const full = { ...d } as Record<string, unknown>;
  if (fits(full)) return full;
  const top3 = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 3) : v]));
  if (fits(top3)) return { ...top3, truncated: true };
  return { date: d.date, generated_at: d.generated_at, window_days: d.window_days, experiments: d.experiments, truncated: true };
}

const fmtSection = <T>(v: T[] | null, f: (x: T) => string) => (v === null ? 'unknown (no data source)' : v.length ? v.map(f).join('; ') : 'none in window');

/** The Commons question text: numbers and ids only. */
export function digestText(d: EvolutionDigest): string {
  return [
    `Evolution digest ${d.date} (last ${d.window_days} d), generated by Djimitflo from its own records.`,
    `Lanes (verified/regressed): ${fmtSection(d.lanes, (l) => `${l.lane} ${l.verified}/${l.regressed}`)}.`,
    `Gym species (wins/outcomes): ${fmtSection(d.gym, (g) => `${g.species} ${g.wins}/${g.outcomes}${g.win_rate === null ? ' insufficient' : ''}`)}.`,
    `Recurring failure signatures: ${fmtSection(d.anti_patterns, (a) => `${a.signature} (${a.lane ?? '?'}, gate ${a.gate ?? '?'}) x${a.occurrences}`)}.`,
    `Most credited patterns: ${fmtSection(d.skill_patterns, (s) => `${s.kind}:${s.ref} x${s.credits}`)}.`,
    `Open knowledge gaps: ${d.open_gaps === null ? 'unknown (no data source)' : d.open_gaps.total}.`,
    `New negative evidence: ${fmtSection(d.negative_evidence?.new_entries ?? null, (n) => `${n.id}${n.verdict ? ` ${n.verdict}` : ''}`)}.`,
    `Negative-evidence matches: ${fmtSection(d.negative_evidence?.matches ?? null, (m) => `${m.id} x${m.matches}`)}.`,
    `Skill cards: ${d.skill_cards === null ? 'unknown (no data source)' : d.skill_cards.by_status.map((c) => `${c.kind} ${c.status} ${c.cards}`).join(', ') || 'none'}.`,
    `Experiments: ${d.experiments.map((e) => `${e.id} ${e.status}`).join(', ')} (no interim results are shared).`,
    'Which of these would you test next, and what result would change your mind?',
  ].join('\n').slice(0, 2_000);
}

/** One Commons thread per day from the system author to each present resident (or 'commons' when none is registered). */
export function postDigestToCommons(db: Database, d: EvolutionDigest, judgmentId: string): boolean {
  const threadId = `evolution-digest:${d.date}`;
  const comms = new AgentCommunicationService(db); // ensures agent_messages
  if (db.prepare("SELECT 1 FROM agent_messages WHERE from_agent = ? AND json_extract(payload_json, '$.thread_id') = ? LIMIT 1").get(EVOLUTION_DIGEST_AUTHOR, threadId)) return false;
  const residents = (db.prepare(`SELECT id FROM agents WHERE status IN ('active', 'idle') AND json_extract(COALESCE(metadata, '{}'), '$.social_runtime.enabled') = 1 ORDER BY id LIMIT 4`)
    .all() as Array<{ id: string }>).map((r) => r.id);
  const text = digestText(d);
  db.transaction(() => {
    for (const to of residents.length ? residents : ['commons']) {
      comms.send({ from: EVOLUTION_DIGEST_AUTHOR, to, type: 'question', action: 'social.question', context: text, evidence: [`judgment:${judgmentId}`],
        threadId, epistemicRole: 'question', ttl: 86_400, idempotencyKey: `${threadId}:${to}`,
        params: { topic: `Evolution digest ${d.date}`, topic_ref: threadId, effect_scope: 'isolated', facilitated_by: 'evolution-feedback', board_summary: text.split('\n')[0] } });
    }
  })();
  return true;
}

export interface EvolutionFeedbackResult { mode: EvolutionFeedbackMode; stored: boolean; published: boolean; posted: boolean }

/** Today's tick: idempotent per UTC day (subject id / outbox aggregate id / Commons thread id carry the date). */
export function runEvolutionFeedback(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): EvolutionFeedbackResult {
  const mode = evolutionFeedbackMode(env);
  const result: EvolutionFeedbackResult = { mode, stored: false, published: false, posted: false };
  if (mode === 'off') return result;
  const date = new Date(now).toISOString().slice(0, 10);
  const subject = digestId(date);
  let row = db.prepare("SELECT id, answers_json FROM judgments WHERE judgment = 'evolution_digest' AND subject_id = ? LIMIT 1").get(subject) as { id: string; answers_json: string } | undefined;
  if (!row) {
    const d = buildEvolutionDigest(db, now, env);
    const answers = JSON.stringify(d);
    const id = `evolution-digest:${date}:${createHash('sha256').update(answers).digest('hex').slice(0, 12)}`;
    insertJudgmentRow(db, { id, judgment: 'evolution_digest', subject_type: 'evolution_digest', subject_id: subject, state_hash: createHash('sha256').update(answers).digest('hex'),
      mode: 'shadow', decision: 'recorded', reason: 'daily evolution digest (aggregates, ids and own titles only)', answers_json: answers, created_at: new Date(now).toISOString() });
    row = { id, answers_json: answers };
    result.stored = true;
  }
  if (mode !== 'on') return result;
  const digest = JSON.parse(row.answers_json) as EvolutionDigest;
  try {
    if (!db.prepare('SELECT 1 FROM event_outbox WHERE event_type = ? AND aggregate_id = ? LIMIT 1').get(EVOLUTION_DIGEST_EVENT, subject)) {
      // Best-effort (CODE-003): the stored judgment row is the record; a lost insert is retried next run (published=false).
      enqueueEvent(db, { type: EVOLUTION_DIGEST_EVENT, aggregateId: subject, payload: digestPayload(digest) });
      result.published = Boolean(db.prepare('SELECT 1 FROM event_outbox WHERE event_type = ? AND aggregate_id = ? LIMIT 1').get(EVOLUTION_DIGEST_EVENT, subject));
    }
  } catch { /* outbox absent: the stored digest still stands */ }
  try { result.posted = postDigestToCommons(db, digest, row.id); } catch (e) { console.warn('evolution digest Commons post failed:', e instanceof Error ? e.message : String(e)); }
  return result;
}

/** Frontier Experts read-only annotation: capability id → open-gap count, from the newest digest; null unless mode is on. */
export function gapDemandByCapability(db: Database, env: NodeJS.ProcessEnv = process.env): Map<string, number> | null {
  if (evolutionFeedbackMode(env) !== 'on') return null;
  const d = latestEvolutionDigest(db);
  return d?.gap_demand ? new Map(Object.entries(d.gap_demand)) : null;
}

export function startEvolutionFeedback(db: Database, intervalMs = 6 * 3_600_000): (() => void) | null {
  if (evolutionFeedbackMode() === 'off') return null;
  const tick = () => { try { runEvolutionFeedback(db); } catch (e) { console.warn('evolution feedback failed:', e instanceof Error ? e.message : String(e)); } };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
