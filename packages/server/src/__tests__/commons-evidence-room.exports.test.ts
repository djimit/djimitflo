import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { buildRunSummary, redactDeep, summaryText } from '../services/commons-evidence-room';
import type { EvidenceRoomSummary } from '../services/commons-evidence-room';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('redactDeep', () => {
  it('returns primitives unchanged (non-string)', () => {
    expect(redactDeep(0)).toBe(0);
    expect(redactDeep(true)).toBe(true);
    expect(redactDeep(null)).toBe(null);
    expect(redactDeep(undefined)).toBe(undefined);
  });

  it('redacts secret-bearing strings and leaves plain strings alone', () => {
    expect(redactDeep('plain text')).toBe('plain text');
    expect(redactDeep('ghp_' + 'a'.repeat(36))).toBe('[REDACTED:GitHub PAT]');
  });

  it('walks arrays recursively', () => {
    expect(redactDeep(['plain', 'ghp_' + 'a'.repeat(36), 7])).toEqual(['plain', '[REDACTED:GitHub PAT]', 7]);
  });

  it('walks objects recursively', () => {
    const out = redactDeep({ a: 'plain', b: { c: 'ghp_' + 'a'.repeat(36) } });
    expect(out.a).toBe('plain');
    expect(out.b.c).toBe('[REDACTED:GitHub PAT]');
  });

  it('does not mutate the input object', () => {
    const input = { x: 'ghp_' + 'a'.repeat(36) };
    redactDeep(input);
    expect(input.x).toBe('ghp_' + 'a'.repeat(36));
  });
});

