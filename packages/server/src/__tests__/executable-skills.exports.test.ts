import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  ExecutableSkills,
  executableSkillContract,
  skillAssignment,
  type ExecutableSkillContract,
} from '../services/executable-skills';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const shape: ExecutableSkillContract['input'] = { type: 'object', properties: { value: 'number' }, required: ['value'] };

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-skill-exports-'));
  vi.stubEnv('DJIMITFLO_SKILLS_DIR', dir);
  vi.stubEnv('DJIMITFLO_SKILL_ALLOWLIST', '');
  vi.stubEnv('SKILL_FIRST_MODE', 'on');
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('executableSkillContract', () => {
  const files = {
    'SKILL.md': '# skill\n',
    'run.mjs': "process.stdout.write('{}')\n",
    'run.test.mjs': "import test from 'node:test'; test('ok', () => {});\n",
  };
  const base: ExecutableSkillContract = {
    format: 1,
    id: 'increment-v1-0-0',
    version: '1.0.0',
    capabilities: ['increment-number'],
    input: shape,
    output: shape,
    entrypoint: 'run.mjs',
    test: 'run.test.mjs',
    files: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, hash(c)])),
    dependencies: [],
    examples: [{ input: { value: 1 }, output: { value: 2 } }],
  };

  it('parses a well-formed contract', () => {
    expect(() => executableSkillContract.parse(base)).not.toThrow();
    expect(executableSkillContract.parse(base).id).toBe('increment-v1-0-0');
  });

  it('rejects malformed contracts: missing required key, absolute entrypoint, bad version, empty capabilities', () => {
    expect(() => executableSkillContract.parse({ ...base, input: { type: 'object', properties: { value: 'number' }, required: ['missing'] } })).toThrow();
    expect(() => executableSkillContract.parse({ ...base, entrypoint: '/etc/run.mjs' })).toThrow();
    expect(() => executableSkillContract.parse({ ...base, version: '1.0' })).toThrow();
    expect(() => executableSkillContract.parse({ ...base, capabilities: [] })).toThrow();
  });
});

describe('skillAssignment', () => {
  it('returns description and metadata unchanged when metadata has no skill_execution', () => {
    const out = skillAssignment(db, 'ordinary task', { foo: 'bar' });
    expect(out).toEqual({ description: 'ordinary task', metadata: { foo: 'bar' } });
  });

  it('throws SKILL_FIRST_EXECUTION_DISABLED when skill_first mode is off', () => {
    vi.stubEnv('SKILL_FIRST_MODE', 'off');
    expect(() =>
      skillAssignment(db, 'task', { skill_execution: { selected: [{ capability_id: 'x', content_hash: 'a'.repeat(64) }], tools: ['Bash'], input: {} } }),
    ).toThrow('SKILL_FIRST_EXECUTION_DISABLED');
  });

  it('throws when skill_execution is not the expected shape', () => {
    expect(() => skillAssignment(db, 'task', { skill_execution: { selected: [] } })).toThrow();
    expect(() => skillAssignment(db, 'task', { skill_execution: 'nope' })).toThrow();
  });

  function writePackage(id = 'increment-v1-0-0') {
    const directory = path.join(dir, id);
    fs.mkdirSync(directory, { recursive: true });
    const files = {
      'SKILL.md': `---\nname: ${id}\ndescription: Increment.\nversion: 1.0.0\nauthor: test\nallowed-tools: Bash\ndisallowed-tools: Network\n---\nRun package.\n`,
      'run.mjs': `import fs from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nexport function increment(i){return {value:i.value+1};}\nif (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.stdout.write(JSON.stringify(increment(JSON.parse(fs.readFileSync(0,'utf8')))));\n`,
      'run.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { increment } from './run.mjs';\ntest('ok', () => assert.deepEqual(increment({value:1}), {value:2}));\n`,
    };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(directory, f), c);
    const contract: ExecutableSkillContract = {
      format: 1, id, version: '1.0.0', capabilities: ['increment-number'], input: shape, output: shape,
      entrypoint: 'run.mjs', test: 'run.test.mjs',
      files: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, hash(c)])),
      dependencies: [], examples: [{ input: { value: 1 }, output: { value: 2 } }],
    };
    fs.writeFileSync(path.join(directory, 'skill.contract.json'), JSON.stringify(contract));
    return { directory, contract };
  }

  function captureAndApprove(id: string) {
    const p = new ExecutableSkills(db, dir).load(id);
    const taskId = randomUUID();
    db.prepare("INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode) VALUES (?, 'f', 'f', 'completed', 'low', 'low', 'review_only')").run(taskId);
    db.prepare(`INSERT INTO execution_evidence (id,task_id,evidence_type,severity,title,summary,details,source,captured_at) VALUES (?,?,'test_result','info','f','f',?,'system',?)`)
      .run(randomUUID(), taskId, JSON.stringify({ skill_package_hash: p.contentHash }), new Date().toISOString());
    const candidate = new ExecutableSkills(db, dir).capture(id, taskId, 'fixture-owner');
    db.prepare("UPDATE swarm_capabilities SET status='validated', eval_score=1 WHERE id=?").run(candidate.id);
    return candidate;
  }

  it('augments description and metadata with composed skill instructions for an approved package', () => {
    writePackage();
    const candidate = captureAndApprove('increment-v1-0-0');
    const c = new SwarmIntelligenceService(db).getCapability(candidate.id);
    const selection = { capability_id: candidate.id, content_hash: String(c.metadata.package_hash) };
    const out = skillAssignment(db, 'Increment a value', {
      skill_execution: { selected: [selection], tools: ['Bash'], input: { value: 4 } },
    });
    expect(out.description).toContain('## Selected executable skills');
    expect(out.description).toContain('node --test');
    expect(out.description).toContain('.djimitflo/skills/increment-v1-0-0/run.mjs');
    expect(out.metadata).toMatchObject({ skillId: 'increment-v1-0-0', skill_package_receipts: [selection] });
    expect(Array.isArray(out.metadata.skill_package_ids)).toBe(true);
  });

  it('throws SKILL_ATTRIBUTION_CONFLICT when metadata.skillId disagrees with the composed skill', () => {
    writePackage();
    const candidate = captureAndApprove('increment-v1-0-0');
    const c = new SwarmIntelligenceService(db).getCapability(candidate.id);
    const selection = { capability_id: candidate.id, content_hash: String(c.metadata.package_hash) };
    expect(() =>
      skillAssignment(db, 'Increment a value', {
        skillId: 'some-other-skill',
        skill_execution: { selected: [selection], tools: ['Bash'], input: { value: 4 } },
      }),
    ).toThrow('SKILL_ATTRIBUTION_CONFLICT');
  });
});