import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';

/**
 * re-20261105 E10 / C10 (report only): GitHub's merged_by is `djimit` for every merge, so an agent-run merge and a human
 * one look the same. scripts/merge-train.sh and scripts/dependabot-merge.sh write `merged-via: <script> (<actor>) <ts>`
 * into the squash commit; this counts the PR merges on origin/main of the checkout (LOOP_DAEMON_REPOSITORY_PATH) per class:
 * - agent_script: a merged-via trailer whose actor starts with `agent`;
 * - auto_merge: a merged-via trailer of a workflow, or a commit loop-auto-merge or the dependency lane recorded
 *   (loop_runs $.auto_merge.merge_commit_sha, dependency_lane_prs.merge_sha);
 * - human_ui: any other PR merge — a human UI merge, an agent merge outside these scripts, or one from before the trailer.
 * A PR merge = a first-parent commit whose subject ends in `(#N)` or that carries the trailer; a direct push is not counted.
 */
export type MergeClass = 'auto_merge' | 'agent_script' | 'human_ui';
const MERGED_VIA = /^merged-via: (\S+) \(([^)]*)\) \S+\s*$/m;

export function classifyMerge(body: string, autoMerged: boolean): MergeClass {
  const m = MERGED_VIA.exec(body);
  if (m) return /^agent\b/.test(m[2]) ? 'agent_script' : 'auto_merge';
  return autoMerged ? 'auto_merge' : 'human_ui';
}

/** Merges per class in the last `hours` on origin/main; null when no checkout is configured or git cannot read it. */
export function mergeAttribution(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), hours = 24) {
  const repo = env.LOOP_DAEMON_REPOSITORY_PATH;
  if (!repo) return null;
  let log: string;
  try {
    log = execFileSync('git', ['-C', repo, 'log', 'origin/main', '--first-parent', `--since=${new Date(now - hours * 3_600_000).toISOString()}`, '--format=%H%x1f%s%x1f%b%x1e'],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return null; }
  const auto = new Set<string>();
  for (const sql of ["SELECT json_extract(metadata, '$.auto_merge.merge_commit_sha') AS sha FROM loop_runs WHERE json_extract(metadata, '$.auto_merge.merge_commit_sha') IS NOT NULL",
    'SELECT merge_sha AS sha FROM dependency_lane_prs WHERE merge_sha IS NOT NULL']) {
    try { for (const r of db.prepare(sql).all() as Array<{ sha: string }>) auto.add(r.sha); } catch { /* table absent: no records of that path */ }
  }
  const out = { window_hours: hours, auto_merge: 0, agent_script: 0, human_ui: 0, by_script: {} as Record<string, number>,
    note: 'PR merges on origin/main by merged-via trailer / loop-auto-merge record; human_ui = neither (a UI merge, an unattributed script, or older than the trailer)' };
  for (const entry of log.split('\x1e')) {
    const [sha, subject, body = ''] = entry.replace(/^\s+/, '').split('\x1f');
    if (!sha || !subject) continue;
    const via = MERGED_VIA.exec(body);
    if (!via && !/\(#\d+\)$/.test(subject)) continue;
    out[classifyMerge(body, auto.has(sha))]++;
    if (via) out.by_script[via[1]] = (out.by_script[via[1]] ?? 0) + 1;
  }
  return out;
}
