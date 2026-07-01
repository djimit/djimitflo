import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MARLService } from '../services/marl-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let marl: MARLService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  marl = new MARLService(db);
});

afterEach(() => {
  db?.close();
});

describe('G66: Multi-Agent Reinforcement Learning', () => {
  it('updates policy on reward', () => {
    const policy = marl.updatePolicy('agent-1', 'action-a', 0.8);
    expect(policy.agentId).toBe('agent-1');
    expect(policy.policy['action-a']).toBeGreaterThan(0.5);
  });

  it('giveReward updates target policy', () => {
    marl.giveReward('agent-1', 'agent-2', 0.5, 'helped');
    const policy = marl.getPolicy('agent-2');
    expect(policy).not.toBeNull();
  });

  it('getPolicy returns null for unknown', () => {
    expect(marl.getPolicy('unknown')).toBeNull();
  });

  it('getAllPolicies returns sorted by reward', () => {
    marl.updatePolicy('high', 'a', 1.0);
    marl.updatePolicy('low', 'a', -0.5);
    const policies = marl.getAllPolicies();
    expect(policies[0].agentId).toBe('high');
  });

  it('getRewardHistory returns rewards', () => {
    marl.giveReward('a1', 'a2', 0.5, 'test');
    const history = marl.getRewardHistory('a2');
    expect(history.length).toBe(1);
  });

  it('getTopAgents returns best', () => {
    marl.updatePolicy('best', 'a', 1.0);
    marl.updatePolicy('worst', 'a', -1.0);
    const top = marl.getTopAgents(1);
    expect(top[0].agentId).toBe('best');
  });

  it('detectSpecialization finds specialists', () => {
    for (let i = 0; i < 10; i++) marl.updatePolicy('specialist', 'ts-fix', 0.9);
    const specs = marl.detectSpecialization();
    expect(specs.length).toBeGreaterThan(0);
  });

  it('policy converges with repeated rewards', () => {
    for (let i = 0; i < 50; i++) marl.updatePolicy('convergent', 'action', 0.8);
    const policy = marl.getPolicy('convergent');
    expect(policy!.policy['action']).toBeGreaterThan(0.7);
  });
});
