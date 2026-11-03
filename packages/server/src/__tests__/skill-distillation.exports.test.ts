import { describe, expect, it } from 'vitest';
import { buildSkillCard, cardSha256 } from '../services/skill-distillation';
import type { SkillCard } from '../services/skill-distillation';

// Minimal structural mock of better-sqlite3 Database — only what buildSkillCard touches.
type RunRow = { loop_name: string | null; metadata: string | null; improvement_id: string | null; task_kind: string | null } | undefined;
type LeaseRow = { id: string; role: string; runtime: string; status: string; metadata: string };

const makeDb = (runRow: RunRow, leases: LeaseRow[] = []) => ({
  prepare: (sql: string) => {
    if (sql.includes('SELECT r.loop_name')) return { get: () => runRow };
    if (sql.includes('FROM worker_leases')) return { all: () => leases };
    return { get: () => undefined, all: () => [] };
  },
});

// --- cardSha256 ---
describe('cardSha256', () => {
  const baseCard: SkillCard = {
    kind: 'skill',
    lane: 'alpha',
    task_kind: 'test_gen',
    target_pattern: ['packages/server/src/*'],
    diff_shape: { files_changed: 1, diff_lines: 50, lines_added: 40, lines_removed: 10, test_only: true },
    checks_passed: ['lint', 'type-check'],
    checker_verdict: { checker: 'pass', security_checker: null },
    runtime: 'opencode',
    model: 'ollama/kimi-k2.6:cloud',
    genome_id: 'g1',
    provenance: { proposal_id: 'p1', run_id: 'r1', lease_id: 'l1', pr_url: 'https://example.com/pr/1', attribution_id: 'a1' },
  };

  it('returns a 64-character lowercase hex string', () => {
    expect(cardSha256(baseCard)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same card content', () => {
    expect(cardSha256(baseCard)).toBe(cardSha256({ ...baseCard }));
  });

  it('produces different hashes for different cards', () => {
    expect(cardSha256(baseCard)).not.toBe(cardSha256({ ...baseCard, lane: 'beta' }));
  });
});

// --- buildSkillCard ---
describe('buildSkillCard', () => {
  it('returns null when the run is not found', () => {
    expect(buildSkillCard(makeDb(undefined), 'no-such-run', 'verified', 'a1', null)).toBeNull();
  });

  it('builds a skill card for a verified run with a completed maker', () => {
    const runRow = {
      loop_name: 'alpha', improvement_id: 'prop-1', task_kind: 'test_gen',
      metadata: JSON.stringify({ pr_url: 'https://example.com/pr/1', failed_gates: [] }),
    };
    const leases: LeaseRow[] = [{
      id: 'lease-1', role: 'maker', runtime: 'opencode', status: 'completed',
      metadata: JSON.stringify({
        changed_files: ['packages/server/src/foo.ts', 'packages/server/src/bar.test.ts'],
        diff_lines: 80, lines_added: 60, lines_removed: 20,
        model: 'ollama/kimi-k2.6:cloud', genome_id: 'g1',
        deterministic_checks: [
          { name: 'lint', status: 'pass' },
          { name: 'type-check', status: 'pass' },
          { name: 'test', status: 'fail' },
        ],
      }),
    }];
    const card = buildSkillCard(makeDb(runRow, leases), 'run-1', 'verified', 'attr-1', null);
    expect(card).not.toBeNull();
    expect(card!.kind).toBe('skill');
    expect(card!.lane).toBe('alpha');
    expect(card!.task_kind).toBe('test_gen');
    expect(card!.target_pattern).toEqual(['packages/server/src/*.test.ts', 'packages/server/src/*.ts']);
    expect(card!.diff_shape.files_changed).toBe(2);
    expect(card!.diff_shape.test_only).toBe(false);
    expect(card!.checks_passed).toEqual(['lint', 'type-check']);
    expect(card!.checker_verdict).toEqual({ checker: null, security_checker: null });
    expect(card!.runtime).toBe('opencode');
    expect(card!.model).toBe('ollama/kimi-k2.6:cloud');
    expect(card!.genome_id).toBe('g1');
    expect(card!.provenance).toEqual({
      proposal_id: 'prop-1', run_id: 'run-1', lease_id: 'lease-1',
      pr_url: 'https://example.com/pr/1', attribution_id: 'attr-1',
    });
    expect(card!.failure).toBeUndefined();
  });

  it('builds an anti_pattern card for a maker_failure run with a failure signature', () => {
    const runRow = {
      loop_name: 'beta', improvement_id: null, task_kind: null,
      metadata: JSON.stringify({ failed_gates: ['lint: ESLint failed'] }),
    };
    const leases: LeaseRow[] = [{
      id: 'lease-2', role: 'maker', runtime: 'codex', status: 'failed',
      metadata: JSON.stringify({
        changed_files: ['packages/server/src/__tests__/foo.test.ts'],
        failure_reason: 'SyntaxError: unexpected token',
      }),
    }];
    const card = buildSkillCard(makeDb(runRow, leases), 'run-2', 'maker_failure', 'attr-2', 'gate failed');
    expect(card).not.toBeNull();
    expect(card!.kind).toBe('anti_pattern');
    expect(card!.failure).toBeDefined();
    expect(card!.failure!.gate).toBe('lint');
    expect(card!.failure!.error_class).not.toBeNull();
    expect(card!.diff_shape.test_only).toBe(true);
  });

  it('returns a card with null maker fields when no maker lease exists', () => {
    const runRow = { loop_name: 'gamma', metadata: '{}', improvement_id: null, task_kind: null };
    const card = buildSkillCard(makeDb(runRow, []), 'run-3', 'verified', 'attr-3', null);
    expect(card).not.toBeNull();
    expect(card!.runtime).toBeNull();
    expect(card!.model).toBeNull();
    expect(card!.genome_id).toBeNull();
    expect(card!.diff_shape.files_changed).toBeNull();
    expect(card!.diff_shape.test_only).toBeNull();
    expect(card!.checks_passed).toBeNull();
    expect(card!.provenance.lease_id).toBeNull();
  });

  it('picks the completed maker over a non-completed one', () => {
    const runRow = { loop_name: 'delta', metadata: '{}', improvement_id: null, task_kind: null };
    const leases: LeaseRow[] = [
      { id: 'lease-f', role: 'maker', runtime: 'codex', status: 'failed', metadata: JSON.stringify({ model: 'codex-1' }) },
      { id: 'lease-d', role: 'maker', runtime: 'opencode', status: 'completed', metadata: JSON.stringify({ model: 'ollama/kimi-k2.6:cloud' }) },
    ];
    const card = buildSkillCard(makeDb(runRow, leases), 'run-4', 'verified', 'attr-4', null);
    expect(card).not.toBeNull();
    expect(card!.runtime).toBe('opencode');
    expect(card!.provenance.lease_id).toBe('lease-d');
  });

  it('skips superseded makers', () => {
    const runRow = { loop_name: 'epsilon', metadata: '{}', improvement_id: null, task_kind: null };
    const leases: LeaseRow[] = [
      { id: 'lease-old', role: 'maker', runtime: 'codex', status: 'completed', metadata: JSON.stringify({ superseded_by_maker_lease_id: 'lease-new', model: 'codex-1' }) },
      { id: 'lease-new', role: 'maker', runtime: 'opencode', status: 'completed', metadata: JSON.stringify({ model: 'ollama/kimi-k2.6:cloud' }) },
    ];
    const card = buildSkillCard(makeDb(runRow, leases), 'run-5', 'verified', 'attr-5', null);
    expect(card).not.toBeNull();
    expect(card!.provenance.lease_id).toBe('lease-new');
  });

  it('extracts checker verdict from the matching checker lease', () => {
    const runRow = { loop_name: 'zeta', metadata: '{}', improvement_id: null, task_kind: null };
    const leases: LeaseRow[] = [
      { id: 'lm', role: 'maker', runtime: 'opencode', status: 'completed', metadata: JSON.stringify({ model: 'm1' }) },
      { id: 'lc', role: 'checker', runtime: 'opencode', status: 'completed', metadata: JSON.stringify({ verdict: 'accept', maker_lease_id: 'lm' }) },
      { id: 'ls', role: 'security_checker', runtime: 'opencode', status: 'completed', metadata: JSON.stringify({ verdict: 'clean', maker_lease_id: 'lm' }) },
    ];
    const card = buildSkillCard(makeDb(runRow, leases), 'run-6', 'verified', 'attr-6', null);
    expect(card).not.toBeNull();
    expect(card!.checker_verdict).toEqual({ checker: 'accept', security_checker: 'clean' });
  });
});