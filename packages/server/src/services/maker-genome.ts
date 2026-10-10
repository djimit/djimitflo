import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { MAKER_TEMPLATE_RULES } from './loop-service';
import type { AceContext } from './ace-001';

/**
 * Y2 (plan Phase Y): a run's strategy genome — the assignment template, the proven examples and the sealed memory rules
 * the maker received. The species (runtime@model) is already on the lease. Outcomes carry `genome:<id>`, so fitness can be
 * compared per genome and the dreaming step (Y3) can mutate one gene at a time.
 */
export interface MakerGenome { id: string; template: string; examples: string[]; rules: string[] }

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const MAKER_TEMPLATE_HASH = sha(MAKER_TEMPLATE_RULES.join('\n')).slice(0, 12);

export function runGenome(db: Database, runId: string): MakerGenome {
  let examples: string[] = []; let ruleIds: string[] = [];
  try {
    const event = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
    const meta = event ? JSON.parse(event.metadata || '{}') as { examples?: unknown; rule_ids?: unknown } : {};
    examples = Array.isArray(meta.examples) ? meta.examples.filter((e): e is string => typeof e === 'string').sort() : [];
    ruleIds = Array.isArray(meta.rule_ids) ? meta.rule_ids.filter((r): r is string => typeof r === 'string').sort() : [];
  } catch { /* no events table: template-only genome */ }
  const rules = ruleIds.map((id) => {
    let hash: string | null = null;
    try { hash = (db.prepare('SELECT content_hash FROM memory_candidates WHERE id = ?').get(id) as { content_hash: string | null } | undefined)?.content_hash ?? null; } catch { /* table absent */ }
    return `${id}:${(hash ?? 'unsealed').slice(0, 12)}`;
  });
  const genome = { template: MAKER_TEMPLATE_HASH, examples, rules };
  return { id: sha(JSON.stringify(genome)).slice(0, 16), ...genome };
}

/**
 * §16 step 9: `skill_outcomes.skill_content_hash` — the identity of what actually shaped a maker run, so skill reuse and
 * per-skill fitness are computable. sha256 (full hex) of the canonical JSON (keys sorted, arrays sorted by runGenome) of
 * { examples, genome_id (the strategy genome on the lease, or null), rules (`<rule id>:<seal>` from the assignment_context
 * event), template_hash (assignment template version) }. Identical inputs → identical hash; any changed or resealed rule,
 * example, template or strategy genome → a new hash.
 */
export function skillContentHash(genome: MakerGenome, strategyGenomeId: string | null): string {
  return sha(JSON.stringify({ examples: [...genome.examples].sort(), genome_id: strategyGenomeId, rules: [...genome.rules].sort(), template_hash: genome.template }));
}

/** ACE-001: the arm recorded on this run's latest assignment_context event (null when the run was not in the experiment). */
export function runAce001(db: Database, runId: string): AceContext | null {
  try {
    const event = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
    const ace = event ? (JSON.parse(event.metadata || '{}') as { ace_001?: AceContext }).ace_001 : undefined;
    return ace && typeof ace.arm === 'string' ? ace : null;
  } catch { return null; }
}
