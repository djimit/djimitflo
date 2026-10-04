import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { kbContext } from './kb-corpus';
import { forecastScores } from './forecast-scoring';
import { knowledgeOverview } from './knowledge-overview';

/**
 * AR-W (operator 04-10): committee swarms on the workstation. For every new proposal a committee of member genomes
 * (persona + knowledge recipe + strategy lines) gives a calibrated probability that it ends verified. Members are scored
 * on REAL outcomes only (forecast-scoring: Brier skill vs the per-source base rate) — no peer review decides; Commons
 * residents judged by talk were anti-predictive (AUC 0.25). Selection and mutation of members follow once outcomes exist.
 * The workstation pulls jobs (never pushed to) and runs members on its local model, capped per day.
 * COMMITTEE_SWARM_ENABLED=true (default off); COMMITTEE_MAX_PER_DAY (default 40 jobs).
 *
 * Leakage: the question is frozen at enqueue time (before the proposal's goal exists) and every forecast carries that
 * moment as `as_of`; forecast-scoring counts a forecast only if `as_of` precedes the goal.
 */
export const committeeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.COMMITTEE_SWARM_ENABLED === 'true';
const maxPerDay = (env: NodeJS.ProcessEnv = process.env) => Number(env.COMMITTEE_MAX_PER_DAY) || 40;

/**
 * First generation: the Commons personas. `knowledge` is the member's knowledge RECIPE — which of Djimitflo's resources it
 * reads before forecasting (AR-W3): history (the lane's record), skills (proven verified examples), memory (promoted
 * engineering rules), experts (Frontier Experts technique-card claims), kb (DjimitKBWiki pages, embedding retrieval),
 * discoveries (fleet discoveries judged relevant), none (the question only). Recipes are genes: evolution swaps them.
 */
export const RECIPES = ['history', 'skills', 'memory', 'experts', 'kb', 'discoveries', 'none'] as const;
export const SEED_MEMBERS: Array<{ id: string; persona: string; knowledge: string; lines: string[] }> = [
  { id: 'cm-archivist', persona: 'Archivist', knowledge: 'history', lines: ['Weigh what recent outcomes of the same lane say before anything else.'] },
  { id: 'cm-engineer', persona: 'Engineer', knowledge: 'skills', lines: ['Judge whether the change is small, concrete and confined to one file in this repository.'] },
  { id: 'cm-methodologist', persona: 'Methodologist', knowledge: 'memory', lines: ['Ask whether one command can prove success; vague verification means a low probability.'] },
  { id: 'cm-oracle', persona: 'Oracle', knowledge: 'none', lines: ['Start from the lane base rate and move away from it only on concrete evidence.'] },
  { id: 'cm-skeptic', persona: 'Skeptic', knowledge: 'experts', lines: ['Look for the most likely way this fails: wrong target, flaky test, scope creep.'] },
  { id: 'cm-scholar', persona: 'Scholar', knowledge: 'kb', lines: ['Use what the knowledge base says about this area; ignore it when it is off-topic.'] },
  { id: 'cm-scout', persona: 'Scout', knowledge: 'discoveries', lines: ['Check whether recent research or tools change how hard this is.'] },
];

