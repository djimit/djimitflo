import type { Database } from 'better-sqlite3';
import { createHash } from 'crypto';
import { enqueueEvent } from './event-outbox-service';
import { failureUnits } from './intelligence-metrics';
import { insertJudgmentRow } from './judgment-service';
import { ExpertResolverService } from './expert-resolver-service';
import { AgentCommunicationService } from './agent-communication-service';

/**
 * K5 (EVO-K, 16-10): evolution output flows back outward. Until now only the interest profile reached the agents
 * (interest-feedback.ts). Once a day this composes one evolution digest from data that already exists:
 *   lanes          verified / regressed production maker outcomes per lane (skill_outcomes, 7 d)
 *   skill_patterns most-credited memory rules, examples and genomes of verified runs (outcome_credits, 30 d)
 *   skill_cards    surviving skill cards (agent_skills with a `status` column — the K4 sibling); null until it exists
 *   anti_patterns  most recurring production failure signatures (§16 failureSignature: hash, lane, gate; 7 d)
 *   open_gaps      open `knowledge_gap` judgments (K2 sibling); null until one was ever written
 *   negative_evidence entries added to a `negative_evidence` table in 7 d (K3 sibling); null until it exists
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
  skill_cards: Array<{ skill_id: string; agents: number }> | null;
  anti_patterns: Array<{ signature: string; lane: string | null; gate: string | null; occurrences: number }> | null;
  open_gaps: { total: number; top: Array<{ gap: string; since: string }> } | null;
  negative_evidence: Array<{ id: string; verdict: string | null; title: string | null }> | null;
  gym: Array<{ species: string; outcomes: number; wins: number; win_rate: number | null; status: 'ok' | 'insufficient' }> | null;
  experiments: Array<{ id: string; status: 'running' | 'off' }>;
  /** capability id → open gaps matching it (input for the Frontier Experts `gap_demand` annotation) */
  gap_demand: Record<string, number> | null;
}

const hasTable = (db: Database, name: string): boolean => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); } catch { return false; }
};
const columns = (db: Database, name: string): Set<string> => {
  try { return new Set((db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name)); } catch { return new Set(); }
};
const query = <T>(db: Database, sql: string, ...args: unknown[]): T[] | null => { try { return db.prepare(sql).all(...args) as T[]; } catch { return null; } };

export function buildEvolutionDigest(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): EvolutionDigest {
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

  // K4 sibling contract: agent_skills grows a `status` column for distilled skill cards; until then the section is null
  const skill_cards = columns(db, 'agent_skills').has('status') ? (query<{ skill_id: string; agents: number }>(db,
    `SELECT skill_id, COUNT(DISTINCT agent_id) AS agents FROM agent_skills WHERE status IN ('active', 'promoted', 'surviving') AND enabled = 1
       GROUP BY 1 ORDER BY agents DESC, 1 LIMIT ?`, TOP)
    ?.flatMap((r) => { const id = safeId(r.skill_id); return id ? [{ skill_id: id, agents: r.agents }] : []; }) ?? null) : null;

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

  let open_gaps: EvolutionDigest['open_gaps'] = null;
  const gapRows = query<{ subject_id: string; decision: string; first: string }>(db,
    `SELECT j.subject_id, j.decision, (SELECT MIN(created_at) FROM judgments f WHERE f.judgment = 'knowledge_gap' AND f.subject_id = j.subject_id) AS first
       FROM judgments j WHERE j.judgment = 'knowledge_gap' AND j.created_at = (SELECT MAX(created_at) FROM judgments x WHERE x.judgment = 'knowledge_gap' AND x.subject_id = j.subject_id)
       GROUP BY j.subject_id`);
  if (gapRows && gapRows.length) {
    const open = gapRows.filter((r) => !['no', 'closed', 'resolved', 'rejected', 'error'].includes(r.decision))
      .flatMap((r) => { const gap = safeId(r.subject_id); return gap ? [{ gap, since: r.first }] : []; })
      .sort((a, b) => a.since.localeCompare(b.since) || a.gap.localeCompare(b.gap));
    open_gaps = { total: open.length, top: open.slice(0, TOP * 2) };
  }

  let negative_evidence: EvolutionDigest['negative_evidence'] = null;
  const ne = columns(db, 'negative_evidence');
  const neDate = ne.has('created_at') ? 'created_at' : ne.has('decided_on') ? 'decided_on' : null;
  if (ne.has('id') && neDate) {
    negative_evidence = query<{ id: string; verdict: string | null; title: string | null }>(db,
      `SELECT id, ${ne.has('verdict') ? 'verdict' : 'NULL'} AS verdict, ${ne.has('title') ? 'title' : 'NULL'} AS title FROM negative_evidence
         WHERE ${neDate} >= ? ORDER BY ${neDate} DESC, id LIMIT ?`, neDate === 'decided_on' ? since7.slice(0, 10) : since7, TOP * 2)
      ?.flatMap((r) => { const id = safeId(r.id); return id ? [{ id, verdict: safeId(r.verdict), title: safeTitle(r.title) }] : []; }) ?? null;
  }

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

  let gap_demand: Record<string, number> | null = null;
  if (open_gaps && hasTable(db, 'expert_capability_taxonomy')) {
    gap_demand = {};
    try {
      const resolver = new ExpertResolverService(db);
      for (const g of open_gaps.top) {
        for (const c of resolver.matchCapabilities(g.gap.replace(/[_:./@+-]+/g, ' '), 2)) gap_demand[c.id] = (gap_demand[c.id] ?? 0) + 1;
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
    `New negative evidence: ${fmtSection(d.negative_evidence, (n) => `${n.id}${n.verdict ? ` ${n.verdict}` : ''}`)}.`,
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
