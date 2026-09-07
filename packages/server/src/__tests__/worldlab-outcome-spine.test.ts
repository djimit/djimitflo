import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { OutcomeLearningService } from '../services/outcome-learning-service';
import { WorkItemService } from '../services/work-item-service';
import { AgentInteractionLedgerService } from '../services/agent-interaction-ledger-service';

afterEach(() => vi.unstubAllGlobals());

describe('WorldLab to DjimitFlo outcome spine', () => {
  it('ingests replications, classifies evidence, creates an inert goal and exposes provenance', async () => {
    const db = createTestDb();
    const events = Array.from({ length: 30 }, (_, index) => ({
      _id: `${index + 1}-0`,
      event_id: `worldlab:trajectory-${index}:infection`, event_type: 'outcome.observed', source: 'openmythos-worldlab',
      outcome_id: `outcome-${index}`, subject_type: 'worldlab_treatment', subject_id: 'shared-memory-001',
      task_id: 'experiment-1', candidate_id: 'candidate:treatment', capability_id: 'provenance-checker',
      model_id: 'deterministic-synthetic', skill_hash: 'sha256:none', runtime_identity: 'git:test',
      metric: 'infection_probability', value: 0.20 + (index % 3) * 0.01, baseline: 0.58,
      direction: 'decrease', minimum_effect: 0.05, observation_window: 'trajectory:24h',
      evidence_refs: [`worldlab:trajectory-${index}`], confidence: 0.95, causal_status: 'randomized',
      experiment_id: 'experiment-1', trajectory_id: `trajectory-${index}`, finding_id: 'finding-1',
      condition: 'treatment', replication_id: `seed-${index}`, risk_class: 'medium', exploratory: true,
      observed_at: '2026-01-01T00:00:00+00:00', dedupe_key: `worldlab:trajectory-${index}:infection`,
    })).reverse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ events }), { status: 200 })));

    expect(await new ExternalEventIngestService(db, 'http://event-bus').pollOnce()).toBe(30);
    const loop = new ContinuousLearningLoop(db, { intervalMs: 999999999 });
    const cycle = await loop.runCycle();
    loop.stop();
    expect(cycle).toMatchObject({ outcomeAssessments: 1, outcomeWorkItemsCreated: 1 });
    expect(new OutcomeLearningService(db).list()[0]).toMatchObject({
      status: 'UNDETERMINED', signal_status: 'SUPPORTED', replications: 30, causal_support: false,
      result: { exploratory: true, required_next_gate: 'confirmatory_replication', promotion_eligible: false },
    });

    const item = db.prepare("SELECT id FROM work_items WHERE source = 'outcome_observed'").get() as { id: string };
    const converted = new WorkItemService(db).convertToGoal(item.id);
    const goal = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(converted.goal_id) as any;
    expect(goal.status).toBe('created');
    expect(JSON.parse(goal.metadata)).toMatchObject({
      source: 'outcome_observed', source_ref: expect.stringMatching(/^outcome-learning:/),
      falsification_tests: ['replicated confidence interval no longer supports the claimed effect'],
    });
    const interactions = new AgentInteractionLedgerService(db).list({ source: 'external_events' });
    expect(interactions).toHaveLength(30);
    expect(interactions.every((interaction) => interaction.effect_scope === 'simulated')).toBe(true);
    db.close();
  });
});