export function seedCommittee(db: Database, now = new Date().toISOString()): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO committee_genomes (id, parent_id, persona, knowledge, lines_json, status, origin, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, 'active', 'seed', ?, ?)`);
  for (const m of SEED_MEMBERS) ins.run(m.id, m.persona, m.knowledge, JSON.stringify(m.lines), now, now);
}

export interface CommitteeMember { id: string; persona: string; knowledge: string; lines: string[] }
export function activeMembers(db: Database): CommitteeMember[] {
  return (db.prepare("SELECT id, persona, knowledge, lines_json FROM committee_genomes WHERE status = 'active' ORDER BY id").all() as Array<{ id: string; persona: string; knowledge: string; lines_json: string }>)
    .map((r) => ({ id: r.id, persona: r.persona, knowledge: r.knowledge, lines: (() => { try { return JSON.parse(r.lines_json) as string[]; } catch { return []; } })() }));
}

interface ProposalLike { id: string; type?: string; title: string; description?: string | null; rationale?: string | null; source?: string }

/** Queue one committee question for a new proposal (once per proposal, capped per day). Returns the job id or null. */
export function enqueueCommittee(db: Database, p: ProposalLike, now = new Date(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (!committeeEnabled(env)) return null;
  seedCommittee(db, now.toISOString());
  if (db.prepare('SELECT 1 FROM committee_jobs WHERE subject_id = ? LIMIT 1').get(p.id)) return null;
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  if ((db.prepare('SELECT COUNT(*) AS n FROM committee_jobs WHERE created_at >= ?').get(since) as { n: number }).n >= maxPerDay(env)) return null;
  // context the members may use: the lane's recent record (what the history/base-rate lenses read); nothing after as_of
  const recent = db.prepare(`SELECT title, status FROM self_improvements WHERE source = ? AND id <> ? AND status IN ('verified','applied','regressed','no_change','infra_failed','needs_more_evidence')
    ORDER BY updated_at DESC LIMIT 10`).all(p.source ?? '', p.id) as Array<{ title: string; status: string }>;
  const verified = recent.filter((r) => r.status === 'verified' || r.status === 'applied').length;
  const question = {
    proposal: { type: p.type ?? null, title: p.title, description: (p.description ?? '').slice(0, 4000), rationale: (p.rationale ?? '').slice(0, 2000), source: p.source ?? null },
    lane_recent: recent.map((r) => `${r.status}: ${r.title.slice(0, 120)}`), lane_recent_verified: `${verified}/${recent.length}`,
  };
  const id = randomUUID();
  db.prepare("INSERT INTO committee_jobs (id, subject_id, question_json, as_of, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
    .run(id, p.id, JSON.stringify(question), now.toISOString(), now.toISOString());
  return id;
}

const words = (text: string): string[] => [...new Set((text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !['tests', 'should', 'which', 'their', 'there', 'about', 'services', 'packages', 'server'].includes(w)))].slice(0, 8);

/** The context a member's recipe gives it (no outcome information: KB, cards, rules, examples and discoveries only). */
export async function memberContext(db: Database, recipe: string, question: { proposal?: { title?: string; description?: string | null; source?: string | null } }, subjectId: string): Promise<string> {
  const p = question.proposal ?? {}; const text = `${p.title ?? ''}\n${p.description ?? ''}`;
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const cap = (lines: string[]) => lines.join('\n').slice(0, 1500);
  switch (recipe) {
    case 'kb': return (await kbContext(db, { type: 'committee', id: subjectId }, text, 3).catch(() => null)) ?? '';
    case 'experts': {
      const ws = words(text); if (!ws.length) return '';
      const rows = all<{ subject: string; relation: string; object: string; confidence: number }>(`SELECT subject, relation, object, confidence FROM expert_claims
        WHERE ${ws.map(() => '(lower(subject) LIKE ? OR lower(object) LIKE ?)').join(' OR ')} ORDER BY confidence DESC LIMIT 5`, ...ws.flatMap((w) => [`%${w}%`, `%${w}%`]));
      return cap(rows.map((r) => `- claim: ${r.subject} ${r.relation} ${r.object} (confidence ${Number(r.confidence).toFixed(2)})`));
    }
    case 'memory': return cap(all<{ title: string; content: string }>(`SELECT title, content FROM memory_candidates WHERE status = 'promoted' AND memory_type = 'engineering_rule'
      ORDER BY updated_at DESC LIMIT 3`).map((r) => `- rule: ${r.title}: ${r.content.replace(/\s+/g, ' ').slice(0, 300)}`));
    case 'skills': return cap(all<{ title: string }>(`SELECT title FROM self_improvements WHERE source = ? AND status IN ('verified','applied') AND id <> ?
      ORDER BY updated_at DESC LIMIT 5`, p.source ?? '', subjectId).map((r) => `- verified example: ${r.title}`));
    case 'discoveries': return cap(all<{ t: string }>(`SELECT i.canonical_name AS t FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
      WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' ORDER BY j.created_at DESC LIMIT 5`).map((r) => `- relevant discovery: ${r.t}`));
    default: return ''; // history (already in the frozen question) and none
  }
}

