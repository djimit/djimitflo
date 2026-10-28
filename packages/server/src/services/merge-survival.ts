import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LOOP_PR_SETTLEMENT_STATES, type LoopPrSettlementState } from '@djimitflo/shared';
import { SkillEvolutionEngine } from './skill-evolution-engine';
import { markRun } from './scheduler-registry';
import { extraRepoBySlug, isExtraRepoPr, parsePrUrl, repoSkillPrefix } from './repo-registry';
import { supersedingProposal } from './merge-superseded';

/**
 * EV4 (plan Phase EV, 03-10): the strongest fitness signal is whether a loop change survives in the real repository.
 * Gates and reviewers say "ready"; the human merge and 14 days in main without the files disappearing say "it was worth
 * having". For every loop draft PR (loop_runs.metadata.pr_url) this reads the PR state through the GitHub API (GET only,
 * the token the draft-PR service already uses) and settles it once: closed unmerged → failure; merged and (D1) at least
 * MERGE_SURVIVAL_MIN_RETAINED of its added lines still on main after SURVIVAL_DAYS → success, else failure (reverted,
 * rewritten or removed — a file that merely still exists no longer counts). Graded signals ride along: review latency, human
 * commits on the PR, attribution (maker lease, runtime, model, prompt hash, genome). The result is a skill outcome for the
 * maker species that wrote the change (domain 'merge'); the D0 fitness view reads it. Not here: "tests still pass at +14 d"
 * needs a test runner (gym, D3).
 * MERGE_SURVIVAL_ENABLED=true (default off).
 */
export const SURVIVAL_DAYS = 14;
export const mergeSurvivalEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.MERGE_SURVIVAL_ENABLED === 'true';
/**
 * RX-10 (Phase F): measurement v2 behind MERGE_SURVIVAL_V2 (default off; v1 unchanged). Fixes the v1 gaps: files and
 * commits are paginated (v1 saw the first 30); the window follows the PR, not the run (a PR merged > 46 d after its run never
 * settled); a file without inline content (> 1 MB, encoding 'none') is unknown, not "0 kept"; deletion-only and docs-only PRs
 * are reported as not_scored instead of failing; a '++'-prefixed added line is content; a stale_loop closure (queue hygiene,
 * RX-6) is not a quality verdict. v2 outcomes carry the evidence ref 'msv:2' so the series stay separable.
 */
export const mergeSurvivalV2 = (env: NodeJS.ProcessEnv = process.env): boolean => env.MERGE_SURVIVAL_V2 === 'true';
const DOC = /(^|\/)docs?\/|\.(md|mdx|txt|rst|adoc)$/i;

