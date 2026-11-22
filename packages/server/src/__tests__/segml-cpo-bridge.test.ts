import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlCpoBridge } from '../services/segml-cpo-bridge';
import { swarmEventBus } from '../services/swarm-event-bus';
import type { SwarmEvent } from '../services/swarm-event-bus';
import type { SegmlCycleResult } from '../services/segml-types';

const segmlState = vi.hoisted(() => ({
  instances: [] as Array<{ lastResult: SegmlCycleResult | null }>,
  runCycleImpl: null as null | ((agentId: string) => SegmlCycleResult | Promise<SegmlCycleResult>),
}));

vi.mock('../services/self-evolving-governance-loop', () => ({
  SelfEvolvingGovernanceLoop: class {
    lastResult: SegmlCycleResult | null = null;
    constructor(_db: unknown) {
      segmlState.instances.push(this);
    }
    async runCycle(agentId: string): Promise<SegmlCycleResult> {
      const r = await segmlState.runCycleImpl!(agentId);
      this.lastResult = r;
      return r;
    }
    getLatestCycle(): SegmlCycleResult | null {
      return this.lastResult;
    }
  },
}));

function cycleResult(over: Partial<SegmlCycleResult> = {}): SegmlCycleResult {
  return {
    id: 'cycle-1',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    status: 'completed',
    stage: 'completed',
    eval_run_id: 'er-1',
    memories_created: 0,
    memories_consolidated: 0,
    cases_generated: 0,
    rules_updated: 0,
    judge_rubrics_updated: 0,
    curriculum_phases_adjusted: 0,
    score_delta: 0,
    blind_spots_detected: [],
    errors: [],
    ...over,
  };
}

