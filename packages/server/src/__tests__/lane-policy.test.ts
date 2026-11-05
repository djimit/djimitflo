import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { canonicalJson } from '../services/fleet-event-signatures';
import { evaluateLanePolicy, laneDestination, lanePolicyEvidence, lanePolicyMode, LANE_POLICY, LANE_POLICY_HASH, recordLanePolicyShadow, resolveLaneClass } from '../services/lane-policy';

const env = {} as NodeJS.ProcessEnv;
const shadow = { LANE_POLICY_MODE: 'shadow' } as NodeJS.ProcessEnv;
const judgmentsDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE judgments (id TEXT PRIMARY KEY, judgment TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, state_hash TEXT NOT NULL,
    mode TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, answers_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE goals (id TEXT PRIMARY KEY, metadata TEXT); CREATE TABLE self_improvements (id TEXT PRIMARY KEY, evidence_refs_json TEXT);`);
  return db;
};
const run = (over: Record<string, unknown> = {}) => ({ id: 'run-1', goal_id: null, repository_path: null, metadata: {}, ...over });

describe('lane policy (pure)', () => {
  it('fail-closed: no class and an unknown repo, or an unrecognised class, is confidential', () => {
    expect(resolveLaneClass({})).toEqual({ cls: 'confidential', source: 'fail_closed' });
    expect(resolveLaneClass({ repo: 'acme/secret' })).toEqual({ cls: 'confidential', source: 'fail_closed' });
    expect(resolveLaneClass({ explicit: 'top-secret', repo: 'djimit/djimitflo' })).toEqual({ cls: 'confidential', source: 'fail_closed' });
    expect(resolveLaneClass({ explicit: 42 })).toEqual({ cls: 'confidential', source: 'fail_closed' });
  });

  it('class source: explicit field first, else the repo default (djimit/djimitflo = public)', () => {
    expect(resolveLaneClass({ repo: 'Djimit/DjimitFlo' })).toEqual({ cls: 'public', source: 'repo_default' });
    expect(resolveLaneClass({ explicit: ' Judicial ', repo: 'djimit/djimitflo' })).toEqual({ cls: 'judicial', source: 'explicit' });
  });

  it('derives the destination from the runtime and leaseIdentity model id', () => {
    expect(laneDestination('remote', 'remote:default', env)).toEqual({ destination: 'local', provider: 'remote' });
    expect(laneDestination('opencode', 'llama-router/qwen3-coder', env).destination).toBe('local');
    expect(laneDestination('opencode', 'ollama/glm-5.2:cloud', env)).toEqual({ destination: 'us_cloud', provider: 'ollama.com' });
    expect(laneDestination('remote', 'kimi-k3:cloud', env).destination).toBe('us_cloud');
    expect(laneDestination('claude', 'claude:default', env)).toEqual({ destination: 'us_cloud', provider: 'api.anthropic.com' });
    expect(laneDestination('codex', 'gpt-5', env)).toEqual({ destination: 'us_cloud', provider: 'api.openai.com' });
    expect(laneDestination('opencode', 'nvidia/nemotron', env).destination).toBe('us_cloud');
    expect(laneDestination('opencode', 'typesafe/jev', env).destination).toBe('unknown');
    expect(laneDestination('atomic', 'kimi-k3', env)).toEqual({ destination: 'us_cloud', provider: 'ollama.com' });
    expect(laneDestination('atomic', 'qwen', { ATOMIC_AGENT_BASE_URL: 'http://100.81.133.48:4000/v1' } as NodeJS.ProcessEnv).destination).toBe('local');
    expect(laneDestination('hermes', 'hermes:default', env).destination).toBe('unknown');
  });

  it('confidential and judicial: local providers only (workstation remote, local llama-router); never cloud, NVIDIA, OpenAI, Anthropic or TypeSafe', () => {
    for (const cls of ['confidential', 'judicial', 'restricted']) {
      expect(evaluateLanePolicy({ explicit: cls }, 'remote', 'remote:default', env).would_deny).toBe(false);
      expect(evaluateLanePolicy({ explicit: cls }, 'opencode', 'llama-router/qwen3-coder', env).would_deny).toBe(false);
      for (const [runtime, model] of [['opencode', 'ollama/glm-5.2:cloud'], ['opencode', 'nvidia/nemotron'], ['codex', 'gpt-5'], ['claude', 'claude:default'], ['opencode', 'typesafe/jev'], ['atomic', 'kimi-k3']]) {
        expect(evaluateLanePolicy({ explicit: cls }, runtime, model, env)).toMatchObject({ input_class: cls, would_deny: true, rule: `${cls}:local:no_external_network` });
      }
    }
  });

  it('public allows any destination; internal denies an unknown one', () => {
    expect(evaluateLanePolicy({ repo: 'djimit/djimitflo' }, 'claude', undefined, env)).toMatchObject({ input_class: 'public', class_source: 'repo_default', would_deny: false });
    expect(evaluateLanePolicy({ explicit: 'internal' }, 'claude', undefined, env).would_deny).toBe(false);
    expect(evaluateLanePolicy({ explicit: 'internal' }, 'opencode', 'typesafe/jev', env).would_deny).toBe(true);
  });

  it('the policy version is the sha256 of the canonical config', () => {
    expect(LANE_POLICY_HASH).toBe(createHash('sha256').update(canonicalJson(LANE_POLICY)).digest('hex'));
    expect(evaluateLanePolicy({}, 'remote', null, env).policy_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('LANE_POLICY_MODE', () => {
  it('defaults to off; only "shadow" enables it', () => {
    expect(lanePolicyMode(env)).toBe('off');
    expect(lanePolicyMode({ LANE_POLICY_MODE: 'on' } as NodeJS.ProcessEnv)).toBe('off');
    expect(lanePolicyMode({ LANE_POLICY_MODE: ' Shadow ' } as NodeJS.ProcessEnv)).toBe('shadow');
  });

  it('off touches nothing: no query, no row (works even without a judgments table)', () => {
    const db = new Database(':memory:');
    expect(recordLanePolicyShadow(db, run(), { id: 'lease-1', role: 'maker' }, 'claude', 'claude:default', env)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
  });

  it('shadow records one lane_policy judgment per dispatch with class, rule, runtime, would_deny and policy hash', () => {
    const db = judgmentsDb();
    db.prepare('INSERT INTO goals (id, metadata) VALUES (?, ?)').run('g1', JSON.stringify({ data_classification: 'judicial' }));
    const d = recordLanePolicyShadow(db, run({ goal_id: 'g1' }), { id: 'lease-1', role: 'maker' }, 'opencode', 'ollama/glm-5.2:cloud', shadow);
    expect(d).toMatchObject({ input_class: 'judicial', class_source: 'explicit', would_deny: true });
    recordLanePolicyShadow(db, run(), { id: 'lease-2', role: 'checker' }, 'remote', 'remote:default', shadow);
    const rows = db.prepare("SELECT * FROM judgments WHERE judgment = 'lane_policy' ORDER BY subject_id").all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ subject_type: 'worker_lease', subject_id: 'lease-1', mode: 'shadow', decision: 'would_deny', state_hash: LANE_POLICY_HASH });
    expect(JSON.parse(rows[0].answers_json)).toMatchObject({ input_class: 'judicial', rule: 'judicial:local:no_external_network', runtime: 'opencode', destination: 'us_cloud', role: 'maker', repo: 'djimit/djimitflo' });
    // the primary repo without an explicit class: public by the repo default
    expect(rows[1]).toMatchObject({ subject_id: 'lease-2', decision: 'would_allow' });
    expect(JSON.parse(rows[1].answers_json)).toMatchObject({ input_class: 'public', class_source: 'repo_default' });
    // run metadata wins over goal metadata
    expect(recordLanePolicyShadow(db, run({ goal_id: 'g1', metadata: { data_classification: 'public' } }), { id: 'lease-3', role: 'maker' }, 'claude', undefined, shadow))
      .toMatchObject({ input_class: 'public', would_deny: false });
    expect(lanePolicyEvidence(db, '1970-01-01', shadow)).toMatchObject({ mode: 'shadow', policy_hash: LANE_POLICY_HASH,
      by_class: [{ data_class: 'judicial', would_allow: 0, would_deny: 1 }, { data_class: 'public', would_allow: 2, would_deny: 0 }] });
  });

  it('shadow is fail-open: a database error returns null and never throws', () => {
    const db = new Database(':memory:');
    expect(recordLanePolicyShadow(db, run(), { id: 'lease-1', role: 'maker' }, 'claude', undefined, shadow)).toBeNull();
    expect(lanePolicyEvidence(db, '1970-01-01', env)).toMatchObject({ mode: 'off', by_class: null });
  });
});
