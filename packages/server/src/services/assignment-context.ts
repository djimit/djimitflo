import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * WS-K: what a maker gets to see besides its finding.
 * K1 (LOOP_SKILL_CARDS_ENABLED) — heritability: accepted, loop-written tests of the same lane that exist in the checkout,
 *    as examples to follow. Prod 2026-09-25: skills/patterns/genomes were all 0; successes were never reused.
 * K2 (LOOP_MEMORY_RULES_ENABLED) — memory that is read: at most 3 distinct engineering rules promoted in the last 14 days,
 *    each read logged in memory_access_log. Older rules are left out on purpose: prod held 38 promoted rules with only 8
 *    distinct texts, several of them stale platform facts ("not a git repository").
 */
export interface AssignmentContext { examples: string[]; rules: Array<{ id: string; text: string }> }

const RULE_MAX_AGE_DAYS = 14;

/** Lane of a goal's proposal: test-gap proposals carry an evidence ref `test-gap:<service>[#exports]`. */
function lane(db: Database, goalId: string | null): 'test-gap' | 'test-gap-exports' | null {
  if (!goalId) return null;
  const refs = (db.prepare('SELECT s.evidence_refs_json AS r FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { r: string } | undefined)?.r ?? '';
  return refs.includes('#exports"') ? 'test-gap-exports' : refs.includes('"test-gap:') ? 'test-gap' : null;
}

export function assignmentContext(db: Database, run: { id: string; goal_id: string | null }, checkoutPath: string, agentId: string, env: NodeJS.ProcessEnv = process.env): AssignmentContext {
  const out: AssignmentContext = { examples: [], rules: [] };
  try {
    if (env.LOOP_SKILL_CARDS_ENABLED === 'true' && lane(db, run.goal_id)) {
      const rows = db.prepare(`SELECT title, json_extract(grounding_json, '$.artifactPath') AS artifact FROM self_improvements
        WHERE status = 'verified' AND evidence_refs_json LIKE '%"test-gap:%' AND grounding_json IS NOT NULL ORDER BY updated_at DESC LIMIT 10`).all() as Array<{ title: string; artifact: string | null }>;
      out.examples = rows.filter((r) => r.artifact && fs.existsSync(path.join(checkoutPath, r.artifact))).slice(0, 2).map((r) => `${r.artifact} — ${r.title}`);
    }
    if (env.LOOP_MEMORY_RULES_ENABLED === 'true') {
      const since = new Date(Date.now() - RULE_MAX_AGE_DAYS * 86_400_000).toISOString();
      const rows = db.prepare(`SELECT id, content FROM memory_candidates WHERE status = 'promoted' AND memory_type = 'engineering_rule' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 20`).all(since) as Array<{ id: string; content: string }>;
      const seen = new Set<string>();
      for (const r of rows) {
        const text = r.content.replace(/\s+/g, ' ').trim();
        if (seen.has(text)) continue;
        seen.add(text); out.rules.push({ id: r.id, text: text.slice(0, 300) });
        if (out.rules.length === 3) break;
      }
      const log = db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)');
      for (const r of out.rules) log.run(randomUUID(), r.id, agentId, new Date().toISOString());
    }
  } catch { /* context is advisory: never block an assignment */ }
  return out;
}

export function assignmentContextMarkdown(ctx: AssignmentContext): string[] {
  return [
    ...(ctx.examples.length ? ['## Proven Examples', '', 'Accepted, loop-written tests from this lane. Follow their structure and style:', '', ...ctx.examples.map((e) => `- ${e}`), ''] : []),
    ...(ctx.rules.length ? ['## Engineering Rules (recent, from reviewed memory)', '', ...ctx.rules.map((r) => `- ${r.text}`), ''] : []),
  ];
}
