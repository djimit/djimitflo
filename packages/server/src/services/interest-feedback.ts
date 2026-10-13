import type { Database } from 'better-sqlite3';
import { enqueueEvent } from './event-outbox-service';
import { failureUnits } from './intelligence-metrics';

/**
 * Plan N4 (feedback to the agents, step 1): Djimitflo tells its scouts what turned out to matter. Once a day it derives an
 * interest profile — frequent terms from discoveries judged relevant (G3 'yes') and KB pages panels actually retrieved in the
 * last 30 days (proposal titles are code tasks, not research topics) — and publishes `djimitflo.feedback.interests` on the event bus (outbox). The
 * scout (scripts/fleet-discovery-publisher.py --interests-from-bus) adds these terms to its static list.
 *   FEEDBACK_INTERESTS_ENABLED=true (default off)
 *
 * Yield gate (Phase KE 09-10): unchecked, the profile broadened the scout into generic terms ('agent', 'benchmark', 'prove',
 * 'generation') — 3,992 of 4,776 scout papers matched only profile terms at 5.7 % jev 'yes' vs 13.5 % for the static list,
 * which overloaded jev and fed the profile again. A candidate term is now published only if, over the last 30 days, the
 * discoveries the scout matched on it ('scout match:' / 'match:' notes) have a jev 'yes' rate ≥ the static list's, measured on
 * ≥ MIN_TERM_N judged matches; generic words never qualify, and at most PROFILE_TERM_CAP terms ride along so the static list
 * (which the publisher keeps first) stays the bulk of the scout — the exploration reserve against a self-reinforcing profile.
 * So the profile can still learn, up to TRIAL_SLOTS unmeasured candidates (n < MIN_TERM_N) ride along as trials after the
 * measured terms: a trial keeps its slot until n ≥ MIN_TERM_N (then the yield gate keeps or drops it) for at most
 * TRIAL_MAX_DAYS; a dropped trial cools down for COOLDOWN_DAYS. The state (trial `since`, `cooldown`) lives in the profile event.
 *
 * Gap terms (ECO item 3, 10-10): the most recurring production failure signatures (§16 failureSignature: lane | gate | error
 * class, 30 d, ≥ 2 occurrences) contribute one word each — from the signature's error class, gate or lane, never raw text —
 * as trials in their own GAP_TRIAL_SLOTS slot, so a measured gap reaches discovery even while the two ordinary trial slots
 * are taken (prod 10-10: 'flywheel' + 'verification' hold both for up to 14 days). Same pre-registered kill rule as every trial:
 * kept only if its jev-yes rate ≥ the static-list baseline (18.1 % on 09-10) at n ≥ MIN_TERM_N within TRIAL_MAX_DAYS, else
 * dropped and cooled down.
 */
const STOP = new Set(('about above after again against among around based because before being between beyond both build could during each every '
  + 'first from further have into large language learning model models more most other over paper papers same should since some such than that '
  + 'their them then there these they this those through towards under using very what when where which while with within without would your '
  + 'approach approaches method methods results study system systems based toward towards summaries summary proposal djimitflo '
  // generic engineering words match nearly every paper as a substring (first prod profile 2026-09-28)
  + 'service services tests testing implementation evidence raise score enforced intelligence improve improving general new '
  // verbs from proposal/page titles (prod profile 2026-09-30 carried 'added')
  + 'added adding update updated updates create created remove removed using').split(' '));

