import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildSourcePack, dreamKnowledgeSeedMode, sourcePrompt } from '../services/dream-evidence-sources';
import { knowledgeFitness } from '../services/knowledge-fitness';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

let db: Database.Database;
const NOW = Date.parse('2026-11-20T00:00:00Z'); const T = '2026-11-19T00:00:00Z';
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());
const expert = (id: string, state: string, kind = 'paper') => db.prepare(`INSERT INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, created_at, updated_at, kind)
  VALUES (?, ?, '[]', ?, 0.6, '{}', 1, ?, ?, ?)`).run(id, `Title of ${id}`, state, T, T, kind);

it('DREAM_KNOWLEDGE_SEED_MODE: off adds nothing, shadow records the ids, on puts operator-checked units in the pack as untested', () => {
  expect(dreamKnowledgeSeedMode({})).toBe('off');
  expect(dreamKnowledgeSeedMode({ DREAM_KNOWLEDGE_SEED_MODE: 'yes' })).toBe('off');
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'DREAM_KNOWLEDGE_SEED_MODE', acting: true });
  expert('expert:checked', 'CHECKED'); expert('expert:inferred', 'CAPABILITY_INFERRED'); expert('area:x', 'CHECKED', 'area');
  const pack = (mode?: string) => buildSourcePack(db, ['knowledge'], [], NOW, mode ? { DREAM_KNOWLEDGE_SEED_MODE: mode } : {});
  expect(pack()).toEqual({ sources: ['knowledge'], items: [] });
  expect(pack('shadow')).toEqual({ sources: ['knowledge'], items: [], shadow_seed: ['expert:checked'] });
  const on = pack('on');
  expect(on.items).toEqual([{ id: 'expert_unit:expert:checked', source: 'knowledge', ref: 'expert:checked', text: 'untested, operator-checked: Title of expert:checked' }]);
  expect(on.shadow_seed).toBeUndefined();
  expect(sourcePrompt(on).join('\n')).toContain('[expert_unit:expert:checked] untested, operator-checked');
  // the knowledge source must be enabled: the seed never widens another source
  expect(buildSourcePack(db, ['skills'], [], NOW, { DREAM_KNOWLEDGE_SEED_MODE: 'on' }).items).toEqual([]);
});

it('K1 credits a KB page that ACE-001 put into a maker assignment (assignment_context.ace_001.kb_paths)', () => {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r1', 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(T, T);
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'outcome_attribution', 'loop_run', 'r1', '', 'annotation', 'verified', 'r', ?)`).run(T);
  const kb = () => knowledgeFitness(db, NOW).by_kind.find((k) => k.kind === 'kb_page')!;
  expect(kb().insufficient).toBe(0);
  db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES ('e1', 'r1', 'assignment_context', 'info', 'm', ?, ?)`)
    .run(JSON.stringify({ ace_001: { arm: '10', kb_paths: ['ops/repair.md'] } }), T);
  expect(kb().insufficient).toBe(1); // used by one run: counted, below the n = 5 floor, so insufficient — not unused and not a value claim
});