interface PrOutcome {
  state: 'open' | 'merged' | 'closed_unmerged'; merged_at?: string | null; survived?: boolean; retained?: number; settled_at?: string; checked_at: string;
  review_latency_h?: number; human_commits?: number; attribution?: Record<string, unknown>;
  version?: 2; not_scored?: 'deletion_only' | 'docs_only' | 'stale_loop' | 'unknown_content' | 'superseded_by_requeue'; unknown_files?: number;
  /** not_scored superseded_by_requeue: the requeue successor (self_improvements.id) that replaced this PR (merge-superseded.ts) */
  superseded_by?: string;
}
/** The poller's interval (startMergeSurvival) and the slack after which a missing poll result is an anomaly, not a wait. */
export const POLL_INTERVAL_MS = 6 * 3_600_000;
export const POLL_SLACK_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * E1: the evolutionary settlement state of one loop PR — distinct from its GitHub state (open / merged / closed), which
 * pr_outcome.state records on every poll. Exactly one state per PR; the age is a separate field (days since `since`, the
 * state's authoritative timestamp) and is never encoded in the state.
 *
 *  OPEN_BLOCKED            not merged: open on GitHub (since = run created_at), or never polled yet within one poll interval
 *                          + slack (reason not_polled_yet), or closed unmerged — a TERMINAL OPEN_BLOCKED (reason
 *                          closed_unmerged, terminal true, since = settled_at): it never entered the survival window, so it
 *                          is neither survived nor regressed and no survival rate counts it. Its fitness verdict (merge
 *                          skill outcome, success false) is unchanged — unless the close was superseded by a requeue
 *                          (not_scored superseded_by_requeue, merge-superseded.ts): then there is no verdict at all.
 *  MERGED_SURVIVAL_PENDING merged, survival not checked yet: now − merged_at < 14 d, or ≥ 14 d but the check is at most one
 *                          poll interval + slack overdue (since = merged_at).
 *  SETTLED_SURVIVED        merged, settled_at ≥ merged_at + 14 d, survived true (since = settled_at).
 *  SETTLED_REGRESSED       merged, settled_at ≥ merged_at + 14 d, survived false (since = settled_at).
 *  PIPELINE_ANOMALY        evidence that does not fit (reason names it): merged without a parseable merged_at, settled_at
 *                          or survived on an unmerged PR, settled before the window ended, never polled past one interval +
 *                          slack, survival check overdue, unknown GitHub state, a closed PR without settlement, and merged
 *                          PRs settled without a survival verdict (v2 not_scored: …) — those carry no verdict either way.
 *
 * 14-day boundary (merged_at authoritative): the window is complete AT exactly 14 d (the poller checks at ≥ 14 d), so a
 * settlement at merged_at + 14 d is valid; before that the PR is pending. Only SETTLED_SURVIVED / SETTLED_REGRESSED enter a
 * survival rate (numerator and denominator); MERGED_SURVIVAL_PENDING and PIPELINE_ANOMALY never do.
 */
export const SETTLEMENT_STATES = LOOP_PR_SETTLEMENT_STATES;
export type SettlementState = LoopPrSettlementState;
export interface Settlement { state: SettlementState; reason: string; terminal: boolean; since: string | null; age_days: number | null }
export type SettlementOutcome = Partial<Pick<PrOutcome, 'merged_at' | 'survived' | 'settled_at' | 'checked_at' | 'not_scored'>> & { state?: string | null };

export function settlementState(createdAt: string | null, outcome: SettlementOutcome | null | undefined, now: number): Settlement {
  const t = (s: unknown) => (typeof s === 'string' && s ? Date.parse(s) : NaN);
  const at = (state: SettlementState, reason: string, since: string | null | undefined, terminal = false): Settlement => {
    const ms = t(since);
    return { state, reason, terminal, since: Number.isFinite(ms) ? String(since) : null, age_days: Number.isFinite(ms) ? +((now - ms) / DAY_MS).toFixed(2) : null };
  };
  const anomaly = (reason: string) => at('PIPELINE_ANOMALY', reason, outcome?.checked_at ?? createdAt);
  if (outcome && !outcome.state) return anomaly('outcome_without_state');
  if (!outcome) {
    const created = t(createdAt);
    if (!Number.isFinite(created)) return anomaly('never_polled:no_created_at');
    return now - created > POLL_INTERVAL_MS + POLL_SLACK_MS ? anomaly('never_polled') : at('OPEN_BLOCKED', 'not_polled_yet', createdAt);
  }
  const survivedSet = typeof outcome.survived === 'boolean';
  if (outcome.state === 'open') {
    if (outcome.merged_at) return anomaly('open_with_merged_at');
    if (outcome.settled_at || survivedSet) return anomaly('settled_while_unmerged');
    return at('OPEN_BLOCKED', 'open', createdAt);
  }
  if (outcome.state === 'closed_unmerged') {
    if (outcome.merged_at) return anomaly('closed_unmerged_with_merged_at');
    if (survivedSet) return anomaly('settled_while_unmerged');
    if (!Number.isFinite(t(outcome.settled_at))) return anomaly('closed_without_settlement');
    return at('OPEN_BLOCKED', 'closed_unmerged', outcome.settled_at, true);
  }
  if (outcome.state !== 'merged') return anomaly(`unknown_state:${String(outcome.state).slice(0, 40)}`);
  const merged = t(outcome.merged_at);
  if (!Number.isFinite(merged)) return anomaly('merged_without_merged_at');
  if (merged > now + 60_000) return anomaly('merged_at_in_future');
  const windowEnd = merged + SURVIVAL_DAYS * DAY_MS;
  if (outcome.settled_at) {
    const settled = t(outcome.settled_at);
    if (!Number.isFinite(settled)) return anomaly('unparseable_settled_at');
    if (settled < windowEnd) return anomaly('settled_before_window');
    if (survivedSet && outcome.not_scored) return anomaly('verdict_and_not_scored');
    if (survivedSet) return at(outcome.survived ? 'SETTLED_SURVIVED' : 'SETTLED_REGRESSED', outcome.survived ? 'survived' : 'removed', outcome.settled_at);
    return anomaly(outcome.not_scored ? `not_scored:${outcome.not_scored}` : 'settled_without_verdict');
  }
  if (survivedSet) return anomaly('survived_without_settled_at');
  if (now - windowEnd > POLL_INTERVAL_MS + POLL_SLACK_MS) return anomaly('survival_check_overdue');
  return at('MERGED_SURVIVAL_PENDING', now < windowEnd ? 'within_14d_window' : 'awaiting_survival_check', outcome.merged_at);
}

/** Survival over settled states only: SETTLED_SURVIVED / (SETTLED_SURVIVED + SETTLED_REGRESSED); pending and anomalies are in neither. */
export function survivalCounts(states: Iterable<SettlementState>): { survived: number; regressed: number; settled: number; rate: number | null } {
  let survived = 0; let regressed = 0;
  for (const s of states) { if (s === 'SETTLED_SURVIVED') survived++; else if (s === 'SETTLED_REGRESSED') regressed++; }
  const settled = survived + regressed;
  return { survived, regressed, settled, rate: settled ? +(survived / settled).toFixed(3) : null };
}

export interface LoopPrSettlement { run_id: string; created_at: string; pr_url: string; repo: string | null; outcome: SettlementOutcome | null; settlement: Settlement }
/**
 * Every loop PR (loop_runs.metadata.pr_url) with its derived settlement; throws when the table cannot be read.
 * Repo dimension: `repo` = the owner/repo of the PR URL. The default view (repo omitted) leaves out PRs of registered extra
 * repos (EXTRA_REPOS_ENABLED), so primary-repo survival numbers never mix with another repo; `repo` selects one slug.
 */
export function loopPrSettlements(db: Database, now = Date.now(), repo?: string, env: NodeJS.ProcessEnv = process.env): LoopPrSettlement[] {
  const rows = db.prepare(`SELECT id, created_at, json_extract(metadata, '$.pr_url') AS url, json_extract(metadata, '$.pr_outcome') AS o FROM loop_runs
    WHERE json_extract(metadata, '$.pr_url') IS NOT NULL`).all() as Array<{ id: string; created_at: string; url: string; o: string | null }>;
  return rows
    .filter((r) => (repo ? parsePrUrl(r.url)?.slug.toLowerCase() === repo.toLowerCase() : !isExtraRepoPr(r.url, env)))
    .map((r) => {
      const outcome = parseOutcome(r.o);
      return { run_id: r.id, created_at: r.created_at, pr_url: r.url, repo: parsePrUrl(r.url)?.slug ?? null, outcome, settlement: settlementState(r.created_at, outcome, now) };
    });
}

/** pr_outcome JSON text (json_extract of metadata) → object; unparseable text becomes an unknown state (→ PIPELINE_ANOMALY). */
export function parseOutcome(text: string | null | undefined): SettlementOutcome | null {
  if (!text) return null;
  try { const v = JSON.parse(text) as unknown; return v && typeof v === 'object' ? v as SettlementOutcome : { state: 'unparseable' }; } catch { return { state: 'unparseable' }; }
}

export const emptySettlementCounts = (): Record<SettlementState, number> => Object.fromEntries(SETTLEMENT_STATES.map((s) => [s, 0])) as Record<SettlementState, number>;

/** D1: share of the PR's added lines that must still be on main after SURVIVAL_DAYS (MERGE_SURVIVAL_MIN_RETAINED, default 0.5). */
export const minRetained = (env: NodeJS.ProcessEnv = process.env): number => {
  const v = Number(env.MERGE_SURVIVAL_MIN_RETAINED); return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
};

/** Lines a PR added (from its unified diffs), trimmed, without blanks and bare braces — the content that has to survive. */
export function addedLines(patches: Array<{ filename: string; patch?: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of patches) {
    const lines = (f.patch ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length > 3);
    if (lines.length) out.set(f.filename, lines);
  }
  return out;
}

/** v2: like addedLines, but only diff headers ('+++ a/…', '+++ b/…', '+++ /dev/null') are dropped — '++x;' is a real added line. */
export function addedLinesV2(patches: Array<{ filename: string; patch?: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of patches) {
    const lines = (f.patch ?? '').split('\n').filter((l) => l.startsWith('+') && !/^\+\+\+ (a\/|b\/|\/dev\/null)/.test(l)).map((l) => l.slice(1).trim()).filter((l) => l.length > 3);
    if (lines.length) out.set(f.filename, lines);
  }
  return out;
}

/**
 * E1: the counts of one poll cycle, persisted as a `merge_survival_poll` judgments row (answers_json) — observe only.
 * considered = unsettled loop PRs (any age); selected = those inside the scan window; skipped = selected but not updated
 * (no PR number, or the PR read failed); updated = pr_outcome written; anomalous = updated rows whose derived settlement is
 * PIPELINE_ANOMALY (by reason); api_failures = non-OK GitHub responses by HTTP status (a contents 404 is "file gone", not a
 * failure) plus `threw` when a call threw (the cycle then aborts as before).
 */
export interface PollCycle { cycle_id: string; at: string; version: 1 | 2; disabled?: string; considered: number | null; selected: number; skipped: number; updated: number;
  settled: number; anomalous: number; anomalies: Record<string, number>; api_failures: Record<string, number> }

function recordPollCycle(db: Database, c: PollCycle): void {
  try {
    const failures = Object.values(c.api_failures).reduce((a, n) => a + n, 0);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'merge_survival_poll', 'poll_cycle', ?, ?, 'observe', ?, ?, ?, ?)`)
      .run(randomUUID(), c.cycle_id, `msv:${c.version}`, c.api_failures.threw ? 'error' : 'recorded',
        c.disabled ?? `considered ${c.considered ?? 'unknown'}, selected ${c.selected}, skipped ${c.skipped}, updated ${c.updated}, settled ${c.settled}, anomalous ${c.anomalous}, api failures ${failures}`,
        JSON.stringify(c), c.at);
  } catch { /* judgments table absent: the poll itself is unaffected */ }
}

export async function checkLoopPrs(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ checked: number; settled: number }> {
  const repo = env.GITHUB_REPOSITORY; const token = env.GITHUB_TOKEN;
  const v2 = mergeSurvivalV2(env);
  const cycle: PollCycle = { cycle_id: randomUUID(), at: now.toISOString(), version: v2 ? 2 : 1, considered: null, selected: 0, skipped: 0, updated: 0, settled: 0, anomalous: 0, anomalies: {}, api_failures: {} };
  if (!repo || !token) { recordPollCycle(db, { ...cycle, disabled: 'GITHUB_REPOSITORY/GITHUB_TOKEN missing' }); return { checked: 0, settled: 0 }; }
  try { cycle.considered = (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL
    AND json_extract(metadata, '$.pr_outcome.settled_at') IS NULL`).get() as { n: number }).n; } catch { /* unknown, stays null */ }
  // ponytail: v2 still bounds the scan (365 d) so a forgotten run cannot be polled forever
  const since = new Date(now.getTime() - (v2 ? 365 : 60) * 86_400_000).toISOString();
  const runs = db.prepare(`SELECT id, created_at, json_extract(metadata, '$.pr_url') AS url, json_extract(metadata, '$.pr_close_reason') AS close_reason FROM loop_runs
    WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.settled_at') IS NULL AND created_at >= ?`).all(since) as Array<{ id: string; created_at: string; url: string; close_reason: string | null }>;
  const fail = (key: string) => { cycle.api_failures[key] = (cycle.api_failures[key] ?? 0) + 1; };
  // B3 (17-10): a PR is identified by owner/repo + number from its full URL, never by the number alone (a number in another
  // repo used to be settled with the primary repo's PR of the same number).
  const get = async (slug: string, p: string, gone404 = false) => {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok && !(gone404 && res.status === 404)) fail(String(res.status));
    return res;
  };
  cycle.selected = runs.length;
  /** v2: every page of a list endpoint (per_page=100, ≤ 30 pages); null when a page fails (try again next tick). */
  const getAll = async <T>(slug: string, p: string): Promise<T[] | null> => {
    const all: T[] = [];
    for (let page = 1; page <= 30; page++) {
      const res = await get(slug, `${p}?per_page=100&page=${page}`);
      if (!res.ok) return null;
      const batch = await res.json() as T[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  const engine = new SkillEvolutionEngine(db);
  let checked = 0; let settled = 0;
  try {
  for (const run of runs) {
    const ref = parsePrUrl(run.url);
    // only the primary repo or a registered extra repo; anything else is never polled (and never settled)
    const extra = ref ? extraRepoBySlug(ref.slug, env) : null;
    if (!ref || (ref.slug.toLowerCase() !== repo.toLowerCase() && !extra)) { cycle.skipped++; continue; }
    const { slug, number } = ref;
    const res = await get(slug, `pulls/${number}`);
    if (!res.ok) { cycle.skipped++; continue; } // rate limit or outage: try again next tick
    const pr = await res.json() as { state?: string; merged_at?: string | null; created_at?: string };
    checked++;
    const maker = db.prepare(`SELECT id, runtime, json_extract(metadata, '$.model') AS model, json_extract(metadata, '$.model_id') AS model_id,
      json_extract(metadata, '$.prompt_hash') AS prompt_hash, json_extract(metadata, '$.genome_id') AS genome_id FROM worker_leases
      WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed' AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL
      ORDER BY updated_at DESC LIMIT 1`).get(run.id) as { id: string; runtime: string; model: string | null; model_id: string | null; prompt_hash: string | null; genome_id: string | null } | undefined;
    const outcome: PrOutcome = { state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed_unmerged' : 'open', merged_at: pr.merged_at ?? null, checked_at: now.toISOString(),
      attribution: maker ? { maker_lease: maker.id, runtime: maker.runtime, model: maker.model, model_id: maker.model_id, prompt_hash: maker.prompt_hash, genome_id: maker.genome_id } : undefined };
    if (pr.merged_at && pr.created_at) outcome.review_latency_h = +((Date.parse(pr.merged_at) - Date.parse(pr.created_at)) / 3_600_000).toFixed(1);
    if (v2) outcome.version = 2;
    let success: boolean | null = null;
    if (outcome.state === 'closed_unmerged') {
      // 19-10: a close superseded by a verified / PR-opening requeue copy is bookkeeping, not a rejection (v1 and v2)
      const successor = v2 && run.close_reason === 'stale_loop' ? null : supersedingProposal(db, run.id);
      if (v2 && run.close_reason === 'stale_loop') outcome.not_scored = 'stale_loop';
      else if (successor) { outcome.not_scored = 'superseded_by_requeue'; outcome.superseded_by = successor; } else success = false;
    }
    if (outcome.state === 'merged' && now.getTime() - Date.parse(String(pr.merged_at)) >= SURVIVAL_DAYS * 86_400_000) {
      // graded signal: commits a human added before merging (edits by the reviewer = the draft was not good enough as is)
      type Commit = { commit?: { author?: { name?: string } } }; type PrFile = { filename: string; patch?: string };
      const commitList = v2 ? await getAll<Commit>(slug, `pulls/${number}/commits`) : await get(slug, `pulls/${number}/commits`).then(async (r) => (r.ok ? await r.json() as Commit[] : null));
      if (commitList) outcome.human_commits = commitList.filter((c) => c.commit?.author?.name !== 'djimitflo-loop').length;
      const fileList = v2 ? await getAll<PrFile>(slug, `pulls/${number}/files`) : await get(slug, `pulls/${number}/files`).then(async (r) => (r.ok ? await r.json() as PrFile[] : null));
      const added = fileList ? (v2 ? addedLinesV2(fileList) : addedLines(fileList)) : null;
      if (added && v2 && added.size === 0) outcome.not_scored = 'deletion_only';
      else if (added && v2 && [...added.keys()].every((f) => DOC.test(f))) outcome.not_scored = 'docs_only';
      else if (added) {
        // D1: survival = the added lines are still on main, not merely the file (a rewritten file used to count as survived)
        let total = 0; let kept = 0; let unknown = false; let unknownFiles = 0;
        for (const [file, lines] of added) {
          total += lines.length;
          const c = await get(slug, `contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(env.LOOP_DRAFT_PR_BASE || 'main')}`, true);
          if (c.status === 404) continue; // file gone: none kept
          if (!c.ok) { unknown = true; break; }
          const body = await c.json() as { content?: string; encoding?: string };
          // v2: no inline content (> 1 MB → encoding 'none') says nothing about survival — leave the file out
          if (v2 && (body.encoding === 'none' || !body.content)) { total -= lines.length; unknownFiles++; continue; }
          const onMain = new Set(Buffer.from(body.content ?? '', body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8').split('\n').map((l) => l.trim()));
          kept += lines.filter((l) => onMain.has(l)).length;
        }
        if (v2 && unknownFiles) outcome.unknown_files = unknownFiles;
        if (!unknown && total > 0) { outcome.retained = +(kept / total).toFixed(3); outcome.survived = outcome.retained >= minRetained(env); success = outcome.survived; }
        else if (v2 && !unknown && total === 0 && unknownFiles) outcome.not_scored = 'unknown_content';
      }
    }
    if (success === null && outcome.not_scored) { outcome.settled_at = now.toISOString(); settled++; } // settled, but no fitness verdict
    if (success !== null) {
      outcome.settled_at = now.toISOString();
      // §16 step 9: the merged change was shaped by the same genome as the run's maker outcome — inherit its skill content hash
      const shaped = db.prepare("SELECT skill_content_hash AS h FROM skill_outcomes WHERE task_id = ? AND domain != 'merge' AND skill_content_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(run.id) as { h: string } | undefined;
      engine.recordOutcome(`${repoSkillPrefix(extra)}loop-maker:merge:${maker?.runtime ?? 'unknown'}`, {
        success, tokensUsed: 0, durationMs: 0, domain: 'merge', taskId: run.id, ...(maker?.model ? { model: maker.model } : {}), ...(shaped ? { skillContentHash: shaped.h } : {}),
        evidenceRefs: [`pr:${run.url}`, `loop_run:${run.id}`, `pr_outcome:${outcome.state}${outcome.survived === undefined ? '' : outcome.survived ? ':survived' : ':removed'}`,
          ...(outcome.retained !== undefined ? [`retained:${outcome.retained}`] : []), ...(outcome.human_commits !== undefined ? [`human_commits:${outcome.human_commits}`] : []),
          ...(maker?.prompt_hash ? [`prompt:${maker.prompt_hash}`] : []), ...(maker?.genome_id ? [`genome:${maker.genome_id}`] : []), ...(v2 ? ['msv:2'] : [])],
      });
      settled++;
    }
    db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_outcome', json(?)) WHERE id = ?").run(JSON.stringify(outcome), run.id);
    cycle.updated++;
    const s = settlementState(run.created_at, outcome, now.getTime());
    if (s.state === 'PIPELINE_ANOMALY') { cycle.anomalous++; cycle.anomalies[s.reason] = (cycle.anomalies[s.reason] ?? 0) + 1; }
  }
  } catch (e) { fail('threw'); throw e; } finally { cycle.settled = settled; recordPollCycle(db, cycle); }
  return { checked, settled };
}

/** Every 6 h (first run 5 min after boot). */
export function startMergeSurvival(db: Database, intervalMs = POLL_INTERVAL_MS): (() => void) | null {
  if (!mergeSurvivalEnabled()) return null;
  const tick = () => { markRun('merge_survival'); checkLoopPrs(db).then((r) => { if (r.settled) console.log(`🧾 merge survival: ${r.settled} loop PR(s) settled of ${r.checked} checked`); })
    .catch((e) => console.warn('merge survival failed:', e instanceof Error ? e.message : String(e))); };
  const first = setTimeout(tick, 300_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