export function interestTerms(texts: string[], max = 20): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    // any digit = an id or version, never an interest (prod 2026-09-30: 'proposal-61847269')
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w) && !/\d/.test(w));
    for (const w of new Set(words)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  // a plural and its singular are one interest ('agents'/'agent', 'benchmarks'/'benchmark'): keep the singular
  for (const [w, n] of [...counts]) {
    const singular = w.endsWith('s') ? w.slice(0, -1) : null;
    if (singular && counts.has(singular)) { counts.set(singular, counts.get(singular)! + n); counts.delete(w); }
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

/** Mirror of INTERESTS in scripts/fleet-discovery-publisher.py (drift-tested): the scout's static list, the yield baseline. */
export const SCOUT_STATIC_TERMS = ['test generation', 'unit test', 'mutation', 'program repair', 'bug fix', 'code review', 'coding agent',
  'software engineering agent', 'swe-bench', 'agent evaluation', 'llm-as-a-judge', 'tool use', 'context compression',
  'self-improv', 'fault localization', 'regression', 'flaky test', 'static analysis', 'prompt injection'];
export const MIN_TERM_N = 20;
export const PROFILE_TERM_CAP = 10;
export const TRIAL_SLOTS = 2;
export const GAP_TRIAL_SLOTS = 1;
const TRIAL_MAX_DAYS = 14;
const COOLDOWN_DAYS = 30;
/** Substrings of nearly every AI paper: the prod profile terms of 09-10 that pulled papers at or below half the static yield. */
const GENERIC = new Set(('agent agentic benchmark prove generation reasoning evaluation evaluating optimization context engineering '
  + 'software coding prompt memory alignment automated operator adaptive program').split(' '));
const isGeneric = (w: string) => GENERIC.has(w) || (w.endsWith('s') && GENERIC.has(w.slice(0, -1)));
/** Failure vocabulary and runtime names: present in every signature, never a research topic. */
const GAP_STOP = new Set(('error errors failed failure failures exceeded threshold changed runtime budget check checks under small exited '
  + 'opencode codex claude atomic remote maker checker reviewer security fixed unknown').split(' '));

export interface GapTerm { term: string; signature: string; occurrences: number }

/** One discovery term per recurring production failure signature (most frequent first), derived from the signature's parts. */
export function gapTerms(db: Database, since: string, max = GAP_TRIAL_SLOTS * 3): GapTerm[] {
  const bySig = new Map<string, { key: string; parts: Array<string | null>; n: number }>();
  for (const u of failureUnits(db, since)) {
    if (!u.failed || !u.signature) continue;
    const s = u.signature; const c = bySig.get(s.signature) ?? { key: s.key, parts: [s.error_class, s.gate, s.lane.split(':')[0]], n: 0 };
    c.n++; bySig.set(s.signature, c);
  }
  const out: GapTerm[] = [];
  for (const c of [...bySig.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))) {
    const words = c.parts.flatMap((p) => (p ?? '').toLowerCase().replace(/<[a-z]+>/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/));
    const term = words.find((w) => w.length >= 5 && !STOP.has(w) && !GAP_STOP.has(w) && !isGeneric(w) && !SCOUT_STATIC_TERMS.includes(w)
      && !out.some((o) => o.term === w));
    if (term) out.push({ term, signature: c.key, occurrences: c.n });
    if (out.length >= max) break;
  }
  return out;
}

export interface TermYield { term: string; yield: number | null; n: number; trial?: true; since?: string; gap?: string }
export interface Cooldown { term: string; at: string }

/** Per matched term: jev 'yes' rate over the judged scout discoveries of the window, plus the static-list baseline. */
export function termYields(db: Database, since: string): { terms: Map<string, { n: number; yes: number }>; baseline: { n: number; yes: number } } {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const hits = new Map<string, string[]>();
  for (const e of all<{ ref: string | null; note: string | null }>(`SELECT json_extract(payload, '$.ref') AS ref, json_extract(payload, '$.note') AS note
      FROM external_events WHERE event_type LIKE 'discovery.%' AND occurred_at >= ?`, new Date(Date.parse(since) - 30 * 86_400_000).toISOString())) {
    const m = /\bmatch:\s*([^;]*)/.exec(e.note ?? '');
    if (e.ref && m && !hits.has(e.ref)) hits.set(e.ref, [...new Set(m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))]);
  }
  // one outcome per discovery: judged before it became a unit (subject = ref) or as a unit (provenance carries the ref)
  const verdicts = all<{ ref: string | null; yes: number }>(`SELECT CASE WHEN j.subject_type = 'expert_unit' THEN json_extract(i.provenance_json, '$.ref') ELSE j.subject_id END AS ref,
      MAX(j.decision = 'yes') AS yes FROM judgments j LEFT JOIN expert_identities i ON i.id = j.subject_id
     WHERE j.judgment = 'discovery_relevance' AND j.decision IN ('yes', 'no', 'uncertain') AND j.created_at >= ? GROUP BY 1`, since);
  const terms = new Map<string, { n: number; yes: number }>(); const baseline = { n: 0, yes: 0 };
  for (const v of verdicts) {
    const matched = v.ref ? hits.get(v.ref) : undefined;
    if (!matched) continue;
    for (const t of matched) { const c = terms.get(t) ?? { n: 0, yes: 0 }; c.n += 1; c.yes += v.yes ? 1 : 0; terms.set(t, c); }
    if (matched.some((t) => SCOUT_STATIC_TERMS.includes(t))) { baseline.n += 1; baseline.yes += v.yes ? 1 : 0; }
  }
  return { terms, baseline };
}

