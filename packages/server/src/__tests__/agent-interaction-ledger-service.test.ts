import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { AgentInteractionLedgerService } from '../services/agent-interaction-ledger-service';
import { createTestDb } from './helpers/test-db';
import { SwarmEvidenceService } from '../services/swarm-evidence-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { ReflectionEngine } from '../services/reflection-engine';
import { DreamCycleService } from '../services/dream-cycle-service';
import { EmergentSpecializationService } from '../services/emergent-specialization-service';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  const insertAgent = db.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')");
  insertAgent.run('agent-a', 'Agent A');
  insertAgent.run('agent-b', 'Agent B');
});
afterEach(() => db.close());

describe('AgentInteractionLedgerService', () => {
  it('projects existing ledgers into a redacted actor-action-target timeline', () => {
    db.prepare(`INSERT INTO messages (id, from_agent_id, to_agent_id, type, payload, created_at)
      VALUES ('message-1', 'agent-a', 'agent-b', 'knowledge_share', ?, '2026-09-07T00:00:00Z')`)
      .run(JSON.stringify({ correlation_id: 'goal-1', evidence_refs: ['memory:1'], secret: 'must-not-leak' }));
    db.prepare(`INSERT INTO external_events (id, event_type, source, correlation_id, occurred_at, payload)
      VALUES ('outcome-1', 'outcome.observed', 'eve-v', 'goal-1', '2026-09-07T00:01:00Z', ?)`)
      .run(JSON.stringify({ subject_type: 'publication', subject_id: 'pub-1', capability_id: 'writer', model_id: 'm1', evidence_refs: ['report:1'], raw_prompt: 'private' }));

    const interactions = new AgentInteractionLedgerService(db).list({ correlation_id: 'goal-1' });
    expect(interactions).toHaveLength(2);
    expect(interactions[0]).toMatchObject({
      actor: { id: 'eve-v' }, action: 'outcome.observed', target: { type: 'publication', id: 'pub-1' }, effect_scope: 'isolated',
    });
    expect(interactions[1]).toMatchObject({
      actor: { id: 'agent-a' }, action: 'message.knowledge_share', target: { type: 'agent', id: 'agent-b' }, evidence_refs: ['memory:1'],
    });
    expect(JSON.stringify(interactions)).not.toContain('must-not-leak');
    expect(JSON.stringify(interactions)).not.toContain('private');
  });

  it('uses only explicit valid external-event scope and keeps WorldLab simulated', () => {
    const insert = db.prepare(`INSERT INTO external_events (id, event_type, source, correlation_id, occurred_at, payload)
      VALUES (?, ?, ?, 'scope-test', '2026-09-07T00:01:00Z', ?)`);
    insert.run('production', 'outcome.observed', 'eve-v', JSON.stringify({ effect_scope: 'production' }));
    insert.run('invalid', 'paperclip.issue.created', 'paperclip', JSON.stringify({ effect_scope: 'anything' }));
    insert.run('worldlab', 'worldlab.finding', 'worldlab', JSON.stringify({ effect_scope: 'production' }));

    const scopes = Object.fromEntries(new AgentInteractionLedgerService(db).list({ correlation_id: 'scope-test' })
      .map((item) => [item.id, item.effect_scope]));
    expect(scopes).toEqual({
      'external_events:worldlab': 'simulated',
      'external_events:production': 'production',
      'external_events:invalid': 'isolated',
    });
  });

  it('filters by agent without requiring every optional source table', () => {
    db.prepare(`INSERT INTO messages (id, from_agent_id, to_agent_id, type, payload)
      VALUES ('message-1', 'agent-a', 'agent-b', 'status_update', '{}')`).run();
    expect(new AgentInteractionLedgerService(db).list({ agent_id: 'agent-b' })).toEqual([
      expect.objectContaining({ source: 'messages', target: { type: 'agent', id: 'agent-b' } }),
    ]);
  });

  it('projects evidence lineage with allowlisted metadata only', () => {
    new SwarmEvidenceService(db).createEvidenceEdge('worldlab:finding-1', 'goal:goal-1', 'proposes', {
      correlation_id: 'experiment-1', effect_scope: 'simulated', secret: 'not-visible',
    });
    const result = new AgentInteractionLedgerService(db).list({ source: 'swarm_evidence_edges' });
    expect(result).toEqual([expect.objectContaining({
      actor: expect.objectContaining({ id: 'worldlab:finding-1' }), action: 'evidence.proposes',
      target: { type: 'evidence_ref', id: 'goal:goal-1' }, effect_scope: 'simulated',
    })]);
    expect(JSON.stringify(result)).not.toContain('not-visible');
  });

  it('makes questions, creative alternatives, learning and specialization visible', () => {
    new ReflectionEngine(db);
    new DreamCycleService(db);
    const specializations = new EmergentSpecializationService(db);
    new SwarmIntelligenceService(db).createClaim({
      claim: 'Knowledge gap: routing', claim_type: 'capability', subject_ref: 'routing', predicate: 'gap',
      confidence: 0.7, created_from: 'curiosity-service', metadata: { gap_type: 'coverage' },
    });
    db.prepare(`INSERT INTO reflections (id, loop_run_id, lessons_learned_json, proposed_improvements_json)
      VALUES ('reflection-1', 'run-1', '["use provenance"]', '["compare alternatives"]')`).run();
    db.prepare(`INSERT INTO dream_opportunities
      (id, capability_id, score, kind, title, rationale, suggested_action, status, dedupe_key)
      VALUES ('dream-1', 'routing', 0.7, 'evaluate', 'Evaluate routing', 'missing evidence', 'run comparison', 'proposed', 'dream-key-1')`).run();
    specializations.recordPerformance('agent-a', 'routing', 'maker', true);

    const actions = new AgentInteractionLedgerService(db).list({ limit: 100 }).map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining([
      'claim.gap', 'learning.reflection', 'alternative.evaluate', 'specialization.emerging',
    ]));
  });

  it('provides one fail-closed ecosystem view over components, repos, bots, routes and decisions', () => {
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('worldlab-bot', 'WorldLab Bot', 'idle')").run();
    db.prepare("UPDATE agents SET metadata = ? WHERE id = 'agent-a'").run(JSON.stringify({ ecosystem_component_id: 'paperclip' }));
    db.prepare(`INSERT INTO repositories (id, name, description, path, status, git_commit, metadata)
      VALUES ('openmythos-repo', 'openmythos-benchmark', 'evaluation', '/synthetic/openmythos', 'clean', 'abc123', ?)`)
      .run(JSON.stringify({ deployment_provenance: { status: 'VERIFIED', commit: 'def456', source_archive_sha256: 'sha256-source', image_digest: 'sha256-image', canonical_source_state: 'REVIEW_REQUIRED' } }));
    db.prepare(`INSERT INTO external_events (id, event_type, source, correlation_id, occurred_at, payload)
      VALUES ('finding-1', 'worldlab.finding', 'openmythos-worldlab', 'experiment-1', '2026-09-07T00:02:00Z', '{}')`).run();

    const service = new SwarmIntelligenceService(db);
    service.recordDecision({
      decision_type: 'gate',
      decision: 'hold_for_independent_retest',
      reason: 'Replication evidence exists but reviewer independence is unknown.',
      actor: 'architecture-council',
      evidence_refs: ['worldlab:finding-1'],
      blocked_reasons: ['reviewer_independence_unknown'],
    });

    const map = service.missionControl().ecosystem_map;
    expect(map.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worldlab', evidence_state: 'OBSERVED', registered_agents: ['worldlab-bot'] }),
      expect.objectContaining({ id: 'openmythos', evidence_state: 'REGISTERED', registered_repositories: ['openmythos-repo'] }),
    ]));
    expect(map.observed_routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'worldlab', to: 'djimitflo', observed_count: 1, effect_scopes: ['simulated'] }),
    ]));
    expect(map.declared_contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'contract:worldlab:djimitflo',
        evidence_state: 'OBSERVED',
        trace: expect.objectContaining({ effect_scopes: ['simulated'], evidence_refs: expect.arrayContaining(['external_events:finding-1']) }),
      }),
      expect.objectContaining({ id: 'contract:roborev:paperclip', evidence_state: 'UNDETERMINED', trace: null }),
    ]));
    expect(map.inventory.repositories[0]).toMatchObject({
      component_id: 'openmythos',
      mapping_basis: 'name_match',
      deployment_provenance: { status: 'VERIFIED', commit: 'def456', canonical_source_state: 'REVIEW_REQUIRED' },
    });
    expect(map.inventory.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worldlab-bot', component_id: 'worldlab', mapping_basis: 'name_match' }),
      expect.objectContaining({ id: 'agent-a', component_id: 'paperclip', mapping_basis: 'metadata' }),
    ]));
    expect(map.integrality).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'production_containment', state: 'PASS' }),
      expect.objectContaining({ dimension: 'repository_provenance', state: 'FAIL' }),
      expect.objectContaining({ dimension: 'reviewer_independence', state: 'UNDETERMINED' }),
    ]));
    db.prepare("UPDATE repositories SET metadata = ? WHERE id = 'openmythos-repo'")
      .run(JSON.stringify({ deployment_provenance: { status: 'VERIFIED', commit: 'abc123', canonical_source_state: 'REVIEW_REQUIRED' } }));
    expect(new SwarmIntelligenceService(db).missionControl().ecosystem_map.integrality).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'repository_provenance', state: 'PASS' }),
    ]));
    expect(map.decisions[0]).toMatchObject({
      decision: 'hold_for_independent_retest',
      rationale: 'Replication evidence exists but reviewer independence is unknown.',
      status: 'BLOCKED',
    });
    expect(map).not.toHaveProperty('score');
  });

  it('links converted integration work items to their goal loop without duplicate metadata', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO goals (id, objective, status, risk_class, created_at, updated_at)
      VALUES ('goal-integration', 'Reproduce interaction evidence', 'blocked', 'medium', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO work_items
      (id, title, description, source, source_ref, risk_class, status, recommended_loop, parent_goal_id, metadata, created_at, updated_at)
      VALUES ('work-integration', 'Reproduce evidence', 'Run a bounded reproduction', 'interaction_action',
        'interaction:request_reproduction', 'medium', 'planned', 'research-loop', 'goal-integration', ?, ?, ?)`).run(
      JSON.stringify({ integration: { source: 'interaction_action' } }), now, now
    );
    db.prepare(`INSERT INTO loop_runs
      (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('loop-integration', 'goal-integration', 'research-loop', 'closed', 'ready_for_human_merge',
        '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(now, now);

    expect(new SwarmIntelligenceService(db).missionControl().integration_spine.latest).toMatchObject({
      work_item: { id: 'work-integration' },
      goal_id: 'goal-integration',
      loop: { id: 'loop-integration', status: 'ready_for_human_merge' },
    });
  });
});
