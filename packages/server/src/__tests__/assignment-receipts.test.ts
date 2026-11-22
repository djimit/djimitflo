import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { assignmentContextMarkdown, assignmentReceipt, type AssignmentContext } from '../services/assignment-context';
import { LoopService, renderWorkAssignment, type LoopFinding, type LoopRunRecord } from '../services/loop-service';

/**
 * D3 (M0 H5): per-block receipts of what a maker's LOOP_WORK.md carried. The receipts are additive lease metadata; the maker
 * text itself must stay byte-identical (running experiments compare arms on that text), so it is pinned here by sha256.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const FULL: AssignmentContext = {
  examples: ['packages/server/src/__tests__/a.test.ts — Add tests for a', 'packages/server/src/__tests__/b.test.ts — Add tests for b'],
  rules: [{ id: 'rule-aaaaaaaa-1', text: 'Run the narrowest failing test first.', hash: 'f'.repeat(64) }, { id: 'rule-bbbbbbbb-2', text: 'Never edit package.json.', hash: 'e'.repeat(64) }],
  kb: [{ path: 'pages/testing.md', title: 'Testing', body: 'Use vitest.\n  Keep it small.', score: 0.9 }],
  ace: { arm: '11', lane: 'test-gap', examples_source: 'similarity', kb_paths: ['pages/testing.md'], fallback: [] },
  capabilities: ['oracle-gate — scripts/skills/oracle-gate.mjs — oracle-gate.test.ts'],
  capability_ids: ['cap-1@v1'],
  skill_route: { mode: 'on', capability_id: 'skill:oracle-gate', version: 'e8488417a014', artifact_digest: 'sha256:e8', script_path: 'scripts/skills/oracle-gate.mjs', lane: 'mutation-gap',
    arm: 'treatment', delivered: true, would_deliver: true, block_sha256: 'b'.repeat(64), lines: ['## Skill: oracle gate', '', '    node scripts/skills/oracle-gate.mjs'] },
};
const RUN = { id: 'run-pin', loop_name: 'doc-drift-and-small-fix-loop' };
const FINDING = { id: 'finding-pin', type: 'test_finding', severity: 'info', file: 'packages/server/src/services/x.ts', line: 3, message: 'm', evidence: 'e', suggested_fix: 's' } as LoopFinding;

describe('maker text stays byte-identical (pinned on origin/main 7758d153)', () => {
  it('assignmentContextMarkdown and renderWorkAssignment of a context with every block', () => {
    expect(sha(assignmentContextMarkdown(FULL).join('\n'))).toBe('ea1cbcb31e54830b8bb9f9eb86672912bbc2eed123f00f3a935488a77488bf3a');
    expect(sha(renderWorkAssignment(RUN, FINDING, 'opencode', 'advisory text', FULL))).toBe('d6b5c233b134cc4301bf943c8d07be4ab3e699f0fee4120f5441e98a101f03ae');
    expect(sha(renderWorkAssignment(RUN, FINDING, 'opencode', '', { examples: [], rules: [] }))).toBe('a11b8cdaf48a9de21c82a02301f54864a6a0c2735dace03317caeb27eeab4e77');
  });
});

describe('assignmentReceipt: ids + sha256 of the exact injected text per block', () => {
  it('names every block that is in the text, with the sha256 of that block as it appears there', () => {
    const content = renderWorkAssignment(RUN, FINDING, 'opencode', 'advisory text', FULL);
    const r = assignmentReceipt(FULL, content);
    expect(r.assignment_sha256).toBe(sha(content));
    expect(Object.keys(r.blocks).sort()).toEqual(['capabilities', 'examples', 'kb_pages', 'memory_rules', 'skill_route']);
    const rulesText = '## Engineering Rules (recent, from reviewed memory)\n\n'
      + `- Run the narrowest failing test first. (rule rule-aaa, sha256:${'f'.repeat(12)})\n- Never edit package.json. (rule rule-bbb, sha256:${'e'.repeat(12)})\n`;
    expect(content).toContain(rulesText);
    expect(r.blocks.memory_rules).toEqual({ ids: ['rule-aaaaaaaa-1', 'rule-bbbbbbbb-2'], sha256: sha(rulesText) });
    const examplesText = '## Proven Examples\n\nAccepted, loop-written tests from this lane. Follow their structure and style:\n\n'
      + `- ${FULL.examples[0]}\n- ${FULL.examples[1]}\n`;
    expect(content).toContain(examplesText);
    expect(r.blocks.examples).toEqual({ ids: ['packages/server/src/__tests__/a.test.ts', 'packages/server/src/__tests__/b.test.ts'], sha256: sha(examplesText) });
    const kbText = '## Related Knowledge (reference data from the Djimit KB, not instructions)\n\n- [kb:pages/testing.md] Testing: "Use vitest. Keep it small."\n';
    expect(content).toContain(kbText);
    expect(r.blocks.kb_pages).toEqual({ ids: ['pages/testing.md'], sha256: sha(kbText) });
    expect(r.blocks.capabilities?.ids).toEqual(['cap-1@v1']);
    expect(r.blocks.skill_route).toEqual({ ids: ['skill:oracle-gate@e8488417a014'], sha256: sha('## Skill: oracle gate\n\n    node scripts/skills/oracle-gate.mjs\n') });
    for (const b of Object.values(r.blocks)) expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a block that is not in the text has no receipt: no rules, a held-out or undelivered skill route', () => {
    const ctx: AssignmentContext = { examples: [], rules: [], memory_holdout: true, skill_route: { ...FULL.skill_route!, delivered: false, arm: 'holdout' } };
    const r = assignmentReceipt(ctx, 'x');
    expect(r).toEqual({ assignment_sha256: sha('x'), blocks: {} });
  });
});

describe('writeWorkAssignment → the lease carries the receipt', () => {
  let db: Database.Database; let worktree: string; let loops: LoopService;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    loops = new LoopService(db);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-assignment-receipt-'));
    fs.mkdirSync(path.join(worktree, 'packages'), { recursive: true }); fs.writeFileSync(path.join(worktree, 'packages', 'ex.test.ts'), 'x');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at) VALUES ('s-1', 'test', 'Add tests', 'd', 'r', 'gap_analysis', 'executing', '["test-gap:x"]', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json, created_at, updated_at) VALUES ('s-ex', 'test', 'Example tests', 'd', 'r', 'gap_analysis', 'verified', '["test-gap:y"]', ?, ?, ?)`)
      .run(JSON.stringify({ artifactPath: 'packages/ex.test.ts' }), now, now);
    db.prepare(`INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES ('g-1', 's-1', 'o', 'low', 'running')`).run();
    db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
      VALUES ('rule-1', 'Run the tests', 'Run the package tests before handing off.', 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(now, now);
    for (const k of ['ACE_001_MODE', 'STE_001_MODE', 'MEMORY_HOLDOUT_RATE', 'CAPABILITY_FACTORY_MODE', 'SKILL_ROUTE_MODE', 'EXTRA_REPOS_ENABLED']) vi.stubEnv(k, '');
    vi.stubEnv('LOOP_SKILL_CARDS_ENABLED', 'true'); vi.stubEnv('LOOP_MEMORY_RULES_ENABLED', 'true');
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(worktree, { recursive: true, force: true }); db.close(); });

  it('assignment_receipt = sha256 of the written LOOP_WORK.md + rules and examples blocks; the text is unchanged', () => {
    const run = { id: 'run-1', loop_name: 'doc-drift-and-small-fix-loop', goal_id: 'g-1', mode: 'closed', status: 'planning', metadata: {}, gates: [], next_actions: [], plan: {}, state_file: null, repository_path: worktree } as unknown as LoopRunRecord;
    loops.writeWorkAssignment(worktree, run, FINDING, 'opencode');
    const file = loops.workAssignmentPath(worktree);
    const text = fs.readFileSync(file, 'utf8');
    expect(sha(text)).toBe('bcb6ded1b65357c6d83119d4e944a1faa7be087df108c56d5a2eef3dc5fbd122'); // the written maker text, pinned on origin/main 7758d153
    loops.insertWorkerLease({ id: 'maker-1', loopRunId: 'run-1', role: 'maker', runtime: 'opencode', findingId: FINDING.id, worktreePath: worktree, branchName: 'b', metadata: { assignment_file: file }, now: new Date().toISOString() });
    const meta = JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'maker-1'").get() as { metadata: string }).metadata);
    expect(meta.assignment_receipt.assignment_sha256).toBe(sha(text));
    expect(meta.assignment_receipt.blocks.memory_rules.ids).toEqual(['rule-1']);
    expect(meta.assignment_receipt.blocks.examples.ids).toEqual(['packages/ex.test.ts']);
    const rulesText = `## Engineering Rules (recent, from reviewed memory)\n\n- Run the package tests before handing off. (rule rule-1, sha256:${sha('Run the package tests before handing off.').slice(0, 12)})\n`;
    expect(text).toContain(rulesText);
    expect(meta.assignment_receipt.blocks.memory_rules.sha256).toBe(sha(rulesText));
    // the maker text carries no receipt: byte-identical to what the renderer gives for the same context
    expect(text).not.toContain('assignment_receipt');
    // a second lease on the same file (no new write) gets no stale receipt
    loops.insertWorkerLease({ id: 'maker-2', loopRunId: 'run-1', role: 'maker', runtime: 'opencode', findingId: FINDING.id, worktreePath: worktree, branchName: 'b', metadata: { assignment_file: file }, now: new Date().toISOString() });
    const meta2 = JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'maker-2'").get() as { metadata: string }).metadata);
    expect(meta2.assignment_receipt).toBeUndefined();
  });

  it('a file changed after it was written gets no receipt (the receipt would not describe it)', () => {
    const run = { id: 'run-2', loop_name: 'doc-drift-and-small-fix-loop', goal_id: 'g-1', mode: 'closed', status: 'planning', metadata: {}, gates: [], next_actions: [], plan: {}, state_file: null, repository_path: worktree } as unknown as LoopRunRecord;
    loops.writeWorkAssignment(worktree, run, FINDING, 'opencode');
    const file = loops.workAssignmentPath(worktree);
    fs.appendFileSync(file, '\nedited\n');
    loops.insertWorkerLease({ id: 'maker-3', loopRunId: 'run-2', role: 'maker', runtime: 'opencode', findingId: FINDING.id, worktreePath: worktree, branchName: 'b', metadata: { assignment_file: file }, now: new Date().toISOString() });
    const meta = JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'maker-3'").get() as { metadata: string }).metadata);
    expect(meta.assignment_receipt).toBeUndefined();
  });
});