/** Workstation pull: the oldest open job (a claim older than 1 h is offered again) with the active members and their context. */
export async function claimCommittee(db: Database, host: string, now = new Date()): Promise<{ jobId: string; question: unknown; members: Array<CommitteeMember & { context: string }> } | null> {
  if (!committeeEnabled()) return null;
  const stale = new Date(now.getTime() - 3_600_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const job = db.prepare(`SELECT id, subject_id, question_json FROM committee_jobs WHERE created_at >= ? AND (status = 'queued' OR (status = 'claimed' AND claimed_at < ?))
    ORDER BY created_at LIMIT 1`).get(week, stale) as { id: string; subject_id: string; question_json: string } | undefined;
  if (!job) return null;
  db.prepare("UPDATE committee_jobs SET status = 'claimed', host = ?, claimed_at = ? WHERE id = ?").run(host, now.toISOString(), job.id);
  const question = JSON.parse(job.question_json);
  const members = [];
  for (const m of activeMembers(db)) members.push({ ...m, context: await memberContext(db, m.knowledge, question, job.subject_id) });
  return { jobId: job.id, question, members };
}

/** One forecast per member as a `forecast:committee:<member>` judgment, stamped with the job's as_of. */
export function recordCommittee(db: Database, jobId: string, host: string, answers: unknown, now = new Date()): number {
  const job = db.prepare('SELECT subject_id, as_of, host, status FROM committee_jobs WHERE id = ?').get(jobId) as { subject_id: string; as_of: string; host: string | null; status: string } | undefined;
  if (!job || job.host !== host) throw new Error('COMMITTEE_JOB_NOT_FOUND');
  if (job.status === 'done') throw new Error('COMMITTEE_JOB_ALREADY_DONE');
  if (!Array.isArray(answers)) throw new Error('COMMITTEE_ANSWERS_INVALID');
  const members = new Set(activeMembers(db).map((m) => m.id));
  const ins = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
    VALUES (?, ?, 'self_improvement', ?, ?, 'shadow', ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const a of answers as Array<{ member?: unknown; p?: unknown; rationale?: unknown; model?: unknown }>) {
    const p = Number(a?.p);
    if (typeof a?.member !== 'string' || !members.has(a.member) || !Number.isFinite(p) || p < 0 || p > 1) continue;
    const rationale = typeof a.rationale === 'string' ? a.rationale.slice(0, 500) : '';
    ins.run(randomUUID(), `forecast:committee:${a.member}`, job.subject_id, jobId, p >= 0.5 ? 'yes' : 'no', rationale,
      JSON.stringify({ p, as_of: job.as_of }), typeof a.model === 'string' ? a.model.slice(0, 80) : `remote:${host}`, now.toISOString());
    n++;
  }
  // AR-W3: the committee's own forecast — members weighted by their measured skill, so the committee learns whom to trust
  const votes = db.prepare("SELECT judgment, answers_json FROM judgments WHERE state_hash = ? AND judgment LIKE 'forecast:committee:%'").all(jobId) as Array<{ judgment: string; answers_json: string }>;
  if (votes.length) {
    const w = memberWeights(db);
    let num = 0; let den = 0;
    for (const v of votes) { const m = v.judgment.slice('forecast:committee:'.length); const wt = w.get(m) ?? 1; num += wt * Number(JSON.parse(v.answers_json).p); den += wt; }
    if (den > 0) ins.run(randomUUID(), 'forecast:committee', job.subject_id, jobId, num / den >= 0.5 ? 'yes' : 'no', `weighted mean of ${votes.length} members`,
      JSON.stringify({ p: +(num / den).toFixed(4), as_of: job.as_of }), 'committee', now.toISOString());
  }
  db.prepare("UPDATE committee_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(now.toISOString(), jobId);
  return n;
}

/** Skill per member from real outcomes (Brier skill vs the base rate). Below 10 resolved forecasts a member weighs 1. */
export function memberWeights(db: Database): Map<string, number> {
  const w = new Map<string, number>();
  for (const s of forecastScores(db)) {
    if (!s.forecaster.startsWith('forecast:committee:')) continue;
    w.set(s.forecaster.slice('forecast:committee:'.length), s.n < 10 ? 1 : Math.max(0.05, 1 + 2 * s.skill));
  }
  return w;
}

/**
 * AR-W3 — survival of the fittest, gated by statistics. Once a day:
 *  - extinction: a member with >= EXTINCT_MIN_N resolved forecasts whose skill is below 0 (worse than the base rate) and
 *    below the best member's is retired (reversible: status only);
 *  - reproduction: while the committee has fewer than COMMITTEE_MAX_MEMBERS, the best member with >= 5 resolved forecasts
 *    gets one child with exactly one gene changed — its knowledge recipe (to the least-used one, for diversity) or one
 *    calibration line. Children forecast from the next question on and are scored like everyone else.
 */
export const EXTINCT_MIN_N = 30;
const LINE_POOL = [
  'Before answering, name the single most likely failure and lower p if it applies.',
  'If the proposal names one file and one command, move toward the lane rate of verified examples.',
  'Distrust proposals that touch several files or need a human to judge success.',
  'Prefer the lane record over your intuition when they disagree.',
];
export function evolveCommittee(db: Database, now = new Date(), env: NodeJS.ProcessEnv = process.env): { retired: string[]; born: string | null } {
  const out = { retired: [] as string[], born: null as string | null };
  if (!committeeEnabled(env)) return out;
  const today = now.toISOString().slice(0, 10);
  if (db.prepare("SELECT 1 FROM committee_genomes WHERE origin = 'mutation' AND created_at >= ? LIMIT 1").get(today)) return out; // once a day
  const scores = forecastScores(db).filter((s) => s.forecaster.startsWith('forecast:committee:'))
    .map((s) => ({ id: s.forecaster.slice('forecast:committee:'.length), n: s.n, skill: s.skill }));
  const active = activeMembers(db);
  const scored = scores.filter((s) => active.some((m) => m.id === s.id));
  const best = scored.filter((s) => s.n >= 5).sort((a, b) => b.skill - a.skill)[0];
  for (const s of scored) {
    if (s.n >= EXTINCT_MIN_N && s.skill < 0 && best && s.id !== best.id && s.skill < best.skill && active.length - out.retired.length > 3) {
      db.prepare("UPDATE committee_genomes SET status = 'retired', updated_at = ? WHERE id = ?").run(now.toISOString(), s.id);
      out.retired.push(s.id);
    }
  }
  const max = Number(env.COMMITTEE_MAX_MEMBERS) || 9;
  if (best && active.length - out.retired.length < max) {
    const parent = active.find((m) => m.id === best.id)!;
    const used = new Map<string, number>(RECIPES.map((r) => [r, 0]));
    for (const m of activeMembers(db)) used.set(m.knowledge, (used.get(m.knowledge) ?? 0) + 1);
    const swapRecipe = Number(today.slice(-2)) % 2 === 0;
    const recipe = swapRecipe ? [...used.entries()].filter(([r]) => r !== parent.knowledge).sort((a, b) => a[1] - b[1])[0][0] : parent.knowledge;
    const extra = LINE_POOL.find((l) => !parent.lines.includes(l));
    const lines = swapRecipe || !extra ? parent.lines : [...parent.lines, extra];
    const id = `cm-${parent.persona.toLowerCase()}-${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO committee_genomes (id, parent_id, persona, knowledge, lines_json, status, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'mutation', ?, ?)`).run(id, parent.id, parent.persona, recipe, JSON.stringify(lines), now.toISOString(), now.toISOString());
    out.born = id;
  }
  return out;
}

/** Hourly check; evolution itself runs at most once a day. */
export function startCommitteeEvolution(db: Database, intervalMs = 3_600_000): (() => void) | null {
  if (!committeeEnabled()) return null;
  const tick = () => { try { const r = evolveCommittee(db); if (r.born || r.retired.length) console.log(`🧠 committee: born ${r.born ?? '-'}, retired ${r.retired.join(',') || '-'}`); } catch (e) { console.warn('committee evolution failed:', e instanceof Error ? e.message : String(e)); } };
  const t = setInterval(tick, intervalMs); t.unref?.();
  return () => clearInterval(t);
}

/**
 * AR-W5 (operator 04-10: "every agent must produce action insights — if not, don't proceed"). Residents talk in the Commons
 * but never made a measurable call (≈ 5 000 messages, 0 verified). Each resident now also answers every committee question
 * with its own model (in-process, on the VPS) as `forecast:resident:<agent>`, scored like everyone else on real outcomes.
 * ARENA_GATE_ENABLED: a resident that is worse than the base rate on >= EXTINCT_MIN_N scored forecasts, or that keeps
 * talking without making calls, stops being scheduled.
 */
export function parseForecastText(text: unknown): { p: number; rationale: string } | null {
  const m = /\{[^{}]*"p"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  const p = Number(m[1]);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  let rationale = '';
  try { rationale = String((JSON.parse(m[0]) as { rationale?: unknown }).rationale ?? '').slice(0, 500); } catch { /* p is enough */ }
  return { p, rationale };
}

/** The oldest open committee question (last 7 days) this resident has not answered yet. */
export function pendingResidentQuestion(db: Database, agentId: string, now = new Date()): { jobId: string; subjectId: string; asOf: string; question: unknown } | null {
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  let row: { id: string; subject_id: string; as_of: string; question_json: string } | undefined;
  try {
    row = db.prepare(`SELECT j.id, j.subject_id, j.as_of, j.question_json FROM committee_jobs j WHERE j.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM judgments f WHERE f.judgment = ? AND f.subject_id = j.subject_id) ORDER BY j.created_at LIMIT 1`)
      .get(week, `forecast:resident:${agentId}`) as typeof row;
  } catch { return null; } // minimal schemas without the arena tables
  return row ? { jobId: row.id, subjectId: row.subject_id, asOf: row.as_of, question: JSON.parse(row.question_json) } : null;
}

export function recordResidentForecast(db: Database, q: { jobId: string; subjectId: string; asOf: string }, agentId: string, f: { p: number; rationale: string }, model: string, now = new Date()): void {
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
    VALUES (?, ?, 'self_improvement', ?, ?, 'shadow', ?, ?, ?, ?, ?)`)
    .run(randomUUID(), `forecast:resident:${agentId}`, q.subjectId, q.jobId, f.p >= 0.5 ? 'yes' : 'no', f.rationale, JSON.stringify({ p: f.p, as_of: q.asOf }), model.slice(0, 80), now.toISOString());
}

export const arenaGateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.ARENA_GATE_ENABLED === 'true';
/** Survival gate for a resident: no measurable call, or worse than the base rate on enough calls → stop scheduling it. */
export function arenaGate(db: Database, agentId: string, now = new Date()): { allowed: boolean; reason: string } {
  let score: ReturnType<typeof forecastScores>[number] | undefined;
  try { score = forecastScores(db).find((s) => s.forecaster === `forecast:resident:${agentId}`); } catch { /* no outcome tables */ }
  if (score && score.n >= EXTINCT_MIN_N && score.skill < 0) return { allowed: false, reason: `worse than the base rate on ${score.n} scored forecasts (skill ${score.skill.toFixed(2)})` };
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const all = <T>(sql: string, ...a: unknown[]) => { try { return db.prepare(sql).get(...a) as T; } catch { return undefined; } };
  const questions = all<{ n: number }>('SELECT COUNT(*) AS n FROM committee_jobs WHERE created_at >= ?', week)?.n ?? 0;
  const talk = all<{ n: number }>('SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = ? AND timestamp >= ?', agentId, week)?.n ?? 0;
  const calls = all<{ n: number }>('SELECT COUNT(*) AS n FROM judgments WHERE judgment = ? AND created_at >= ?', `forecast:resident:${agentId}`, week)?.n ?? 0;
  if (questions >= 5 && talk >= 30 && calls === 0) return { allowed: false, reason: `${talk} messages but no measurable call in 7 days` };
  return { allowed: true, reason: score ? `skill ${score.skill.toFixed(2)} on ${score.n}` : 'not scored yet' };
}

/**
 * AR-W6 (operator 04-10, the same rule for the fleet): a fleet agent's measurable call is a discovery judged relevant. A source
 * with >= FLEET_MIN_JUDGED judged discoveries (30 days) and none relevant stops being ingested — its events are still
 * recorded (N1), but no more units, judgments or jev calls are spent on them. Prod 04-10: hermes-macmini 601 events, 90
 * judged, 0 relevant; the scout 129 relevant, the operator's reading list 7, the KB sync 2.
 */
export const FLEET_MIN_JUDGED = 50;
export function fleetSourceGate(db: Database, agent: string, now = Date.now()): { allowed: boolean; reason: string } {
  const s = knowledgeOverview(db, now).sources.find((r) => r.source === agent);
  if (!s) return { allowed: true, reason: 'no record yet' };
  const judged = s.yes + s.uncertain + s.no;
  if (judged >= FLEET_MIN_JUDGED && s.yes === 0) return { allowed: false, reason: `${judged} discoveries judged, none relevant` };
  return { allowed: true, reason: `${s.yes}/${judged} relevant` };
}