const rate = (c: { n: number; yes: number }) => Math.round((1000 * c.yes) / c.n) / 1000;

export function interestProfile(db: Database, now = Date.now()): {
  terms: string[]; sources: Record<string, number>; yields: TermYield[]; baseline: { yield: number | null; n: number };
  rule: { window_days: number; min_n: number; cap: number; trial_slots: number; trial_max_days: number; cooldown_days: number; gap_trial_slots: number; gap_kill_rule: string };
  cooldown: Cooldown[];
} {
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const relevant = all<{ t: string }>(`SELECT i.canonical_name AS t FROM judgments j JOIN expert_identities i ON i.id = j.subject_id
    WHERE j.judgment = 'discovery_relevance' AND j.decision = 'yes' AND j.created_at >= ?`, since).map((r) => r.t);
  const kb = all<{ reason: string }>("SELECT reason FROM judgments WHERE judgment = 'kb_retrieval' AND created_at >= ?", since)
    .flatMap((r) => (r.reason || '').split(' ').map((hit) => hit.split('@')[0]))
    .map((p) => (all<{ title: string }>('SELECT title FROM kb_pages WHERE path = ?', p)[0]?.title ?? ''));
  const measured = termYields(db, since);
  const base = measured.baseline.n >= MIN_TERM_N ? rate(measured.baseline) : null;
  const pool = interestTerms([...relevant, ...kb], 50).filter((t) => !isGeneric(t) && !SCOUT_STATIC_TERMS.includes(t));
  // trial state: the newest earlier profile (a day's aggregate id sorts by date)
  let prev: { yields?: TermYield[]; cooldown?: Cooldown[] } = {};
  try {
    const row = db.prepare("SELECT payload_json FROM event_outbox WHERE event_type = 'djimitflo.feedback.interests' AND aggregate_id < ? ORDER BY aggregate_id DESC LIMIT 1")
      .get(`interests-${new Date(now).toISOString().slice(0, 10)}`) as { payload_json: string } | undefined;
    if (row) prev = JSON.parse(row.payload_json);
  } catch { /* no history: no trials running */ }
  const nowIso = new Date(now).toISOString();
  const cooldown = new Map((Array.isArray(prev.cooldown) ? prev.cooldown : [])
    .filter((c) => now - Date.parse(c.at) <= COOLDOWN_DAYS * 86_400_000).map((c) => [c.term, c.at] as const));
  const prevYields = Array.isArray(prev.yields) ? prev.yields : [];
  const prevTrials = new Map(prevYields.filter((y) => y.trial && y.since).map((y) => [y.term, y.since!] as const));
  const prevGap = new Map(prevYields.filter((y) => y.trial && y.gap).map((y) => [y.term, y.gap!] as const));
  const passes = (t: string) => { const c = measured.terms.get(t); return base !== null && !!c && c.n >= MIN_TERM_N && rate(c) >= base; };
  const kept: TermYield[] = [...new Set([...pool, ...prevTrials.keys()])].filter(passes)
    .map((term) => { const c = measured.terms.get(term)!; return { term, yield: rate(c), n: c.n }; })
    .sort((a, b) => b.yield! - a.yield! || b.n - a.n || a.term.localeCompare(b.term))
    .slice(0, PROFILE_TERM_CAP);
  const unmeasured = (t: string) => (measured.terms.get(t)?.n ?? 0) < MIN_TERM_N;
  const running: Array<[string, string]> = [];
  for (const [t, since] of prevTrials) {
    if (!unmeasured(t)) { if (!passes(t)) cooldown.set(t, nowIso); } // measured: the yield gate decided
    else if (now - Date.parse(since) > TRIAL_MAX_DAYS * 86_400_000) cooldown.set(t, nowIso); // ran out of time
    else running.push([t, since]);
  }
  const keptTerms = new Set(kept.map((k) => k.term));
  const gaps = gapTerms(db, since);
  const gapSig = new Map([...prevGap, ...gaps.map((g) => [g.term, g.signature] as const)]);
  const fresh = pool.filter((t) => unmeasured(t) && !cooldown.has(t) && !prevTrials.has(t) && !gapSig.has(t)).map((t) => [t, nowIso] as [string, string]);
  const freshGap = gaps.filter((g) => unmeasured(g.term) && !cooldown.has(g.term) && !prevTrials.has(g.term)).map((g) => [g.term, nowIso] as [string, string]);
  const asTrial = ([term, since]: [string, string]): TermYield => {
    const c = measured.terms.get(term); const gap = gapSig.get(term);
    return { term, yield: c?.n ? rate(c) : null, n: c?.n ?? 0, trial: true, since, ...(gap ? { gap } : {}) };
  };
  const ordinary = base === null ? [] : [...running.filter(([t]) => !prevGap.has(t)), ...fresh]
    .slice(0, Math.max(0, Math.min(TRIAL_SLOTS, PROFILE_TERM_CAP - kept.length))).map(asTrial);
  const gapTrials = base === null ? [] : [...running.filter(([t]) => prevGap.has(t)), ...freshGap].filter(([t]) => !keptTerms.has(t))
    .slice(0, Math.max(0, Math.min(GAP_TRIAL_SLOTS, PROFILE_TERM_CAP - kept.length - ordinary.length))).map(asTrial);
  const trials = [...ordinary, ...gapTrials];
  const yields = [...kept, ...trials];
  return {
    terms: yields.map((y) => y.term), sources: { relevant: relevant.length, kb_hits: kb.length }, yields,
    baseline: { yield: base, n: measured.baseline.n },
    rule: { window_days: 30, min_n: MIN_TERM_N, cap: PROFILE_TERM_CAP, trial_slots: TRIAL_SLOTS, trial_max_days: TRIAL_MAX_DAYS, cooldown_days: COOLDOWN_DAYS,
      gap_trial_slots: GAP_TRIAL_SLOTS,
      gap_kill_rule: `a gap term (from a recurring failure signature) is dropped unless its jev-yes rate >= the static-list baseline (0.181 on 2026-10-09) at n >= ${MIN_TERM_N} within ${TRIAL_MAX_DAYS} days` },
    cooldown: [...cooldown].map(([term, at]) => ({ term, at })).sort((a, b) => a.term.localeCompare(b.term)),
  };
}

/** Enqueue today's profile once (the date is the aggregate id). */
export function publishInterestProfile(db: Database, now = Date.now()): boolean {
  const aggregateId = `interests-${new Date(now).toISOString().slice(0, 10)}`;
  if (db.prepare('SELECT 1 FROM event_outbox WHERE aggregate_id = ? LIMIT 1').get(aggregateId)) return false;
  const profile = interestProfile(db, now);
  if (!profile.terms.length && !profile.cooldown.length) return false; // a cool-down must survive a day without terms
  enqueueEvent(db, { type: 'djimitflo.feedback.interests', aggregateId, payload: profile });
  return true;
}

export function startInterestFeedback(db: Database, intervalMs = 6 * 3_600_000): (() => void) | null {
  if (process.env.FEEDBACK_INTERESTS_ENABLED !== 'true') return null;
  const tick = () => { try { publishInterestProfile(db); } catch (e) { console.warn('interest feedback failed:', e instanceof Error ? e.message : String(e)); } };
  tick(); const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
