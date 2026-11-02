import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { WRITE_TEST_ORACLE } from '../services/gym-failure-tasks';
import { isSpecGapKey, parseSpec, recordSpecGapShadow, scanSpecGaps, scenarioId, specGapEvidence, specGapMode, specGapPoolTasks, specTaskKey, type SpecRepo } from '../services/spec-gap-source';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';

const SPEC = `# widget Specification

## Purpose
Widgets.

## Requirements

### Requirement: Widget limits
The widget in \`packages/server/src/services/widget.ts\` SHALL clamp values.

#### Scenario: Value above the limit
- **GIVEN** a limit of 10
- **WHEN** clamp(12) is called
- **THEN** it returns 10

#### Scenario: Value below zero
- **WHEN** clamp(-1) is called
- **THEN** it returns 0

### Requirement: Flat file
The plain helper in \`packages/server/src/services/flat.ts\` SHALL exist.

#### Scenario: Flat helper answers
- **THEN** it answers

### Requirement: No anchor
Something without a file.

#### Scenario: Unanchored behaviour
- **THEN** nothing
`;
const WIDGET = 'export function clamp(v: number, limit = 10): number {\n  if (v > limit) return limit;\n  if (v < 0) return 0;\n  return v;\n}\n';
const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
const repo = (extra: Record<string, string> = {}): SpecRepo => {
  const files: Record<string, string> = {
    'openspec/specs/widget/spec.md': SPEC,
    'packages/server/src/services/widget.ts': WIDGET,
    'packages/server/src/services/flat.ts': 'export const flat = "x";\n', // no mutation operator → no mutant
    'packages/server/src/__tests__/widget.test.ts': "it('value below zero returns 0', () => {});\n",
    ...extra,
  };
  return { base: BASE, files: Object.keys(files), read: (f) => files[f] ?? null };
};
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };

describe('SPEC_GAP_LANE spec-gap source', () => {
  it('parses requirements and scenarios from a spec.md fixture', () => {
    const reqs = parseSpec(SPEC);
    expect(reqs.map((r) => r.title)).toEqual(['Widget limits', 'Flat file', 'No anchor']);
    expect(reqs[0].scenarios.map((s) => s.title)).toEqual(['Value above the limit', 'Value below zero']);
    expect(reqs[0].scenarios[0].text).toBe('- **GIVEN** a limit of 10\n- **WHEN** clamp(12) is called\n- **THEN** it returns 10');
    expect(reqs[0].text).toContain('packages/server/src/services/widget.ts');
  });

  it('covered vs uncovered; anchored file without mutants gives no task', () => {
    const scan = scanSpecGaps(repo());
    expect({ ...scan, tasks: scan.tasks.length }).toEqual({ scenarios: 4, covered: 1, uncovered: 3, unanchored: 1, anchored_without_mutant: 1, tasks: 1 });
    const [t] = scan.tasks;
    expect(t).toMatchObject({ commit: specTaskKey('widget', 'Value above the limit'), kind: 'write_test', base: BASE, target: 'packages/server/src/services/widget.ts',
      oracle: WRITE_TEST_ORACLE, lane: 'spec-gap', instructions: { role: 'data', text: '- **GIVEN** a limit of 10\n- **WHEN** clamp(12) is called\n- **THEN** it returns 10' } });
    expect(t.tests).toEqual([t.source]);
    expect(t.source).toMatch(/^packages\/server\/src\/__tests__\/widget\.spec-[0-9a-f]{12}\.test\.ts$/);
    expect(t.mutants.length).toBeGreaterThan(0);
    expect(isSpecGapKey(t.commit)).toBe(true);
  });

  it('a stable id in a test comment covers the scenario', () => {
    const scan = scanSpecGaps(repo({ 'packages/server/src/__tests__/other.test.ts': `// ${scenarioId('widget', 'Value above the limit')}\n` }));
    expect(scan.tasks).toEqual([]);
    expect(scan.covered).toBe(2);
  });

  it('keys and mutants are stable across reruns', () => {
    expect(specTaskKey('widget', 'Value above the limit')).toBe(specTaskKey('widget', 'Value above the limit'));
    expect(specTaskKey('widget', 'Value above the limit')).not.toBe(specTaskKey('other', 'Value above the limit'));
    expect(scanSpecGaps(repo()).tasks).toEqual(scanSpecGaps(repo()).tasks);
  });

  it('off → nothing: no pool tasks, no judgment row', () => {
    const db = fresh();
    expect(specGapMode({})).toBe('off');
    expect(specGapPoolTasks(repo(), new Set(), {})).toEqual([]);
    expect(recordSpecGapShadow(db, repo(), new Date(), {})).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'spec_gap_tasks'").get() as { n: number }).n).toBe(0);
    expect(specGapEvidence(db, {}).latest).toBeNull(); // unknown, not zero
  });

  it('shadow → counts only: one judgment row, no pool tasks, deduped when unchanged', () => {
    const db = fresh(); const env = { SPEC_GAP_LANE: 'shadow' };
    expect(specGapPoolTasks(repo(), new Set(), env)).toEqual([]);
    expect(recordSpecGapShadow(db, repo(), new Date(), env)).toBe(true);
    expect(recordSpecGapShadow(db, repo(), new Date(), env)).toBe(false);
    const row = db.prepare("SELECT mode, answers_json FROM judgments WHERE judgment = 'spec_gap_tasks'").all() as Array<{ mode: string; answers_json: string }>;
    expect(row).toHaveLength(1);
    expect(row[0].mode).toBe('shadow');
    expect(JSON.parse(row[0].answers_json)).toMatchObject({ scenarios: 4, covered: 1, uncovered: 3, tasks: 1 });
    expect(specGapEvidence(db, env)).toMatchObject({ mode: 'shadow', latest: { tasks: 1 }, served: null });
  });

  it('on → the pool hook offers untried tasks and skips excluded (tried / holdout) keys', () => {
    const env = { SPEC_GAP_LANE: 'on' };
    const [t] = specGapPoolTasks(repo(), new Set(), env);
    expect(t.commit).toBe(specTaskKey('widget', 'Value above the limit'));
    expect(specGapPoolTasks(repo(), new Set([t.commit]), env)).toEqual([]);
  });

  it('is an evolution flag and nested under failure_tasks in the evidence', () => {
    expect(EVOLUTION_FLAGS.map((f) => f.name)).toContain('SPEC_GAP_LANE');
    const ev = buildEvolutionEvidence(fresh(), {}) as unknown as { failure_tasks: { spec_gap: { mode: string; latest: unknown } } };
    expect(ev.failure_tasks.spec_gap).toMatchObject({ mode: 'off', latest: null });
  });
});