describe('SegmlCpoBridge', () => {
  let db: Database.Database;
  let bridge: SegmlCpoBridge;
  let events: SwarmEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlCpoBridge(db);
    segmlState.instances.length = 0;
    segmlState.runCycleImpl = () => cycleResult();
    events = [];
    unsubscribe = swarmEventBus.subscribe(e => events.push(e));
  });

  afterEach(() => {
    unsubscribe();
    db.close();
  });

  const learningEvents = () => events.filter(e => e.type === 'segml:cpo:learning_complete');
  const fleetEvents = () => events.filter(e => e.type === 'segml:cpo:fleet_blind_spots');

  it('maps a successful runCycle result into an integration result and emits learning_complete', async () => {
    segmlState.runCycleImpl = () =>
      cycleResult({
        id: 'cycle-7',
        completed_at: '2026-02-03T04:05:06.000Z',
        status: 'completed',
        blind_spots_detected: ['injection', 'canary'],
        memories_created: 3,
        cases_generated: 5,
        judge_rubrics_updated: 2,
        curriculum_phases_adjusted: 1,
        score_delta: 1.5,
      });

    const result = await bridge.runSegmlLearningPhase('agent-7');

    expect(result.cycleId).toBe('cycle-7');
    expect(result.agentId).toBe('agent-7');
    expect(result.status).toBe('completed');
    expect(result.blindSpots).toHaveLength(2);
    expect(result.blindSpots[0]).toEqual({
      category: 'injection',
      avg_score: 0,
      case_count: 0,
      severity: 'medium',
      recommendation: 'Auto-detected blind spot: injection',
    });
    expect(result.blindSpots[1]).toEqual({
      category: 'canary',
      avg_score: 0,
      case_count: 0,
      severity: 'medium',
      recommendation: 'Auto-detected blind spot: canary',
    });
    expect(result.scoreDelta).toBe(1.5);
    expect(result.memoriesCreated).toBe(3);
    expect(result.casesGenerated).toBe(5);
    expect(result.curriculumAdjusted).toBe(true);
    expect(result.judgeUpdated).toBe(true);

    expect(learningEvents()).toHaveLength(1);
    const evt = learningEvents()[0];
    expect(evt.data.agentId).toBe('agent-7');
    expect(evt.data.cycleId).toBe('cycle-7');
    expect(evt.data.blindSpots).toEqual(['injection', 'canary']);
    expect(evt.data.scoreDelta).toBe(1.5);
    expect(evt.data.timestamp).toBe('2026-02-03T04:05:06.000Z');
  });

  it('reports curriculumAdjusted and judgeUpdated as false when phases and rubrics are zero', async () => {
    segmlState.runCycleImpl = () =>
      cycleResult({
        curriculum_phases_adjusted: 0,
        judge_rubrics_updated: 0,
      });

    const result = await bridge.runSegmlLearningPhase('agent-1');

    expect(result.curriculumAdjusted).toBe(false);
    expect(result.judgeUpdated).toBe(false);
  });

  it('returns a failed result with empty cycleId and emits no learning_complete when runCycle throws', async () => {
    segmlState.runCycleImpl = () => {
      throw new Error('boom');
    };

    const result = await bridge.runSegmlLearningPhase('agent-err');

    expect(result.cycleId).toBe('');
    expect(result.agentId).toBe('agent-err');
    expect(result.status).toBe('failed');
    expect(result.blindSpots).toEqual([]);
    expect(result.scoreDelta).toBe(0);
    expect(result.memoriesCreated).toBe(0);
    expect(result.casesGenerated).toBe(0);
    expect(result.curriculumAdjusted).toBe(false);
    expect(result.judgeUpdated).toBe(false);
    expect(learningEvents()).toHaveLength(0);
  });

  it('reuses the same loop instance for repeated calls on the same agent', async () => {
    segmlState.runCycleImpl = () => cycleResult({ id: 'c-x' });

    await bridge.runSegmlLearningPhase('agent-1');
    await bridge.runSegmlLearningPhase('agent-1');

    expect(segmlState.instances).toHaveLength(1);
  });

  it('runs the fleet phase for each agent preserving order', async () => {
    segmlState.runCycleImpl = (agentId: string) => cycleResult({ id: `c-${agentId}` });

    const results = await bridge.runFleetSegmlPhase(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(results.map(r => r.agentId)).toEqual(['a', 'b', 'c']);
    expect(results.map(r => r.cycleId)).toEqual(['c-a', 'c-b', 'c-c']);
  });

  it('aggregates a category shared by 5 agents as critical and lists affected agents', async () => {
    segmlState.runCycleImpl = (agentId: string) =>
      cycleResult({ id: `c-${agentId}`, blind_spots_detected: ['injection'] });

    const results = await bridge.runFleetSegmlPhase(['a', 'b', 'c', 'd', 'e']);

    expect(results).toHaveLength(5);
    const fleet = fleetEvents();
    expect(fleet).toHaveLength(1);
    expect(fleet[0].data.blindSpots).toEqual([
      { category: 'injection', affectedAgents: 5, severity: 'critical' },
    ]);
    expect(fleet[0].data.affectedAgents).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('aggregates a category shared by 4 agents as high (below the critical threshold)', async () => {
    segmlState.runCycleImpl = (agentId: string) =>
      cycleResult({ id: `c-${agentId}`, blind_spots_detected: ['h4'] });

    await bridge.runFleetSegmlPhase(['a', 'b', 'c', 'd']);

    const fleet = fleetEvents();
    expect(fleet).toHaveLength(1);
    expect(fleet[0].data.blindSpots).toEqual([
      { category: 'h4', affectedAgents: 4, severity: 'high' },
    ]);
  });

  it('aggregates a category shared by 3 agents as high', async () => {
    segmlState.runCycleImpl = (agentId: string) =>
      cycleResult({ id: `c-${agentId}`, blind_spots_detected: ['canary'] });

    await bridge.runFleetSegmlPhase(['a', 'b', 'c']);

    const fleet = fleetEvents();
    expect(fleet).toHaveLength(1);
    expect(fleet[0].data.blindSpots).toEqual([
      { category: 'canary', affectedAgents: 3, severity: 'high' },
    ]);
  });

  it('aggregates a category shared by 2 agents as medium and filters single-occurrence categories', async () => {
    const spots: Record<string, string[]> = {
      a: ['med', 'solo'],
      b: ['med'],
      c: [],
    };
    segmlState.runCycleImpl = (agentId: string) =>
      cycleResult({ id: `c-${agentId}`, blind_spots_detected: spots[agentId] ?? [] });

    await bridge.runFleetSegmlPhase(['a', 'b', 'c']);

    const fleet = fleetEvents();
    expect(fleet).toHaveLength(1);
    expect(fleet[0].data.blindSpots).toEqual([
      { category: 'med', affectedAgents: 2, severity: 'medium' },
    ]);
    expect(fleet[0].data.affectedAgents).toEqual(['a', 'b']);
  });

  it('does not emit a fleet blind spots event when no agent has blind spots', async () => {
    segmlState.runCycleImpl = (agentId: string) => cycleResult({ id: `c-${agentId}` });

    const results = await bridge.runFleetSegmlPhase(['a', 'b']);

    expect(results.every(r => r.blindSpots.length === 0)).toBe(true);
    expect(fleetEvents()).toHaveLength(0);
  });

  it('reports status with monitored agents and latest cycles after a run', async () => {
    segmlState.runCycleImpl = () =>
      cycleResult({
        id: 'c-x',
        status: 'completed',
        score_delta: 2.5,
        completed_at: '2026-03-04T05:06:07.000Z',
      });

    await bridge.runSegmlLearningPhase('agent-x');

    const status = bridge.getStatus();
    expect(status.monitoredAgents).toBe(1);
    expect(status.latestCycles).toEqual([
      {
        agentId: 'agent-x',
        status: 'completed',
        scoreDelta: 2.5,
        timestamp: '2026-03-04T05:06:07.000Z',
      },
    ]);

    const scoped = bridge.getStatus('agent-x');
    expect(scoped.latestCycles).toHaveLength(1);
    expect(scoped.latestCycles[0].agentId).toBe('agent-x');
  });

  it('reports unknown status for an agent with no recorded cycle', async () => {
    segmlState.runCycleImpl = () => cycleResult({ id: 'c-1' });
    await bridge.runSegmlLearningPhase('agent-1');

    const scoped = bridge.getStatus('agent-none');
    expect(scoped.latestCycles).toEqual([
      { agentId: 'agent-none', status: 'unknown', scoreDelta: 0, timestamp: '' },
    ]);
  });

  it('starts with no monitored agents and no latest cycles', () => {
    const status = bridge.getStatus();
    expect(status.monitoredAgents).toBe(0);
    expect(status.latestCycles).toEqual([]);
  });
});
