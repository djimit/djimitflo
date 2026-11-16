import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Goal engineering G2/G3 (review 2026-11-16). The gap lanes ran on proxies — mutation score, tests green, merge survival —
 * and none of them separates a useful test from a useless one: 100% of merged loop test PRs "survived" (nobody reverts a
 * test), while human review produced no signal (718 approvals vs 5 denials, no written reasons). The one signal that does
 * discriminate is the operator's verdict on a merged PR, so it is captured per lane (Telegram `/lane 👍|👎 <pr> [why]`):
 *  - G2: the latest reasons travel into the next goal of that lane, so tacit knowledge reaches the maker;
 *  - G3: a lane with >= LANE_PAUSE_MIN_DOWN (3) down-votes and more down than up in LANE_FEEDBACK_DAYS (14) stops proposing.
 * ponytail: lanes are derived from the proposal title, no lane column; add one if lanes stop being title-shaped.
 */
export type GapLane = 'untested' | 'exports' | 'dashboard' | 'packages' | 'mutation';
export const GAP_LANES: GapLane[] = ['untested', 'exports', 'dashboard', 'packages', 'mutation'];
const DAYS = 14;
const MIN_DOWN = 3;

export function laneOfTitle(title: string): GapLane | null {
  if (/^Raise the mutation score of /.test(title)) return 'mutation';
  if (/^Test untested exports of /.test(title)) return 'exports';
  if (/^Add unit tests for dashboard\//.test(title)) return 'dashboard';
  if (/^Add unit tests for services\//.test(title)) return 'untested';
  if (/^Add unit tests for /.test(title)) return 'packages';
  return null;
}

function ensure(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lane_feedback (id TEXT PRIMARY KEY, lane TEXT NOT NULL, pr_number INTEGER, improvement_id TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('up', 'down')), reason TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

/** The lane of the loop PR `prNumber` (loop_runs.metadata.pr_number → goal → improvement title). */
export function laneOfPr(db: Database, prNumber: number): { lane: GapLane; improvementId: string } | null {
  const row = db.prepare(`SELECT s.id, s.title FROM loop_runs r JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id
    WHERE json_extract(r.metadata, '$.pr_number') = ? ORDER BY r.created_at DESC LIMIT 1`).get(prNumber) as { id: string; title: string } | undefined;
  const lane = row ? laneOfTitle(row.title) : null;
  return row && lane ? { lane, improvementId: row.id } : null;
}

export function recordLaneFeedback(db: Database, input: { prNumber: number; verdict: 'up' | 'down'; reason?: string; actor: string }, now = new Date()): { lane: GapLane } {
  ensure(db);
  const found = laneOfPr(db, input.prNumber);
  if (!found) throw new Error(`LANE_PR_UNKNOWN: #${input.prNumber} is not a test-gap loop PR`);
  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  db.prepare('INSERT INTO lane_feedback (id, lane, pr_number, improvement_id, verdict, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), found.lane, input.prNumber, found.improvementId, input.verdict, reason, input.actor, now.toISOString());
  return { lane: found.lane };
}

/** Latest operator reasons for a lane, newest first — appended to the lane's next goal description. */
export function laneFeedbackNotes(db: Database, lane: GapLane, limit = 3): string[] {
  ensure(db);
  return (db.prepare("SELECT verdict, reason FROM lane_feedback WHERE lane = ? AND reason IS NOT NULL ORDER BY created_at DESC LIMIT ?")
    .all(lane, limit) as Array<{ verdict: string; reason: string }>).map((r) => `${r.verdict === 'down' ? 'not useful' : 'useful'}: ${r.reason}`);
}

export function laneTally(db: Database, lane: GapLane, now = new Date()): { up: number; down: number } {
  ensure(db);
  const since = new Date(now.getTime() - (Number(process.env.LANE_FEEDBACK_DAYS) || DAYS) * 86_400_000).toISOString();
  const row = db.prepare("SELECT SUM(verdict = 'up') up, SUM(verdict = 'down') down FROM lane_feedback WHERE lane = ? AND created_at >= ?").get(lane, since) as { up: number | null; down: number | null };
  return { up: row.up ?? 0, down: row.down ?? 0 };
}

export function lanePaused(db: Database, lane: GapLane, now = new Date()): boolean {
  const { up, down } = laneTally(db, lane, now);
  return down >= (Number(process.env.LANE_PAUSE_MIN_DOWN) || MIN_DOWN) && down > up;
}

/** The text a gap proposal of `lane` carries for its maker; '' without feedback. */
export function laneFeedbackClause(db: Database, lane: GapLane): string {
  const notes = laneFeedbackNotes(db, lane);
  return notes.length ? ` OPERATOR FEEDBACK ON THIS LANE (latest first): ${notes.join(' | ')}.` : '';
}
