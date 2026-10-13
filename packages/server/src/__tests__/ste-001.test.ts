import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { steLint, steSummary } from '../services/ste-lint';
import { CHECKER_INSTRUCTIONS, MAKER_TEMPLATE_RULES, makerTemplateRules, objectiveScopeLine } from '../services/loop-service';
import { PANEL_REVIEW_INSTRUCTIONS } from '../services/self-improvement-agent-review-service';
import { MAKER_TEMPLATE_RULES_STE, STE_TEMPLATE_HASH, runSte001, ste001Evidence, steArm } from '../services/ste-001';
import { aceArm } from '../services/ace-001';
import { assignmentContext } from '../services/assignment-context';
import { MAKER_TEMPLATE_HASH, runGenome } from '../services/maker-genome';
import { daemonCheckOptions } from '../services/loop-daemon';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database;
const now = new Date().toISOString();
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());
const proposal = (id: string, refs: string[]) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
  VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?)`).run(id, JSON.stringify(refs), now, now);
const goal = (id: string, improvementId: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?, ?)`).run(id, improvementId, now, now);
const goalIn = (arm: 0 | 1) => { for (let i = 0; ; i++) if (steArm(`goal-${i}`) === arm) return `goal-${i}`; };

// --- 1. STE lint ---
it('lint: each rule fires on its defect and stays quiet on STE text', () => {
  expect(steLint('Run a check that has many words in it so that it goes well over the twenty word limit for one sentence here.').map((f) => f.rule)).toContain('sentence_length');
  expect(steLint('Run the relevant checks.').map((f) => f.detail)).toEqual(['relevant']);
  expect(steLint('Checker approval is required.').map((f) => f.rule)).toEqual(['passive_voice']);
  expect(steLint('Install the packages; never edit the lockfile.').map((f) => f.rule)).toEqual(['multiple_instructions']);
  expect(steLint('1. If `node_modules` is missing, run `npm ci`.\n2. Do not push.')).toEqual([]);
});

it('lint (report-only): today\'s instruction templates — documents the current state, update this when a template is rewritten', () => {
  const templates = {
    maker_rules: MAKER_TEMPLATE_RULES.join('\n'),
    checker: [...CHECKER_INSTRUCTIONS.common, CHECKER_INSTRUCTIONS.checker, ...CHECKER_INSTRUCTIONS.tail].join('\n'),
    security_checker: CHECKER_INSTRUCTIONS.security,
    objective_scope: objectiveScopeLine('packages/server/src/services/x.ts'),
    panel_review: PANEL_REVIEW_INSTRUCTIONS.join('\n'),
  };
  expect(Object.fromEntries(Object.entries(templates).map(([k, v]) => [k, steSummary(v)]))).toEqual({
    maker_rules: { sentence_length: 0, vague_word: 2, passive_voice: 2, multiple_instructions: 2 },
    checker: { sentence_length: 2, vague_word: 1, passive_voice: 1, multiple_instructions: 3 },
    security_checker: { sentence_length: 0, vague_word: 0, passive_voice: 0, multiple_instructions: 0 },
    objective_scope: { sentence_length: 0, vague_word: 0, passive_voice: 0, multiple_instructions: 0 },
    panel_review: { sentence_length: 1, vague_word: 0, passive_voice: 1, multiple_instructions: 0 },
  });
});

it('lint (strict): the STE maker template has zero findings', () => {
  expect(steLint(MAKER_TEMPLATE_RULES_STE.join('\n'))).toEqual([]);
});

