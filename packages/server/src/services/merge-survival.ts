import type { Database } from 'better-sqlite3';
import { SkillEvolutionEngine } from './skill-evolution-engine';

/**
 * EV4 (plan Phase EV, 03-10): the strongest fitness signal is whether a loop change survives in the real repository.
 * Gates and reviewers say "ready"; the human merge and 14 days in main without the files disappearing say "it was worth
 * having". For every loop draft PR (loop_runs.metadata.pr_url) this reads the PR state through the GitHub API (GET only,
 * the token the draft-PR service already uses) and settles it once: closed unmerged → failure; merged and all its files
 * still on main after SURVIVAL_DAYS → success; merged but a file is gone → failure (reverted or removed). The result is a
 * skill outcome for the maker species that wrote the change (domain 'merge'), so selection can use it.
 * MERGE_SURVIVAL_ENABLED=true (default off).
 */
export const SURVIVAL_DAYS = 14;
export const mergeSurvivalEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.MERGE_SURVIVAL_ENABLED === 'true';

interface PrOutcome { state: 'open' | 'merged' | 'closed_unmerged'; merged_at?: string | null; survived?: boolean; settled_at?: string; checked_at: string }

export async function checkLoopPrs(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ checked: number; settled: number }> {
  const repo = env.GITHUB_REPOSITORY; const token = env.GITHUB_TOKEN;
  if (!repo || !token) return { checked: 0, settled: 0 };
  const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const runs = db.prepare(`SELECT id, json_extract(metadata, '$.pr_url') AS url, json_extract(metadata, '$.pr_outcome') AS outcome FROM loop_runs
    WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.settled_at') IS NULL AND created_at >= ?`).all(since) as Array<{ id: string; url: string; outcome: string | null }>;
  const get = async (p: string) => fetchImpl(`https://api.github.com/repos/${repo}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  const engine = new SkillEvolutionEngine(db);
  let checked = 0; let settled = 0;
  for (const run of runs) {
    const number = /\/pull\/(\d+)$/.exec(run.url)?.[1];
    if (!number) continue;
    const res = await get(`pulls/${number}`);
    if (!res.ok) continue; // rate limit or outage: try again next tick
    const pr = await res.json() as { state?: string; merged_at?: string | null };
    checked++;
    const outcome: PrOutcome = { state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed_unmerged' : 'open', merged_at: pr.merged_at ?? null, checked_at: now.toISOString() };
    let success: boolean | null = null;
    if (outcome.state === 'closed_unmerged') success = false;
    if (outcome.state === 'merged' && now.getTime() - Date.parse(String(pr.merged_at)) >= SURVIVAL_DAYS * 86_400_000) {
      const files = loopPrFiles(db, run.id);
      if (!files.length) continue;
      let verdict: 'present' | 'gone' | 'unknown' = 'present';
      for (const f of files) {
        const c = await get(`contents/${f.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(env.LOOP_DRAFT_PR_BASE || 'main')}`);
        if (c.status === 404) { verdict = 'gone'; break; }
        if (!c.ok) { verdict = 'unknown'; break; } // outage: retry next tick
      }
      if (verdict !== 'unknown') { outcome.survived = verdict === 'present'; success = outcome.survived; }
    }
    if (success !== null) {
      outcome.settled_at = now.toISOString();
      const maker = db.prepare(`SELECT runtime, json_extract(metadata, '$.model') AS model FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'
        AND json_extract(metadata, '$.superseded_by_maker_lease_id') IS NULL ORDER BY updated_at DESC LIMIT 1`).get(run.id) as { runtime: string; model: string | null } | undefined;
      engine.recordOutcome(`loop-maker:merge:${maker?.runtime ?? 'unknown'}`, {
        success, tokensUsed: 0, durationMs: 0, domain: 'merge', taskId: run.id, ...(maker?.model ? { model: maker.model } : {}),
        evidenceRefs: [`pr:${run.url}`, `loop_run:${run.id}`, `pr_outcome:${outcome.state}${outcome.survived === undefined ? '' : outcome.survived ? ':survived' : ':removed'}`],
      });
      settled++;
    }
    db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_outcome', json(?)) WHERE id = ?").run(JSON.stringify(outcome), run.id);
  }
  return { checked, settled };
}

/** The files the draft PR carried (recorded on its draft_pr_opened event). */
function loopPrFiles(db: Database, runId: string): string[] {
  const row = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'draft_pr_opened' ORDER BY created_at DESC LIMIT 1").get(runId) as { metadata: string | null } | undefined;
  const files = (JSON.parse(row?.metadata || '{}') as { files?: unknown }).files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && !f.includes('..')) : [];
}

/** Every 6 h (first run 5 min after boot). */
export function startMergeSurvival(db: Database, intervalMs = 6 * 3_600_000): (() => void) | null {
  if (!mergeSurvivalEnabled()) return null;
  const tick = () => { checkLoopPrs(db).then((r) => { if (r.settled) console.log(`🧾 merge survival: ${r.settled} loop PR(s) settled of ${r.checked} checked`); })
    .catch((e) => console.warn('merge survival failed:', e instanceof Error ? e.message : String(e))); };
  const first = setTimeout(tick, 300_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
