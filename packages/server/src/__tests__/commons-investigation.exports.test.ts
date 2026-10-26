import { expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isInvestigationTopic,
  investigationBrief,
  recordInvestigationEvidence,
  BRIEF_CHARS,
  type InvestigationEvidence,
} from '../services/commons-investigation';

const baseEvidence = (): InvestigationEvidence => ({
  version: 1,
  topic_ref: 'run:r1',
  repo: { slug: null, revision: 'abcdef1234567890' },
  path: 'packages/server/src/services/queue-hygiene.ts',
  symbol: 'sweepZombies',
  code: { path: 'packages/server/src/services/queue-hygiene.ts', lines: [3, 6], total_lines: 10, text: 'export function sweepZombies(limit: number): number {\n  return limit;\n}' },
  test: { path: 'packages/server/src/__tests__/queue-hygiene.test.ts', text: "it('caps', () => {})" },
  recorded_result: {
    run_id: 'r1', run_status: 'blocked', loop_name: 'test-gap', revision: 'abcdef1234567890',
    checks: [{ name: 'test', status: 'fail', exit_status: 1 }], failed_gates: ['tests_lint_typecheck'], recorded_at: '2026-01-01T00:00:00.000Z',
  },
  stale: { value: false, reason: 'recorded at the current revision' },
  grounding: {
    mechanical: { method: 'proposal_grounding', detail: 'grounded target of proposal si-1' },
    executed: { run_id: 'r1', checks_executed: 2, checks_failed: 1 },
  },
  uncertainty: 'Whether the recorded checks of run r1 fail because of sweepZombies or for another reason is not established.',
  refs: [
    { ref: 'source:packages/server/src/services/queue-hygiene.ts@abcdef123456', provenance: 'git rev-parse HEAD + readTargetExcerpt' },
    { ref: 'loop_run:r1', provenance: 'loop_runs.gates_json + maker worker_leases' },
  ],
  unavailable: {},
});

it('isInvestigationTopic returns true for run: and proposal: refs with a non-empty id', () => {
  expect(isInvestigationTopic('run:r1')).toBe(true);
  expect(isInvestigationTopic('proposal:p-1')).toBe(true);
  expect(isInvestigationTopic('run:abc-def_123')).toBe(true);
});

it('isInvestigationTopic returns false for non-investigation topics, empty ids and whitespace', () => {
  expect(isInvestigationTopic('ecosystem:curiosity-seed-1')).toBe(false);
  expect(isInvestigationTopic('')).toBe(false);
  expect(isInvestigationTopic('run:')).toBe(false);
  expect(isInvestigationTopic('proposal:')).toBe(false);
  expect(isInvestigationTopic('run:r1 extra')).toBe(false);
  expect(isInvestigationTopic('run:r1\n')).toBe(false);
});

it('investigationBrief renders the repo, path, symbol, recorded result, freshness, grounding, uncertainty and refs', () => {
  const brief = investigationBrief(baseEvidence());
  expect(brief).toContain('queue-hygiene.ts');
  expect(brief).toContain('sweepZombies');
  expect(brief).toContain('run r1 (blocked)');
  expect(brief).toContain('current');
  expect(brief).toContain('proposal_grounding');
  expect(brief).toContain('2 recorded check(s), 1 failed');
  expect(brief).toContain('Uncertainty:');
  expect(brief).toContain('source:packages/server/src/services/queue-hygiene.ts@abcdef123456');
  expect(brief).toContain('loop_run:r1');
});

it('investigationBrief includes code and test excerpts', () => {
  const brief = investigationBrief(baseEvidence());
  expect(brief).toContain('export function sweepZombies');
  expect(brief).toContain("it('caps'");
});

it('investigationBrief never exceeds BRIEF_CHARS', () => {
  const ev = baseEvidence();
  ev.code!.text = 'x'.repeat(5_000);
  ev.test!.text = 'y'.repeat(5_000);
  const brief = investigationBrief(ev);
  expect(brief.length).toBeLessThanOrEqual(BRIEF_CHARS);
});

it('investigationBrief reports unavailable fields instead of zero or empty', () => {
  const ev: InvestigationEvidence = {
    version: 1, topic_ref: 'run:missing', repo: { slug: null, revision: null }, path: null, symbol: null, code: null, test: null,
    recorded_result: null, stale: { value: null, reason: 'no recorded result to compare' },
    grounding: { mechanical: null, executed: null },
    uncertainty: 'No code location is known for run:missing; any file a reply names is unverified.',
    refs: [], unavailable: { revision: 'repository revision unresolvable', path: 'loop run missing not found', code: 'no path to read', symbol: 'no path to read', test: 'no test file found for the topic', recorded_result: 'no loop run is recorded for this topic' },
  };
  const brief = investigationBrief(ev);
  expect(brief).toContain('unavailable');
  expect(brief).toContain('unknown');
  expect(brief).not.toContain('@ .');
});

describe('recordInvestigationEvidence', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE judgments (id TEXT PRIMARY KEY, judgment TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      state_hash TEXT NOT NULL, mode TEXT NOT NULL, decision TEXT, reason TEXT, answers_json TEXT, created_at TEXT NOT NULL)`);
  });
  afterEach(() => { db.close(); });

  it('records a commons_investigation_evidence judgment with decision attached in on mode', () => {
    const ev = baseEvidence();
    const brief = investigationBrief(ev);
    recordInvestigationEvidence(db, 'social:thread-1', 'on', ev, brief);
    const rows = db.prepare("SELECT judgment, subject_type, subject_id, mode, decision, answers_json FROM judgments WHERE judgment = 'commons_investigation_evidence'").all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ judgment: 'commons_investigation_evidence', subject_type: 'social_thread', subject_id: 'social:thread-1', mode: 'on', decision: 'attached' });
    const answers = JSON.parse(rows[0].answers_json);
    expect(answers.evidence.path).toBe('packages/server/src/services/queue-hygiene.ts');
    expect(answers.brief_chars).toBe(brief.length);
  });

  it('records decision would_attach in shadow mode', () => {
    const ev = baseEvidence();
    recordInvestigationEvidence(db, 'social:thread-2', 'shadow', ev, 'brief');
    const row = db.prepare("SELECT decision, mode FROM judgments WHERE judgment = 'commons_investigation_evidence'").get() as { decision: string; mode: string };
    expect(row).toEqual({ decision: 'would_attach', mode: 'shadow' });
  });

  it('does not throw when the judgments table is absent', () => {
    const bare = new Database(':memory:');
    expect(() => recordInvestigationEvidence(bare, 'social:t', 'on', baseEvidence(), 'brief')).not.toThrow();
    bare.close();
  });
});