// --- 2. same obligations ---
it('every obligation of today\'s maker rules maps to a line of the STE rules', () => {
  const ste = MAKER_TEMPLATE_RULES_STE.join('\n');
  const map: Array<[RegExp, RegExp[]]> = [
    [/small and local to the finding/, [/Change only the files that the finding names/, /400 lines or fewer/, /200 lines or fewer/]],
    [/Do not merge, push, deploy, edit secrets, or change policy/, [/Do not merge\./, /Do not push\./, /Do not deploy\./, /Do not change secrets\./, /Do not change policy files\./]],
    [/npm ci --legacy-peer-deps/, [/If `node_modules` is missing, run `npm ci --legacy-peer-deps`/, /Do not change `package\.json`/, /reverts lockfile changes before the review/]],
    [/deterministic checks before handing off/, [/Before you stop, run `npm run test:changed`, `npm run lint` and `npm run type-check`/]],
    [/Checker approval is required/, [/A checker must accept your change/]],
  ];
  const obligations = MAKER_TEMPLATE_RULES.filter((l) => l.startsWith('- '));
  for (const line of obligations) {
    const m = map.find(([old]) => old.test(line));
    expect(m, `unmapped rule: ${line}`).toBeTruthy();
    for (const re of m![1]) expect(ste).toMatch(re);
  }
  expect(STE_TEMPLATE_HASH).not.toBe(MAKER_TEMPLATE_HASH);
});

// --- 3. experiment ---
it('arm: deterministic, balanced, and independent of the ACE-001 arm', () => {
  expect(steArm('g-x')).toBe(steArm('g-x'));
  const cells: Record<string, number> = {};
  for (let i = 0; i < 8000; i++) { const g = randomUUID(); const k = `${steArm(g)}${aceArm(g).code}`; cells[k] = (cells[k] ?? 0) + 1; }
  expect(Object.keys(cells)).toHaveLength(8);
  for (const n of Object.values(cells)) expect(Math.abs(n - 1000)).toBeLessThan(130); // ~4 sd of binomial(8000, 1/8)
});

it('only oracle-lane goals enter; off keeps today\'s template; arm 1 gets the STE rules and its own template gene', () => {
  proposal('p-oracle', ['test-gap:svc']); proposal('p-other', ['reflection:x']);
  const g1 = goalIn(1); goal(g1, 'p-oracle'); const g0 = goalIn(0); goal(g0 + '-x', 'p-other');
  expect(assignmentContext(db, { id: 'r', goal_id: g1 }, '/tmp', 'm', { STE_001_MODE: 'off' }).ste).toBeUndefined();
  expect(assignmentContext(db, { id: 'r', goal_id: g0 + '-x' }, '/tmp', 'm', { STE_001_MODE: 'on' }).ste).toBeUndefined();
  const ctx = assignmentContext(db, { id: 'r', goal_id: g1 }, '/tmp', 'm', { STE_001_MODE: 'on' });
  expect(ctx.ste).toEqual({ arm: 1, template_hash: STE_TEMPLATE_HASH });
  expect(makerTemplateRules(ctx.ste)).toBe(MAKER_TEMPLATE_RULES_STE);
  expect(makerTemplateRules({ arm: 0 })).toBe(MAKER_TEMPLATE_RULES);
  expect(makerTemplateRules(undefined)).toBe(MAKER_TEMPLATE_RULES);
  db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, 'run-1', 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), JSON.stringify({ examples: [], rule_ids: [], ste_001: ctx.ste }), now);
  expect(runGenome(db, 'run-1').template).toBe(STE_TEMPLATE_HASH);
  expect(runGenome(db, 'run-none').template).toBe(MAKER_TEMPLATE_HASH);
});

it('the gate set does not depend on the experiment', () => {
  const env = { LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,lint,type-check,test:mutation:grounded', LOOP_DAEMON_CHECK_TIMEOUT_MS: '300000' };
  expect(daemonCheckOptions({ ...env, STE_001_MODE: 'on' })).toEqual(daemonCheckOptions(env));
});

it('evidence: per-arm n / verified / out-of-scope share / tokens; gym and untagged outcomes excluded', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string | null, success: boolean, extra: string[] = [], skill = 'loop-maker:doc-drift-and-small-fix-loop:opencode') => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, ?, ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), skill, success ? 1 : 0, randomUUID(), JSON.stringify([...(arm ? [`ste-001-arm:${arm}`] : []), ...extra]), now);
  outcome('0', true); outcome('0', false, ['gate:auto_approved_scope:fail']); outcome('1', true); outcome('1', true);
  outcome('1', true, [], 'loop-maker:gym:atomic'); outcome(null, false);
  const ev = ste001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { STE_001_MODE: 'on' });
  expect(ev.arms['0']).toMatchObject({ n: 2, verified: 1, out_of_scope: 1, out_of_scope_share: 0.5, tokens_mean: 1000 });
  expect(ev.arms['1']).toMatchObject({ n: 2, verified: 2, out_of_scope_share: 0 });
  expect(ev.diff).toBe(0.5); expect(ev.status).toBe('collecting'); expect(ev.ste_template_hash).toBe(createHash('sha256').update(MAKER_TEMPLATE_RULES_STE.join('\n')).digest('hex').slice(0, 12));
  expect(buildEvolutionEvidence(db, { STE_001_MODE: 'on' }).ste_001.arms['1'].n).toBe(2);
});

