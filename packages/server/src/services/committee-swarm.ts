import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

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

/** First generation: the Commons personas, each with its own lens on "will this be verified?". */
export const SEED_MEMBERS: Array<{ id: string; persona: string; knowledge: string; lines: string[] }> = [
  { id: 'cm-archivist', persona: 'Archivist', knowledge: 'history', lines: ['Weigh what recent outcomes of the same lane say before anything else.'] },
  { id: 'cm-engineer', persona: 'Engineer', knowledge: 'code', lines: ['Judge whether the change is small, concrete and confined to one file in this repository.'] },
  { id: 'cm-methodologist', persona: 'Methodologist', knowledge: 'evidence', lines: ['Ask whether one command can prove success; vague verification means a low probability.'] },
  { id: 'cm-oracle', persona: 'Oracle', knowledge: 'base_rate', lines: ['Start from the lane base rate and move away from it only on concrete evidence.'] },
  { id: 'cm-skeptic', persona: 'Skeptic', knowledge: 'failures', lines: ['Look for the most likely way this fails: wrong target, flaky test, scope creep.'] },
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

/** Workstation pull: the oldest open job (a claim older than 1 h is offered again) with the active members. */
export function claimCommittee(db: Database, host: string, now = new Date()): { jobId: string; question: unknown; members: CommitteeMember[] } | null {
  if (!committeeEnabled()) return null;
  const stale = new Date(now.getTime() - 3_600_000).toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const job = db.prepare(`SELECT id, question_json FROM committee_jobs WHERE created_at >= ? AND (status = 'queued' OR (status = 'claimed' AND claimed_at < ?))
    ORDER BY created_at LIMIT 1`).get(week, stale) as { id: string; question_json: string } | undefined;
  if (!job) return null;
  db.prepare("UPDATE committee_jobs SET status = 'claimed', host = ?, claimed_at = ? WHERE id = ?").run(host, now.toISOString(), job.id);
  return { jobId: job.id, question: JSON.parse(job.question_json), members: activeMembers(db) };
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
  db.prepare("UPDATE committee_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(now.toISOString(), jobId);
  return n;
}
