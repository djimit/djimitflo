import type { Database } from 'better-sqlite3';
import { enqueueEvent } from './event-outbox-service';

/**
 * Plan N4 (feedback to the agents, step 1): Djimitflo tells its scouts what turned out to matter. Once a day it derives an
 * interest profile — frequent terms from discoveries judged relevant (G3 'yes') and KB pages panels actually retrieved in the
 * last 30 days (proposal titles are code tasks, not research topics) — and publishes `djimitflo.feedback.interests` on the event bus (outbox). The
 * scout (scripts/fleet-discovery-publisher.py --interests-from-bus) adds these terms to its static list.
 *   FEEDBACK_INTERESTS_ENABLED=true (default off)
 */
const STOP = new Set(('about above after again against among around based because before being between beyond both build could during each every '
  + 'first from further have into large language learning model models more most other over paper papers same should since some such than that '
  + 'their them then there these they this those through towards under using very what when where which while with within without would your '
  + 'approach approaches method methods results study system systems based toward towards summaries summary proposal djimitflo '
  // generic engineering words match nearly every paper as a substring (first prod profile 2026-09-28)
  + 'service services tests testing implementation evidence raise score enforced intelligence improve improving general new').split(' '));

export function interestTerms(texts: string[], max = 20): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w));
    for (const w of new Set(words)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

export function interestProfile(db: Database, now = Date.now()): { terms: string[]; sources: Record<string, number> } {
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const relevant = all<{ t: string }>(`SELECT i.canonical_name AS t FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
    WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' AND j.created_at >= ?`, since).map((r) => r.t);
  const kb = all<{ reason: string }>("SELECT reason FROM judgments WHERE judgment = 'kb_retrieval' AND created_at >= ?", since)
    .flatMap((r) => (r.reason || '').split(' ').map((hit) => hit.split('@')[0]))
    .map((p) => (all<{ title: string }>('SELECT title FROM kb_pages WHERE path = ?', p)[0]?.title ?? ''));
  return { terms: interestTerms([...relevant, ...kb]), sources: { relevant: relevant.length, kb_hits: kb.length } };
}

/** Enqueue today's profile once (the date is the aggregate id). */
export function publishInterestProfile(db: Database, now = Date.now()): boolean {
  const aggregateId = `interests-${new Date(now).toISOString().slice(0, 10)}`;
  if (db.prepare('SELECT 1 FROM event_outbox WHERE aggregate_id = ? LIMIT 1').get(aggregateId)) return false;
  const profile = interestProfile(db, now);
  if (!profile.terms.length) return false;
  enqueueEvent(db, { type: 'djimitflo.feedback.interests', aggregateId, payload: profile });
  return true;
}

export function startInterestFeedback(db: Database, intervalMs = 6 * 3_600_000): (() => void) | null {
  if (process.env.FEEDBACK_INTERESTS_ENABLED !== 'true') return null;
  const tick = () => { try { publishInterestProfile(db); } catch (e) { console.warn('interest feedback failed:', e instanceof Error ? e.message : String(e)); } };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
