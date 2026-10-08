import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { nonMakerRunSql } from './outcome-attribution';

/**
 * WS-K: what a maker gets to see besides its finding.
 * K1 (LOOP_SKILL_CARDS_ENABLED) — heritability: accepted, loop-written tests of the same lane that exist in the checkout,
 *    as examples to follow. Prod 2026-09-25: skills/patterns/genomes were all 0; successes were never reused.
 * K2 (LOOP_MEMORY_RULES_ENABLED) — memory that is read: at most 3 distinct engineering rules promoted in the last 14 days,
 *    each read logged in memory_access_log. Older rules are left out on purpose: prod held 38 promoted rules with only 8
 *    distinct texts, several of them stale platform facts ("not a git repository").
 * M5 — memory under selection: a rule's fitness = runs that read it and verified minus runs that read it and regressed
 *    (reads are logged as `loop-maker:<run id>`). Fit rules (> 0) survive past the 14-day trial and come first; a rule
 *    with fitness <= -2 is never shown again; the last slot always goes to the newest untried rule (exploration).
 *    OUTCOME_ATTRIBUTION_ENABLED: a regression attributed to a reviewer or the environment costs the rule nothing.
 */
export interface AssignmentContext { examples: string[]; rules: Array<{ id: string; text: string; hash: string }>; memory_holdout?: true }

/**
 * Memory holdout (prod: rules were read in 121 of 122 maker runs — no control group, Fisher p = 1.0). MEMORY_HOLDOUT_RATE
 * (default 0 = off, clamped to [0, 1]) withholds the rules from a deterministic fraction of maker runs: the sha256 of the
 * goal id (else the run id) picks the arm, so every run of one goal lands in the same arm. A held-out run gets no rules,
 * logs no read and carries `memory_holdout: true` on its assignment_context event; evolution-evidence compares the arms.
 */
export const memoryHoldoutRate = (env: NodeJS.ProcessEnv = process.env): number => {
  const r = Number(env.MEMORY_HOLDOUT_RATE); return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
};
export function memoryHoldout(key: string, rate: number): boolean {
  return rate > 0 && parseInt(createHash('sha256').update(`memory-holdout:${key}`).digest('hex').slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

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
    if (env.LOOP_MEMORY_RULES_ENABLED === 'true' && memoryHoldout(run.goal_id || run.id, memoryHoldoutRate(env))) out.memory_holdout = true;
    else if (env.LOOP_MEMORY_RULES_ENABLED === 'true') {
      const since = new Date(Date.now() - RULE_MAX_AGE_DAYS * 86_400_000).toISOString();
      const rows = db.prepare(`SELECT m.id, m.content, m.content_hash, m.created_at,
          COALESCE(SUM(CASE s.status WHEN 'verified' THEN 1 WHEN 'regressed' THEN (CASE WHEN ${nonMakerRunSql('r.id', env)} THEN 0 ELSE -1 END) ELSE 0 END), 0) AS fitness, COUNT(a.id) AS reads
        FROM memory_candidates m
        LEFT JOIN memory_access_log a ON a.candidate_id = m.id
        LEFT JOIN loop_runs r ON a.agent_id = 'loop-maker:' || r.id
        LEFT JOIN goals g ON g.id = r.goal_id
        LEFT JOIN self_improvements s ON s.id = g.improvement_id
        WHERE m.status = 'promoted' AND m.memory_type = 'engineering_rule'
        GROUP BY m.id
        HAVING fitness > 0 OR (m.created_at >= ? AND fitness > -2)
        ORDER BY fitness DESC, m.created_at DESC LIMIT 40`).all(since) as Array<{ id: string; content: string; content_hash: string | null; created_at: string; fitness: number; reads: number }>;
      // P1 (artifact trust): a rule is sealed with the sha256 of its content on first use (99 of 99 prod rules had no hash,
      // 28-09) and refused afterwards if the content no longer matches — a changed rule needs a new, reviewed row
      const sealed = rows.filter((r) => ruleIntact(db, r, run.id));
      const seen = new Set<string>();
      const distinct = sealed.filter((r) => { const t = r.content.replace(/\s+/g, ' ').trim(); return seen.has(t) ? false : (seen.add(t), true); });
      const untried = distinct.filter((r) => r.reads === 0).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      const picked = distinct.filter((r) => r !== untried).slice(0, untried ? 2 : 3).concat(untried ? [untried] : []);
      out.rules = picked.map((r) => ({ id: r.id, text: r.content.replace(/\s+/g, ' ').trim().slice(0, 300), hash: sha256(r.content) }));
      const log = db.prepare('INSERT INTO memory_access_log (id, candidate_id, agent_id, accessed_at) VALUES (?, ?, ?, ?)');
      for (const r of out.rules) log.run(randomUUID(), r.id, agentId, new Date().toISOString());
    }
  } catch { /* context is advisory: never block an assignment */ }
  return out;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** P1: seal an unsealed rule (trust on first use); refuse and record a rule whose content no longer matches its seal. */
export function ruleIntact(db: Database, rule: { id: string; content: string; content_hash: string | null }, runId: string): boolean {
  const actual = sha256(rule.content);
  if (!rule.content_hash) {
    db.prepare('UPDATE memory_candidates SET content_hash = ? WHERE id = ? AND content_hash IS NULL').run(actual, rule.id);
    return true;
  }
  if (rule.content_hash === actual) return true;
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES (?, 'artifact_integrity', 'memory_candidate', ?, ?, 'enforce', 'no', ?, ?)`)
      .run(randomUUID(), rule.id, actual.slice(0, 16), `content changed since sealed (sealed ${rule.content_hash.slice(0, 12)}, now ${actual.slice(0, 12)}); refused for run ${runId}`, new Date().toISOString());
  } catch { /* recording must not break an assignment */ }
  return false;
}

export function assignmentContextMarkdown(ctx: AssignmentContext): string[] {
  return [
    ...(ctx.examples.length ? ['## Proven Examples', '', 'Accepted, loop-written tests from this lane. Follow their structure and style:', '', ...ctx.examples.map((e) => `- ${e}`), ''] : []),
    ...(ctx.rules.length ? ['## Engineering Rules (recent, from reviewed memory)', '', ...ctx.rules.map((r) => `- ${r.text} (rule ${r.id.slice(0, 8)}, sha256:${r.hash.slice(0, 12)})`), ''] : []),
  ];
}
