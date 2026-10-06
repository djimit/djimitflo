import type { Database } from 'better-sqlite3';
import { SkillEvolutionEngine } from './skill-evolution-engine';

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
  version?: 2; not_scored?: 'deletion_only' | 'docs_only' | 'stale_loop' | 'unknown_content'; unknown_files?: number;
}
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

export async function checkLoopPrs(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ checked: number; settled: number }> {
  const repo = env.GITHUB_REPOSITORY; const token = env.GITHUB_TOKEN;
  if (!repo || !token) return { checked: 0, settled: 0 };
  const v2 = mergeSurvivalV2(env);
  // ponytail: v2 still bounds the scan (365 d) so a forgotten run cannot be polled forever
  const since = new Date(now.getTime() - (v2 ? 365 : 60) * 86_400_000).toISOString();
  const runs = db.prepare(`SELECT id, json_extract(metadata, '$.pr_url') AS url, json_extract(metadata, '$.pr_close_reason') AS close_reason FROM loop_runs
    WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.settled_at') IS NULL AND created_at >= ?`).all(since) as Array<{ id: string; url: string; close_reason: string | null }>;
  const get = async (p: string) => fetchImpl(`https://api.github.com/repos/${repo}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  /** v2: every page of a list endpoint (per_page=100, ≤ 30 pages); null when a page fails (try again next tick). */
  const getAll = async <T>(p: string): Promise<T[] | null> => {
    const all: T[] = [];
    for (let page = 1; page <= 30; page++) {
      const res = await get(`${p}?per_page=100&page=${page}`);
      if (!res.ok) return null;
      const batch = await res.json() as T[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  const engine = new SkillEvolutionEngine(db);
  let checked = 0; let settled = 0;
  for (const run of runs) {
    const number = /\/pull\/(\d+)$/.exec(run.url)?.[1];
    if (!number) continue;
    const res = await get(`pulls/${number}`);
    if (!res.ok) continue; // rate limit or outage: try again next tick
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
      if (v2 && run.close_reason === 'stale_loop') outcome.not_scored = 'stale_loop'; else success = false;
    }
    if (outcome.state === 'merged' && now.getTime() - Date.parse(String(pr.merged_at)) >= SURVIVAL_DAYS * 86_400_000) {
      // graded signal: commits a human added before merging (edits by the reviewer = the draft was not good enough as is)
      type Commit = { commit?: { author?: { name?: string } } }; type PrFile = { filename: string; patch?: string };
      const commitList = v2 ? await getAll<Commit>(`pulls/${number}/commits`) : await get(`pulls/${number}/commits`).then(async (r) => (r.ok ? await r.json() as Commit[] : null));
      if (commitList) outcome.human_commits = commitList.filter((c) => c.commit?.author?.name !== 'djimitflo-loop').length;
      const fileList = v2 ? await getAll<PrFile>(`pulls/${number}/files`) : await get(`pulls/${number}/files`).then(async (r) => (r.ok ? await r.json() as PrFile[] : null));
      const added = fileList ? (v2 ? addedLinesV2(fileList) : addedLines(fileList)) : null;
      if (added && v2 && added.size === 0) outcome.not_scored = 'deletion_only';
      else if (added && v2 && [...added.keys()].every((f) => DOC.test(f))) outcome.not_scored = 'docs_only';
      else if (added) {
        // D1: survival = the added lines are still on main, not merely the file (a rewritten file used to count as survived)
        let total = 0; let kept = 0; let unknown = false; let unknownFiles = 0;
        for (const [file, lines] of added) {
          total += lines.length;
          const c = await get(`contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(env.LOOP_DRAFT_PR_BASE || 'main')}`);
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
      engine.recordOutcome(`loop-maker:merge:${maker?.runtime ?? 'unknown'}`, {
        success, tokensUsed: 0, durationMs: 0, domain: 'merge', taskId: run.id, ...(maker?.model ? { model: maker.model } : {}),
        evidenceRefs: [`pr:${run.url}`, `loop_run:${run.id}`, `pr_outcome:${outcome.state}${outcome.survived === undefined ? '' : outcome.survived ? ':survived' : ':removed'}`,
          ...(outcome.retained !== undefined ? [`retained:${outcome.retained}`] : []), ...(outcome.human_commits !== undefined ? [`human_commits:${outcome.human_commits}`] : []),
          ...(maker?.prompt_hash ? [`prompt:${maker.prompt_hash}`] : []), ...(maker?.genome_id ? [`genome:${maker.genome_id}`] : []), ...(v2 ? ['msv:2'] : [])],
      });
      settled++;
    }
    db.prepare("UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.pr_outcome', json(?)) WHERE id = ?").run(JSON.stringify(outcome), run.id);
  }
  return { checked, settled };
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
