import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { knowledgeBus } from '../services/knowledge-bus';

let db: Database.Database;
let intelligence: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intelligence = new SwarmIntelligenceService(db);
});

afterEach(() => {
  db?.close();
  knowledgeBus.removeAllListeners();
  // Clear subscribers
  (knowledgeBus as any).subscribers.clear();
  (knowledgeBus as any).globalSubscribers.clear();
});

describe('G15: Cross-fleet knowledge bus', () => {
  it('publishes a claim when createClaim is called', () => {
    const received: any[] = [];
    knowledgeBus.subscribe('*', (claim) => received.push(claim));

    intelligence.createClaim({
      claim: 'The codex runtime is verified for maker tasks',
      claim_type: 'observation',
      subject_ref: 'runtime:codex',
      predicate: 'verified_for',
      object: 'maker',
      confidence: 0.9,
      status: 'supported',
      evidence_refs: ['proof:test'],
      verified_by_gate: 'proof_artifacts', created_from: 'test',
    });

    expect(received.length).toBe(1);
    expect(received[0].claim_id).toBeDefined();
    expect(received[0].predicate).toBe('verified_for');
    expect(received[0].confidence).toBe(0.9);
  });

  it('subscribers receive claims for their subscribed capability', () => {
    const capDebugging: any[] = [];
    const capFixing: any[] = [];
    knowledgeBus.subscribe('cap-debugging', (claim) => capDebugging.push(claim));
    knowledgeBus.subscribe('cap-fixing', (claim) => capFixing.push(claim));

    // Create a claim with capability_id in metadata.
    intelligence.createClaim({
      claim: 'Debug rule: check null guards',
      claim_type: 'memory',
      subject_ref: 'finding:debug-1',
      predicate: 'recommends',
      object: 'null_guard_check',
      confidence: 0.8,
      status: 'supported',
      evidence_refs: ['lease:1'],
      verified_by_gate: 'checker_verdict', created_from: 'test',
      metadata: { capability_id: 'cap-debugging' },
    });

    intelligence.createClaim({
      claim: 'Fix rule: use optional chaining',
      claim_type: 'memory',
      subject_ref: 'finding:fix-1',
      predicate: 'recommends',
      object: 'optional_chaining',
      confidence: 0.85,
      status: 'supported',
      evidence_refs: ['lease:2'],
      verified_by_gate: 'checker_verdict', created_from: 'test',
      metadata: { capability_id: 'cap-fixing' },
    });

    expect(capDebugging.length).toBe(1);
    expect(capDebugging[0].subject_ref).toBe('finding:debug-1');
    expect(capFixing.length).toBe(1);
    expect(capFixing[0].subject_ref).toBe('finding:fix-1');
  });

  it('unsubscribe stops receiving claims', () => {
    const received: any[] = [];
    const unsub = knowledgeBus.subscribe('*', (claim) => received.push(claim));

    intelligence.createClaim({
      claim: 'Test claim 1',
      claim_type: 'observation',
      subject_ref: 'test:1',
      predicate: 'is',
      object: 'test',
      confidence: 0.5,
      status: 'supported',
      evidence_refs: [],
      verified_by_gate: 'test', created_from: 'test',
    });
    expect(received.length).toBe(1);

    unsub();

    intelligence.createClaim({
      claim: 'Test claim 2',
      claim_type: 'observation',
      subject_ref: 'test:2',
      predicate: 'is',
      object: 'test',
      confidence: 0.5,
      status: 'supported',
      evidence_refs: [],
      verified_by_gate: 'test', created_from: 'test',
    });
    expect(received.length).toBe(1); // still 1 — unsubscribed
  });

  it('reports subscriber count for observability', () => {
    expect(knowledgeBus.getSubscriberCount()).toBe(0);
    const unsub1 = knowledgeBus.subscribe('cap-a', () => {});
    expect(knowledgeBus.getSubscriberCount()).toBe(1);
    const unsub2 = knowledgeBus.subscribe('*', () => {});
    expect(knowledgeBus.getSubscriberCount()).toBe(2);
    unsub1();
    expect(knowledgeBus.getSubscriberCount()).toBe(1);
    unsub2();
    expect(knowledgeBus.getSubscriberCount()).toBe(0);
  });
});