describe('buildRunSummary', () => {
  const baseRow = {
    run_id: 'run-1',
    skill_id: 'loop-maker:foo',
    success: 1,
    agent_id: null as string | null,
    loop_name: 'commons-lane',
    run_meta: null as string | null,
    gates_json: null as string | null,
    objective: 'add a test',
    improvement_id: 'imp-1',
    target: 'packages/server/src/services/foo.ts',
  };

  it('records unknown fields when no maker lease, no gates, no checks, no graded, no reviewers, no target, no pr_url', () => {
    const s = buildRunSummary(db, { ...baseRow, loop_name: null, target: null });
    expect(s.run_id).toBe('run-1');
    expect(s.outcome).toBe('verified');
    expect(s.lane).toBeNull();
    expect(s.maker.species).toBe('loop-maker:foo');
    expect(s.maker.requested_runtime).toBeNull();
    expect(s.maker.effective_runtime).toBeNull();
    expect(s.gates).toBeNull();
    expect(s.deterministic_checks).toBeNull();
    expect(s.graded).toBeNull();
    expect(s.reviewers).toBeNull();
    expect(s.target_file).toBeNull();
    expect(s.pr_url).toBeNull();
    expect(s.unknown.maker).toBeTruthy();
    expect(s.unknown.gates).toBeTruthy();
    expect(s.unknown.deterministic_checks).toBeTruthy();
    expect(s.unknown.graded).toBeTruthy();
    expect(s.unknown.reviewers).toBeTruthy();
    expect(s.unknown.target_file).toBeTruthy();
    expect(s.unknown.pr_url).toBeTruthy();
    expect(s.unknown.lane).toBeTruthy();
  });

  it('builds a full summary from maker lease metadata, gates, pr_url and a reviewer lease', () => {
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata)
      VALUES (?, ?, 'maker', 'opencode', 'completed', ?)`)
      .run('lease-1', 'run-1', JSON.stringify({
        model: 'glm-5.2', effective_runtime: 'remote', effective_model: 'glm-5.2:cloud',
        deterministic_checks: [{ name: 'type-check', exit_status: 0 }, { name: 'lint', exit_status: 0, reason: 'clean' }],
        graded: { score: 0.875, kind: 'mutation_score' },
      }));
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata)
      VALUES (?, ?, 'checker', 'remote', 'completed', ?)`)
      .run('lease-2', 'run-1', JSON.stringify({ maker_lease_id: 'lease-1', verdict: 'approve', model: 'glm-5.2:cloud' }));

    const s = buildRunSummary(db, { ...baseRow, agent_id: 'lease-1', run_meta: JSON.stringify({ pr_url: 'https://github.com/x/y/pull/1' }),
      gates_json: JSON.stringify([{ name: 'maker_verdict', status: 'pass' }]) });

    expect(s.outcome).toBe('verified');
    expect(s.lane).toBe('commons-lane');
    expect(s.target_file).toBe('packages/server/src/services/foo.ts');
    expect(s.pr_url).toBe('https://github.com/x/y/pull/1');
    expect(s.maker.requested_runtime).toBe('opencode');
    expect(s.maker.effective_runtime).toBe('remote');
    expect(s.maker.model).toBe('glm-5.2:cloud');
    expect(s.gates).toEqual([{ name: 'maker_verdict', status: 'pass' }]);
    expect(s.deterministic_checks).toEqual([
      { name: 'type-check', exit_status: 0, passed: true, reason: null },
      { name: 'lint', exit_status: 0, passed: true, reason: 'clean' },
    ]);
    expect(s.graded).toEqual({ score: 0.875, kind: 'mutation_score' });
    expect(s.reviewers).toEqual([{ role: 'checker', runtime: 'remote', verdict: 'approve' }]);
    expect(s.unknown).toEqual({});
  });

  it('reports regressed outcome when success is 0', () => {
    const s = buildRunSummary(db, { ...baseRow, success: 0 });
    expect(s.outcome).toBe('regressed');
  });

  it('marks deterministic check passed false when exit_status is non-zero', () => {
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'completed', ?)`)
      .run('lease-1', 'run-1', JSON.stringify({ deterministic_checks: [{ name: 'type-check', exit_status: 2 }] }));
    const s = buildRunSummary(db, { ...baseRow, agent_id: 'lease-1' });
    expect(s.deterministic_checks?.[0].passed).toBe(false);
  });
});

describe('summaryText', () => {
  const full: EvidenceRoomSummary = {
    run_id: 'run-1', outcome: 'verified', lane: 'commons-lane', goal: 'add a test', improvement_id: 'imp-1',
    target_file: 'packages/server/src/services/foo.ts',
    maker: { species: 'loop-maker:foo', requested_runtime: 'opencode', effective_runtime: 'remote', model: 'glm-5.2:cloud' },
    gates: [{ name: 'maker_verdict', status: 'pass' }],
    deterministic_checks: [{ name: 'type-check', exit_status: 0, passed: true, reason: null }],
    graded: { score: 0.875, kind: 'mutation_score' },
    reviewers: [{ role: 'checker', runtime: 'remote', verdict: 'approve' }],
    pr_url: 'https://github.com/x/y/pull/1',
    unknown: {},
  };

  it('renders a verified run with all fields populated', () => {
    const t = summaryText(full);
    expect(t).toContain('loop run run-1 reached a verified outcome');
    expect(t).toContain('Lane: commons-lane');
    expect(t).toContain('Goal: add a test');
    expect(t).toContain('Target file: packages/server/src/services/foo.ts');
    expect(t).toContain('Maker: loop-maker:foo (requested opencode, ran on remote@glm-5.2:cloud)');
    expect(t).toContain('Gates: maker_verdict:pass');
    expect(t).toContain('Deterministic checks: type-check exit 0');
    expect(t).toContain('Graded/mutation score: 0.875 (mutation_score)');
    expect(t).toContain('Reviewers: checker@remote approve');
    expect(t).toContain('Draft PR: https://github.com/x/y/pull/1');
    expect(t).toContain('Merge survival (14 d): pending');
    expect(t).toContain('Replies count as evidence only with an executable artefact');
  });

  it('renders a regressed run with unknown placeholders', () => {
    const t = summaryText({ ...full, outcome: 'regressed', lane: null, gates: null, deterministic_checks: null, graded: null, reviewers: null, target_file: null, pr_url: null,
      unknown: { lane: 'no name', gates: 'no gates', deterministic_checks: 'none', graded: 'none', reviewers: 'none', target_file: 'no target', pr_url: 'no pr' } });
    expect(t).toContain('loop run run-1 regressed');
    expect(t).toContain('Lane: unknown (no name)');
    expect(t).toContain('Gates: unknown (no gates)');
    expect(t).toContain('Deterministic checks: unknown (none)');
    expect(t).toContain('Graded/mutation score: unknown (none)');
    expect(t).toContain('Reviewers: unknown (none)');
    expect(t).toContain('Target file: unknown (no target)');
    expect(t).toContain('Draft PR: unknown (no pr)');
  });

  it('falls back to "not recorded" when an unknown reason is missing', () => {
    const t = summaryText({ ...full, gates: null, unknown: {} });
    expect(t).toContain('Gates: unknown (not recorded)');
  });

  it('is capped at 2000 characters', () => {
    const long = 'x'.repeat(10_000);
    expect(summaryText({ ...full, goal: long }).length).toBeLessThanOrEqual(2_000);
  });
});