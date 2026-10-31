import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutableSkills, assertSkillInput, assertSkillAssignmentCurrent, skillFirstMode, type ExecutableSkillContract } from '../services/executable-skills';
import { createNativeTask } from '../services/native-task-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { LoopWorkerExecutorService } from '../services/loop-worker-executor-service';
import type { LoopService } from '../services/loop-service';
import { GoalService } from '../services/goal-service';
import { ensureSkillCardTable } from '../services/skill-distillation';
import { ExecutionEngine } from '../execution/execution-engine';
import type { LoopRunRecord, WorkerLeaseRecord } from '../services/loop-types';

let db: Database.Database;
let dir: string;
let service: ExecutableSkills;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const shape: ExecutableSkillContract['input'] = { type: 'object', properties: { value: 'number' }, required: ['value'] };

function writePackage(id = 'increment-v1-0-0', change: Partial<ExecutableSkillContract> = {}, delta = 1) {
  const directory = path.join(dir, id);
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    'SKILL.md': `---\nname: ${id}\ndescription: Increment the numeric value.\nversion: ${change.version ?? '1.0.0'}\nauthor: local-test-fixture\nallowed-tools: Bash\ndisallowed-tools: Network\n---\nRun the provided package with JSON on stdin and return its JSON output.`,
    'run.mjs': `import fs from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nexport function increment(input) { if (typeof input.value !== 'number' || !Number.isFinite(input.value)) throw new Error('invalid value'); return { value: input.value + ${delta} }; }\nif (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.stdout.write(JSON.stringify(increment(JSON.parse(fs.readFileSync(0, 'utf8')))));\n`,
    'run.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { increment } from './run.mjs';\ntest('positive and negative finite-number contract', () => { assert.deepEqual(increment({value: 1}), {value: ${1 + delta}}); assert.throws(() => increment({value: '1'})); });\n`,
  };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), content);
  const contract: ExecutableSkillContract = {
    format: 1, id, version: '1.0.0', capabilities: ['increment-number'], input: shape, output: shape,
    entrypoint: 'run.mjs', test: 'run.test.mjs', files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)])),
    dependencies: [], examples: [{ input: { value: 1 }, output: { value: 1 + delta } }], ...change,
  };
  fs.writeFileSync(path.join(directory, 'skill.contract.json'), JSON.stringify(contract));
  return { directory, contract };
}
function task(id: string, status = 'completed') {
  db.prepare("INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode) VALUES (?, 'fixture', 'fixture', ?, 'low', 'low', 'review_only')").run(id, status);
}
function evidence(taskId: string, packageHash: string, source = 'system', severity = 'info') {
  db.prepare(`INSERT INTO execution_evidence (id,task_id,evidence_type,severity,title,summary,details,source,captured_at) VALUES (?,?,'test_result',?,'fixture','Local test receipt fixture',?,?,?)`)
    .run(randomUUID(), taskId, severity, JSON.stringify({ skill_package_hash: packageHash }), source, new Date().toISOString());
}
function capture(id: string) {
  const p = service.load(id);
  const taskId = randomUUID(); task(taskId); evidence(taskId, p.contentHash);
  return service.capture(id, taskId, 'fixture-owner');
}
// Fixture only: downstream routing is tested against a pre-approved registry state, NOT real independent promotion.
function fixtureApprove(id: string) {
  db.prepare("UPDATE swarm_capabilities SET status='validated', eval_score=1 WHERE id=?").run(id);
}
function selection(id: string) {
  const c = new SwarmIntelligenceService(db).getCapability(id);
  return { capability_id: id, content_hash: String(c.metadata.package_hash) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-skill-test-'));
  vi.stubEnv('DJIMITFLO_SKILLS_DIR', dir);
  vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', '');
  vi.stubEnv('SKILL_FIRST_MODE', 'on');
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  service = new ExecutableSkills(db, dir);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('executable package admission and reuse', () => {
  it('runs real local Node code/tests, captures a candidate, and reuses an approved fixture in two native tasks', () => {
    const p = writePackage();
    const run = spawnSync(process.execPath, [path.join(p.directory, 'run.mjs')], { input: '{"value":4}', encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
    expect(run.status, run.stderr).toBe(0); expect(JSON.parse(run.stdout)).toEqual({ value: 5 });
    const tests = spawnSync(process.execPath, ['--test', path.join(p.directory, 'run.test.mjs')], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
    expect(tests.status, tests.stderr).toBe(0); expect(tests.stdout).toContain('pass 1');
    const candidate = capture('increment-v1-0-0');
    expect(candidate.status).toBe('candidate'); expect(candidate.live_route_allowed).toBe(false);
    expect(() => new SwarmIntelligenceService(db).promoteCapability(candidate.id, { eval_score: 1, evidence_refs: ['fixture-test-receipt'] })).toThrow('CAPABILITY_PROMOTION_SKILL_BASELINE_REQUIRED');
    expect(new SwarmIntelligenceService(db).getCapability(candidate.id).status).toBe('candidate');
    expect(() => service.compose([selection(candidate.id)], ['Bash'], { value: 4 })).toThrow('SKILL_NOT_APPROVED');
    fixtureApprove(candidate.id);
    for (const id of ['reuse-one', 'reuse-two']) {
      const created = createNativeTask(db, { id, title: 'Reuse local package', description: 'Increment a value', metadata: { skill_execution: { selected: [selection(candidate.id)], tools: ['Bash'], input: { value: 4 } } } });
      expect(created.description).toContain('node --test');
      expect(created.description).toContain('.djimitflo/skills/increment-v1-0-0/run.mjs');
      expect(created.description).not.toContain(p.directory);
      expect(created.metadata).toMatchObject({ skillId: 'increment-v1-0-0', skill_package_receipts: [selection(candidate.id)] });
    }
    expect(db.prepare('SELECT COUNT(*) n FROM tasks WHERE id LIKE ?').get('reuse-%')).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) n FROM swarm_capabilities').get()).toEqual({ n: 1 });
  });

  it('materializes only the selected hash-bound payload in a second workspace and executes the same package', () => {
    const original = writePackage();
    writePackage('unselected-v1-0-0');
    const loaded = service.load('increment-v1-0-0');
    const candidate = capture('increment-v1-0-0'); fixtureApprove(candidate.id);
    const composed = service.compose([selection(candidate.id)], ['Bash'], { value: 4 });
    expect(composed.instructions).not.toContain(original.directory);
    expect(composed.instructions).not.toContain('unselected-v1-0-0');
    expect(composed.instructions).toContain(JSON.stringify(loaded.payload));
    const workspace = path.join(dir, 'runtime-workspace');
    const relativePackage = '.djimitflo/skills/increment-v1-0-0';
    const materialized = path.join(workspace, relativePackage);
    fs.mkdirSync(materialized, { recursive: true });
    expect(Object.keys(loaded.payload).sort()).toEqual([...Object.keys(loaded.contract.files), 'skill.contract.json'].sort());
    for (const [file, content] of Object.entries(loaded.payload)) {
      const target = path.join(materialized, file);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
    }
    for (const [file, expectedHash] of Object.entries(loaded.contract.files)) {
      const bytes = fs.readFileSync(path.join(materialized, file));
      expect(hash(bytes)).toBe(expectedHash);
      expect(bytes.equals(fs.readFileSync(path.join(original.directory, file)))).toBe(true);
    }
    const run = spawnSync(process.execPath, [`${relativePackage}/run.mjs`], { cwd: workspace, input: '{"value":4}', encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
    expect(run.status, run.stderr).toBe(0); expect(JSON.parse(run.stdout)).toEqual({ value: 5 });
    const tests = spawnSync(process.execPath, ['--test', `${relativePackage}/run.test.mjs`], { cwd: workspace, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
    expect(tests.status, tests.stderr).toBe(0); expect(tests.stdout).toContain('pass 1');
  });

  it('rejects oversized individual and combined selected package payloads', () => {
    const paddedPackage = (id: string, size: number) => {
      const p = writePackage(id);
      const script = path.join(p.directory, 'run.mjs');
      fs.appendFileSync(script, `\n/*${'x'.repeat(size)}*/`);
      p.contract.files['run.mjs'] = hash(fs.readFileSync(script));
      fs.writeFileSync(path.join(p.directory, 'skill.contract.json'), JSON.stringify(p.contract));
      return p;
    };
    paddedPackage('oversized-v1-0-0', 65000);
    expect(() => service.load('oversized-v1-0-0')).toThrow('SKILL_CONTEXT_TOO_LARGE');
    const selected = ['first-v1-0-0', 'second-v1-0-0', 'third-v1-0-0'].map(id => {
      paddedPackage(id, 45000);
      expect(Buffer.byteLength(JSON.stringify(service.load(id).payload))).toBeLessThan(64000);
      const candidate = capture(id); fixtureApprove(candidate.id); return selection(candidate.id);
    });
    expect(() => service.compose(selected, ['Bash'], { value: 1 })).toThrow('SKILL_CONTEXT_TOO_LARGE');
  });

  it('permits explicit verification inspection without granting default admission or registry approval', () => {
    writePackage();
    vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', 'unrelated');
    const inspected = service.load('increment-v1-0-0', { candidateForVerification: true });
    expect(inspected.contract.id).toBe('increment-v1-0-0');
    expect(inspected.payload['run.mjs']).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) n FROM agent_skills').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM swarm_capabilities').get()).toEqual({ n: 0 });
    expect(() => service.load('increment-v1-0-0')).toThrow('SKILL_NOT_ADMITTED');
    task('inspection-source'); evidence('inspection-source', inspected.contentHash);
    expect(() => service.capture('increment-v1-0-0', 'inspection-source', 'fixture')).toThrow('SKILL_NOT_ADMITTED');
    expect(db.prepare('SELECT COUNT(*) n FROM swarm_capabilities').get()).toEqual({ n: 0 });
    // Even a pre-approved registry fixture cannot override the operator allowlist.
    vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', '');
    const candidate = capture('increment-v1-0-0'); fixtureApprove(candidate.id);
    vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', 'unrelated');
    const before = db.prepare('SELECT * FROM swarm_capabilities').all();
    service.load('increment-v1-0-0', { candidateForVerification: true });
    expect(() => service.compose([selection(candidate.id)], ['Bash'], { value: 1 })).toThrow('SKILL_NOT_ADMITTED');
    expect(db.prepare('SELECT * FROM swarm_capabilities').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) n FROM agent_skills').get()).toEqual({ n: 0 });
  });

  it('blocks candidate capture while off or shadow despite a valid completed-task receipt', () => {
    writePackage(); const loaded = service.load('increment-v1-0-0');
    task('disabled-capture'); evidence('disabled-capture', loaded.contentHash);
    for (const mode of ['off', 'shadow']) {
      vi.stubEnv('SKILL_FIRST_MODE', mode);
      expect(() => service.capture('increment-v1-0-0', 'disabled-capture', 'fixture')).toThrow('SKILL_FIRST_EXECUTION_DISABLED');
      expect(db.prepare('SELECT COUNT(*) n FROM swarm_capabilities').get()).toEqual({ n: 0 });
    }
  });

  it('admits a newly approved package after engine construction and records its current delivered hash', () => {
    const engine = new ExecutionEngine(db, undefined, dir);
    const boundary = engine as unknown as {
      blockInvalidSkillAttribution(task: ReturnType<typeof createNativeTask>): string | null;
      recordSkillDeliveryReceipt(task: ReturnType<typeof createNativeTask>, runtime: string): void;
      recordSkillOutcome(taskId: string, session: undefined, completed: boolean, durationMs: number, tokens: number | null): void;
    };
    writePackage(); const candidate = capture('increment-v1-0-0'); fixtureApprove(candidate.id);
    const created = createNativeTask(db, { id: 'late-package', title: 'late package', description: 'run', metadata: { skill_execution: { selected: [selection(candidate.id)], tools: ['Bash'], input: { value: 1 } } } });
    expect(boundary.blockInvalidSkillAttribution(created)).toBeNull();
    boundary.recordSkillDeliveryReceipt(created, 'codex');
    const receipt = db.prepare("SELECT details FROM execution_evidence WHERE task_id=? AND json_extract(metadata, '$.reason')='skill_delivery_receipt'").get(created.id) as { details: string };
    expect(JSON.parse(receipt.details)).toMatchObject({ skill_id: 'increment-v1-0-0', skill_content_hash: service.load('increment-v1-0-0').skill.contentHash, delivery_state: 'delivered', delivered_sha256: hash(service.load('increment-v1-0-0').skill.instructions) });
    boundary.recordSkillOutcome(created.id, undefined, true, 25, null);
    expect(db.prepare('SELECT skill_id,skill_content_hash,tokens_used,success FROM skill_outcomes WHERE task_id=?').get(created.id)).toEqual({ skill_id: 'increment-v1-0-0', skill_content_hash: service.load('increment-v1-0-0').skill.contentHash, tokens_used: null, success: 0 });
    vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', 'unrelated');
    expect(() => boundary.blockInvalidSkillAttribution(created)).toThrow('SKILL_NOT_ADMITTED');
  });

  it('checks every selected composite package assignment without requiring a false single-skill attribution', () => {
    const engine = new ExecutionEngine(db, undefined, dir);
    const boundary = engine as unknown as {
      blockInvalidSkillAttribution(task: ReturnType<typeof createNativeTask>): string | null;
      recordSkillOutcome(taskId: string, session: undefined, completed: boolean, durationMs: number, tokens: number | null): void;
    };
    db.prepare("INSERT INTO agents(id,name,description,status,capabilities) VALUES ('composite-agent','Composite fixture','fixture','idle','[]')").run();
    const ids = ['first-v1-0-0', 'second-v1-0-0'];
    const selected = ids.map(id => {
      writePackage(id); const candidate = capture(id); fixtureApprove(candidate.id);
      db.prepare('INSERT INTO agent_skills(agent_id,skill_id,enabled) VALUES (?,?,1)').run('composite-agent', id);
      return selection(candidate.id);
    });
    const created = createNativeTask(db, { id: 'composite-package', title: 'composite', description: 'run', agent_id: 'composite-agent', metadata: { skill_execution: { selected, tools: ['Bash'], input: { value: 1 } } } });
    expect(created.metadata?.skillId).toBeUndefined();
    expect(created.metadata?.skill_package_ids).toEqual(ids);
    expect(boundary.blockInvalidSkillAttribution(created)).toBeNull();
    boundary.recordSkillOutcome(created.id, undefined, true, 25, 10);
    expect(db.prepare('SELECT COUNT(*) n FROM skill_outcomes WHERE task_id=?').get(created.id)).toEqual({ n: 0 });
    db.prepare('DELETE FROM agent_skills WHERE agent_id=? AND skill_id=?').run('composite-agent', ids[1]);
    expect(boundary.blockInvalidSkillAttribution(created)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) n FROM skill_outcomes WHERE task_id=?').get(created.id)).toEqual({ n: 0 });
  });

  it('discovers SQL metadata without opening instructions or package files', () => {
    writePackage(); const c = capture('increment-v1-0-0');
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Discovery must not open files'); });
    expect(service.discover('increment-number')).toEqual([expect.objectContaining({ capability_id: c.id, available: false, version: '1.0.0' })]);
    expect(read).not.toHaveBeenCalled();
  });

  it('requires a completed task and a system/info receipt bound to the exact package hash', () => {
    writePackage(); const p = service.load('increment-v1-0-0'); task('source', 'running');
    expect(() => service.capture('increment-v1-0-0', 'source', 'fixture')).toThrow('SKILL_VERIFIED_TASK_REQUIRED');
    evidence('source', p.contentHash); expect(() => service.capture('increment-v1-0-0', 'source', 'fixture')).toThrow('SKILL_VERIFIED_TASK_REQUIRED');
    db.prepare("UPDATE tasks SET status='completed' WHERE id='source'").run();
    evidence('source', p.contentHash, 'agent'); expect(() => service.capture('increment-v1-0-0', 'source', 'fixture')).toThrow('SKILL_VERIFIED_TASK_REQUIRED');
    evidence('source', p.contentHash, 'system', 'warning'); expect(() => service.capture('increment-v1-0-0', 'source', 'fixture')).toThrow('SKILL_VERIFIED_TASK_REQUIRED');
    evidence('source', '0'.repeat(64)); expect(() => service.capture('increment-v1-0-0', 'source', 'fixture')).toThrow('SKILL_VERIFICATION_PACKAGE_MISMATCH');
    evidence('source', p.contentHash); expect(service.capture('increment-v1-0-0', 'source', 'fixture').status).toBe('candidate');
  });

  it('rejects changed bytes, escaping symlinks, and reusing one version for different package content', () => {
    const p = writePackage(); const candidate = capture('increment-v1-0-0'); fixtureApprove(candidate.id);
    fs.appendFileSync(path.join(p.directory, 'run.mjs'), '\n// changed\n');
    expect(() => service.compose([selection(candidate.id)], ['Bash'], { value: 1 })).toThrow('SKILL_FILE_CHANGED');
    writePackage('increment-v1-0-0', { examples: [{ input: { value: 5 }, output: { value: 6 } }] });
    const changed = service.load('increment-v1-0-0'); task('changed'); evidence('changed', changed.contentHash);
    expect(() => service.capture('increment-v1-0-0', 'changed', 'fixture')).toThrow('SKILL_VERSION_CONFLICT');
    fs.unlinkSync(path.join(p.directory, 'run.mjs')); fs.writeFileSync(path.join(dir, 'outside.mjs'), '// outside'); fs.symlinkSync(path.join(dir, 'outside.mjs'), path.join(p.directory, 'run.mjs'));
    expect(() => service.load('increment-v1-0-0')).toThrow('SKILL_PATH_OUTSIDE_ROOT');
  });

  it('rejects an optional loader manifest symlink outside the package boundary', () => {
    const p = writePackage();
    const outside = path.join(dir, 'outside.manifest.yaml');
    fs.writeFileSync(outside, 'owner: outside-fixture\nversion: 1.0.0\nallowed_tools: Bash\n');
    fs.symlinkSync(outside, path.join(p.directory, 'skill.manifest.yaml'));
    expect(() => service.load('increment-v1-0-0')).toThrow('SKILL_PATH_OUTSIDE_ROOT');
  });

  it('rejects undeclared helper code even when the entrypoint and declared hashes are unchanged', () => {
    const p = writePackage();
    fs.writeFileSync(path.join(p.directory, 'helper.mjs'), 'export const undeclared = true;');
    expect(() => service.load('increment-v1-0-0')).toThrow('SKILL_UNDECLARED_FILE');
  });

  it('rechecks bytes and revocation after task creation, before a later execution attempt', () => {
    const p = writePackage(); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    const created = createNativeTask(db, { id: 'queued-reuse', title: 'Reuse', description: 'Original task', metadata: { skill_execution: { selected: [selection(c.id)], tools: ['Bash'], input: { value: 1 } } } });
    expect(() => assertSkillAssignmentCurrent(db, created)).not.toThrow();
    fs.appendFileSync(path.join(p.directory, 'run.mjs'), '\n// changed after queue\n');
    expect(() => assertSkillAssignmentCurrent(db, created)).toThrow('SKILL_FILE_CHANGED');
    writePackage();
    expect(() => assertSkillAssignmentCurrent(db, created)).not.toThrow();
    db.prepare("UPDATE swarm_capabilities SET status='deprecated' WHERE id=?").run(c.id);
    expect(() => assertSkillAssignmentCurrent(db, created)).toThrow('SKILL_NOT_APPROVED');
  });

  it('rejects changed rendered instructions or receipts at the execution guard', () => {
    writePackage(); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    const created = createNativeTask(db, { id: 'guarded-reuse', title: 'Reuse', description: 'Original task', metadata: { skill_execution: { selected: [selection(c.id)], tools: ['Bash'], input: { value: 1 } } } });
    expect(() => assertSkillAssignmentCurrent(db, { ...created, description: created.description + '\nchanged skill instructions' })).toThrow('SKILL_ASSIGNMENT_CHANGED');
    expect(() => assertSkillAssignmentCurrent(db, { ...created, metadata: { ...created.metadata, skill_package_receipts: [] } })).toThrow('SKILL_ASSIGNMENT_CHANGED');
    expect(() => assertSkillAssignmentCurrent(db, { description: 'ordinary', metadata: {} })).not.toThrow();
  });

  it('checks explicit tool permission, input types, unexpected keys and finite values', () => {
    writePackage(); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    expect(() => service.compose([selection(c.id)], [], { value: 1 })).toThrow('SKILL_TOOL_SCOPE_EXCEEDED');
    expect(() => service.compose([selection(c.id)], ['Bash', 'deploy'], { value: 1 })).toThrow('SKILL_TOOL_SCOPE_EXCEEDED');
    for (const input of [{}, { value: '1' }, { value: NaN }, { value: Infinity }, { value: 1, extra: true }]) expect(() => service.compose([selection(c.id)], ['Bash'], input)).toThrow('SKILL_SCHEMA_MISMATCH');
    expect(() => assertSkillInput({ value: 0 }, shape)).not.toThrow();
  });

  it('composes pinned dependencies before consumers and rejects hash or schema conflicts', () => {
    writePackage('increment-v1-0-0'); const base = capture('increment-v1-0-0'); fixtureApprove(base.id);
    writePackage('second-v1-0-0', { dependencies: [selection(base.id)] }); const second = capture('second-v1-0-0'); fixtureApprove(second.id);
    const composed = service.compose([selection(second.id)], ['Bash'], { value: 1 });
    expect(composed.receipts.map((r) => r.capability_id)).toEqual([base.id, second.id]);
    expect(composed.instructions.indexOf('Skill increment-v1-0-0@')).toBeLessThan(composed.instructions.indexOf('Skill second-v1-0-0@'));
    expect(() => service.compose([{ capability_id: second.id, content_hash: 'f'.repeat(64) }], ['Bash'], { value: 1 })).toThrow('SKILL_DEPENDENCY_CHANGED');
    writePackage('stringer-v1-0-0', { input: { type: 'object', properties: { value: 'string' }, required: ['value'] }, examples: [{ input: { value: '1' }, output: { value: 2 } }] });
    const incompatible = capture('stringer-v1-0-0'); fixtureApprove(incompatible.id);
    expect(() => service.compose([selection(base.id), selection(incompatible.id)], ['Bash'], { value: 1 })).toThrow('SKILL_COMPOSITION_SCHEMA_MISMATCH');
  });

  it('rejects a cyclic registry dependency fixture without executing any package', () => {
    writePackage('increment-v1-0-0'); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    // A corrupt preexisting registry fixture, not a legitimately approved cyclic package.
    const metadata = { ...c.metadata, executable_skill: { ...(c.metadata.executable_skill as ExecutableSkillContract), dependencies: [selection(c.id)] } };
    db.prepare('UPDATE swarm_capabilities SET metadata=? WHERE id=?').run(JSON.stringify(metadata), c.id);
    expect(() => service.compose([selection(c.id)], ['Bash'], { value: 1 })).toThrow('SKILL_DEPENDENCY_CYCLE');
  });

  it('rejects unversioned IDs and a physical directory whose suffix disagrees with the contract version', () => {
    writePackage('unversioned');
    expect(() => service.load('unversioned')).toThrow('SKILL_VERSIONED_ID_REQUIRED');
    writePackage('mismatch-v1-0-0', { version: '2.0.0' });
    expect(() => service.load('mismatch-v1-0-0')).toThrow('SKILL_VERSIONED_ID_REQUIRED');
  });

  it('preserves old executable bytes when versions use separate immutable package directories', () => {
    const oldPackage = writePackage('increment-v1-0-0'); const old = capture('increment-v1-0-0'); fixtureApprove(old.id);
    const newPackage = writePackage('increment-v2-0-0', { version: '2.0.0' }, 2); const next = capture('increment-v2-0-0'); fixtureApprove(next.id);
    const versions = service.discover('increment-number');
    expect(versions.map((v) => v.version)).toEqual(['1.0.0', '2.0.0']);
    for (const [p, expected] of [[oldPackage, 2], [newPackage, 3]] as const) {
      const executed = spawnSync(process.execPath, [path.join(p.directory, 'run.mjs')], { input: '{"value":1}', encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
      expect(executed.status, executed.stderr).toBe(0); expect(JSON.parse(executed.stdout)).toEqual({ value: expected });
    }
    expect(service.compose([selection(old.id)], ['Bash'], { value: 1 }).instructions).toContain('Skill increment-v1-0-0@1.0.0');
    expect(service.compose([selection(next.id)], ['Bash'], { value: 1 }).instructions).toContain('Skill increment-v2-0-0@2.0.0');
    db.prepare("UPDATE swarm_capabilities SET status='deprecated' WHERE id=?").run(next.id);
    expect(() => service.compose([selection(next.id)], ['Bash'], { value: 1 })).toThrow('SKILL_NOT_APPROVED');
    expect(() => service.compose([selection(old.id)], ['Bash'], { value: 1 })).not.toThrow();
  });

  it('requests bounded implementation only once, then prefers the existing candidate and approved package', () => {
    const first = service.request('increment-number', 'Implement increment over finite JSON numbers', 'fixture-owner');
    const again = service.request('increment-number', 'Same gap requested again', 'fixture-owner');
    expect(first.status).toBe('implementation_required'); expect(again).toEqual(first);
    expect(db.prepare("SELECT status, json_extract(metadata, '$.skill_factory_waiting_for_prepare') waiting FROM goals").get()).toEqual({ status: 'blocked', waiting: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM goals').get()).toEqual({ n: 1 });
    writePackage(); const c = capture('increment-v1-0-0');
    expect(service.request('increment-number', 'Use the package', 'fixture-owner').status).toBe('awaiting_promotion');
    fixtureApprove(c.id);
    expect(service.request('increment-number', 'Reuse the package', 'fixture-owner').status).toBe('available');
    expect(db.prepare('SELECT COUNT(*) n FROM goals').get()).toEqual({ n: 1 });
  });

  it('requests a new immutable version after retirement without reusing completed work', () => {
    const first = service.request('increment-number', 'Implement', 'fixture-owner');
    if (first.status !== 'implementation_required') throw new Error('missing goal');
    writePackage('increment-number-v1-0-0');
    const old = capture('increment-number-v1-0-0');
    db.prepare("UPDATE swarm_capabilities SET status='disabled' WHERE id=?").run(old.id);
    db.prepare("UPDATE goals SET status='completed' WHERE id=?").run(first.goal_id);
    const next = service.request('increment-number', 'Replace retired package', 'fixture-owner');
    expect(next.status).toBe('implementation_required');
    if (next.status !== 'implementation_required') throw new Error('missing replacement');
    expect(next.goal_id).not.toBe(first.goal_id);
    const goal = new GoalService(db).getGoalById(next.goal_id);
    expect(goal.metadata.skill_factory_package_id).toBe('increment-number-v1-0-1');
    expect(goal.acceptance_criteria.join(' ')).toContain('version=1.0.1');
    expect(service.request('increment-number', 'Repeat replacement', 'fixture-owner')).toEqual(next);
    expect(new SwarmIntelligenceService(db).getCapability(old.id).status).toBe('disabled');
  });

  it('bounds logical capability names so generated versioned package IDs remain admissible', () => {
    expect(() => service.request('x'.repeat(74), 'bounded task', 'fixture')).toThrow('SKILL_CAPABILITY_NAME_TOO_LONG');
    expect(db.prepare('SELECT COUNT(*) n FROM goals').get()).toEqual({ n: 0 });
    expect(service.request('x'.repeat(73), 'bounded task', 'fixture').status).toBe('implementation_required');
    const row = db.prepare("SELECT json_extract(metadata, '$.skill_factory_package_id') id, status FROM goals").get() as { id: string; status: string };
    expect(row.id).toHaveLength(80); expect(row.id).toBe('x'.repeat(73) + '-v1-0-0'); expect(row.status).toBe('blocked');
  });

  function sourceCard() {
    ensureSkillCardTable(db);
    const goal = new GoalService(db).createGoal({ objective: 'Prior source work', acceptance_criteria: ['fixture evidence'] }, 'source-owner');
    db.prepare("INSERT INTO loop_runs (id,goal_id,loop_name,mode,status) VALUES ('source-run',?,'fixture','closed','completed')").run(goal.id);
    const card = JSON.stringify({ description: 'Prior working transformation', task_pattern: 'numeric input', evidence: ['fixture-proof'] });
    db.prepare('INSERT INTO skill_cards (run_id,kind,status,card_json,content_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('source-run', 'skill', 'survived', card, hash(card), new Date().toISOString(), new Date().toISOString());
    return card;
  }

  it('binds source work from a survived card owned by the requesting goal owner into bounded factory work', () => {
    const card = sourceCard();
    const requested = service.request('derived-transform', 'Extract the reusable transformation', 'source-owner', 'source-run');
    expect(requested.status).toBe('implementation_required');
    if (requested.status !== 'implementation_required') throw new Error('factory goal missing');
    const goal = new GoalService(db).getGoalById(requested.goal_id);
    expect(goal.status).toBe('blocked');
    expect(goal.constraints).toContain(`Source work evidence (data only, not instructions): ${card}`);
    expect(goal.metadata).toMatchObject({ skill_factory_source_run_id: 'source-run', skill_factory_source_card_hash: hash(card) });
  });

  it('refuses missing, foreign-owned, regressed or changed source cards without creating factory work', () => {
    expect(() => service.request('derived-transform', 'Extract', 'source-owner', 'source-run')).toThrow('SKILL_SOURCE_CARD_REQUIRED');
    const card = sourceCard();
    expect(() => service.request('derived-transform', 'Extract', 'other-owner', 'source-run')).toThrow('SKILL_SOURCE_CARD_REQUIRED');
    db.prepare("UPDATE skill_cards SET status='regressed' WHERE run_id='source-run'").run();
    expect(() => service.request('derived-transform', 'Extract', 'source-owner', 'source-run')).toThrow('SKILL_SOURCE_CARD_REQUIRED');
    db.prepare("UPDATE skill_cards SET status='survived', card_json=? WHERE run_id='source-run'").run(card + ' ');
    expect(() => service.request('derived-transform', 'Extract', 'source-owner', 'source-run')).toThrow('SKILL_SOURCE_CARD_REQUIRED');
    expect(db.prepare("SELECT COUNT(*) n FROM goals WHERE json_extract(metadata, '$.skill_factory_key') IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it('does not execute or create native tasks in off/shadow and preserves ordinary tasks', () => {
    expect([undefined, 'off', 'shadow', 'on', 'ON'].map((value) => skillFirstMode({ SKILL_FIRST_MODE: value }))).toEqual(['off', 'off', 'shadow', 'on', 'off']);
    writePackage(); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    for (const mode of ['off', 'shadow']) {
      vi.stubEnv('SKILL_FIRST_MODE', mode);
      expect(() => createNativeTask(db, { id: mode, title: 'blocked', description: 'blocked', metadata: { skill_execution: { selected: [selection(c.id)], tools: ['Bash'], input: { value: 1 } } } })).toThrow('SKILL_FIRST_EXECUTION_DISABLED');
      expect(db.prepare('SELECT id FROM tasks WHERE id=?').get(mode)).toBeUndefined();
      expect(service.request('missing-capability', 'Implement a bounded transformation', 'fixture').status).toBe('discovery_only');
    }
    const ordinary = createNativeTask(db, { id: 'ordinary', title: 'ordinary', description: 'unchanged description', metadata: {} });
    expect(ordinary.description).toBe('unchanged description');
  });
});

// Adapter-boundary tests: real task persistence and skill rendering; engine/provider execution is deliberately stubbed.
describe('loop runtime dispatch receives the package before engine policy assessment', () => {
  async function dispatch(runtime: string, role = 'maker') {
    writePackage(); const c = capture('increment-v1-0-0'); fixtureApprove(c.id);
    const request = { selected: [selection(c.id)], tools: ['Bash'], input: { value: 3 } };
    const lease = { id: 'lease-fixture', role, runtime, metadata: { skill_execution: request } } as unknown as WorkerLeaseRecord;
    const goal = new GoalService(db).createGoal({ objective: 'Fixture factory goal', acceptance_criteria: ['fixture only'], metadata: { skill_factory_key: 'fixture-factory' } }, 'fixture-goal-owner');
    const run = { id: 'run-fixture', loop_name: 'test-fixture', goal_id: goal.id } as LoopRunRecord;
    const loop = { buildNestedSpawnEnv: () => ({}), isHighRiskRun: () => false, patchWorkerLeaseMetadata: vi.fn(), updateWorkerLeaseStatus: vi.fn() } as unknown as LoopService;
    const executeTask = vi.fn(async (taskId: string, kind: string, _actor: unknown, options: { riskAssessmentText: string }) => {
      const row = db.prepare('SELECT description, metadata, owner_user_id FROM tasks WHERE id=?').get(taskId) as { description: string; metadata: string; owner_user_id: string | null };
      expect(kind).toBe(runtime);
      expect(row.owner_user_id).toBe('fixture-goal-owner');
      if (role === 'maker') {
        expect(row.description).toContain('Skill increment-v1-0-0@1.0.0');
        expect(options.riskAssessmentText).toContain('Skill increment-v1-0-0@1.0.0');
        expect(JSON.parse(row.metadata)).toMatchObject({ skill_package_receipts: [selection(c.id)], skillId: 'increment-v1-0-0' });
      } else {
        expect(row.description).toBe('Original assignment');
        expect(options.riskAssessmentText).toBe('Original risk context');
        expect(JSON.parse(row.metadata)).not.toHaveProperty('skill_package_receipts');
      }
      return { status: 'running', completion: Promise.resolve({ status: 'completed', message: 'fixture provider boundary', stdout: 'fixture', exitCode: 0 }) };
    });
    const workers = new LoopWorkerExecutorService(db, loop, { executeTask } as unknown as ExecutionEngine);
    const invoke = workers as unknown as { executeViaEngine: (r: LoopRunRecord, l: WorkerLeaseRecord, runtime: string, prompt: string, cwd: string, timeout: number, skipPermissions: boolean, risk: string) => Promise<{ exitCode: number }> };
    const result = await invoke.executeViaEngine(run, lease, runtime, 'Original assignment', dir, 1000, false, 'Original risk context');
    expect(result.exitCode).toBe(0); expect(executeTask).toHaveBeenCalledOnce();
  }
  it.each(['codex', 'opencode', 'claude', 'gemini', 'pi', 'editor'])('renders the exact skill receipt for %s maker dispatch', async (runtime) => { await dispatch(runtime); });
  it('does not inject maker-selected skill instructions into checker assignments', async () => { await dispatch('codex', 'checker'); });
});