it('evidence: mode reflects STE_001_MODE env and diff is null when an arm is empty', () => {
  new SkillEvolutionEngine(db);
  const ev = ste001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { STE_001_MODE: 'on' });
  expect(ev.mode).toBe('on');
  expect(ev.arms['0'].n).toBe(0);
  expect(ev.arms['1'].n).toBe(0);
  expect(ev.diff).toBeNull();
  const evOff = ste001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), {});
  expect(evOff.mode).toBeNull();
});

it('evidence: status is analysable when both arms reach the target, collecting when one falls short', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string, success: boolean) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, ?, ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), 'loop-maker:doc-drift-and-small-fix-loop:opencode', success ? 1 : 0, randomUUID(), JSON.stringify([`ste-001-arm:${arm}`]), now);
  for (let i = 0; i < 100; i++) { outcome('0', true); outcome('1', i % 2 === 0); }
  const ev = ste001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { STE_001_MODE: 'on' });
  expect(ev.arms['0'].n).toBe(100);
  expect(ev.arms['1'].n).toBe(100);
  expect(ev.status).toBe('analysable');
  expect(ev.diff).toBe(-0.5);
});

it('evidence: collecting when arm 0 reaches target but arm 1 does not', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, ?, 1, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), 'loop-maker:doc-drift-and-small-fix-loop:opencode', randomUUID(), JSON.stringify([`ste-001-arm:${arm}`]), now);
  for (let i = 0; i < 100; i++) outcome('0');
  for (let i = 0; i < 99; i++) outcome('1');
  const ev = ste001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { STE_001_MODE: 'on' });
  expect(ev.arms['0'].n).toBe(100);
  expect(ev.arms['1'].n).toBe(99);
  expect(ev.status).toBe('collecting');
});

it('runSte001: returns the ste context from the latest assignment_context event, null otherwise', () => {
  const insertEvent = (runId: string, metadata: string) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), runId, metadata, now);
  insertEvent('run-a', JSON.stringify({ ste_001: { arm: 0, template_hash: STE_TEMPLATE_HASH } }));
  insertEvent('run-b', JSON.stringify({ ste_001: { arm: 1, template_hash: STE_TEMPLATE_HASH } }));
  insertEvent('run-c', JSON.stringify({ ste_001: { arm: 2, template_hash: 'x' } }));
  insertEvent('run-d', JSON.stringify({ examples: [] }));
  insertEvent('run-e', '{not valid json');
  expect(runSte001(db, 'run-a')).toEqual({ arm: 0, template_hash: STE_TEMPLATE_HASH });
  expect(runSte001(db, 'run-b')).toEqual({ arm: 1, template_hash: STE_TEMPLATE_HASH });
  expect(runSte001(db, 'run-c')).toBeNull();
  expect(runSte001(db, 'run-d')).toBeNull();
  expect(runSte001(db, 'run-e')).toBeNull();
  expect(runSte001(db, 'run-none')).toBeNull();
});

it('runSte001: picks the latest assignment_context event when several exist', () => {
  const insertEvent = (runId: string, metadata: string, createdAt: string) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), runId, metadata, createdAt);
  insertEvent('run-x', JSON.stringify({ ste_001: { arm: 0, template_hash: STE_TEMPLATE_HASH } }), '2024-01-01T00:00:00Z');
  insertEvent('run-x', JSON.stringify({ ste_001: { arm: 1, template_hash: STE_TEMPLATE_HASH } }), '2024-01-02T00:00:00Z');
  expect(runSte001(db, 'run-x')?.arm).toBe(1);
});
