/**
 * D-S7-1 (controlled-execution audit 2026-11-15; M0 H7-D1): a scheduler whose work fails must read `failing` in the registry.
 * Each scheduler below recorded its run (markRun) BEFORE its work and only console.warn-ed the work's error, so a scheduler
 * that failed on every tick read `executing` / HEALTHY. Each case arms the scheduler through its own start function and
 * injects the failure through its own seam (a dependency, an instance method, or a database without the tables its work
 * reads); no registry row is written by the test. The compliance_report case runs end-to-end in scenarios/s07.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { guardTick, listSchedulers, markRun, noteScheduler, resetSchedulers } from '../services/scheduler-registry';
import { SelfHealingScheduler } from '../services/self-healing-scheduler';
import { SpecialistPanelBacklogScheduler } from '../services/specialist-panel-backlog-scheduler';
import { MemoryCandidateReviewScheduler } from '../services/memory-candidate-review-scheduler';
import { FrontierExpertScheduler } from '../services/frontier-expert-scheduler';
import { SelfImprovementAutoReviewScheduler } from '../services/self-improvement-auto-review-scheduler';
import { DeadCodeSourceService } from '../services/dead-code-source-service';
import { FindingFixSourceService } from '../services/finding-fix-source';
import { TestGapSourceService } from '../services/test-gap-source-service';
import { EvolutionGymService } from '../services/evolution-gym-service';
import { DreamStateService } from '../services/dream-state-service';
import { startMergeSurvival } from '../services/merge-survival';
import { startLoopAutoMerge } from '../services/loop-auto-merge';
import { startCommitteeEvolution } from '../services/committee-swarm';
import { startDreamEvolution } from '../services/dream-evolution';
import { startStallWatch } from '../services/stall-watch';

// stallWatchTick catches every detector and DB error itself; the one step outside a try is the fleet-drift read, so that is
// where a rejected stall-watch tick is injected (the module stays real otherwise)
const fleet = vi.hoisted(() => ({ fail: false }));
vi.mock('../utils/fleet-drift', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fleet-drift')>();
  return { ...actual, fleetDrift: (...a: Parameters<typeof actual.fleetDrift>) => { if (fleet.fail) throw new Error('injected fleet-drift failure'); return actual.fleetDrift(...a); } };
});

const fullDb = () => { const db = new Database(':memory:'); db.exec(schema); runMigrations(db); return db; };
/** No tables: the scheduler's own work throws on its first query (the injected failure for the module-function schedulers). */
const emptyDb = () => new Database(':memory:');
const entry = (name: string) => listSchedulers().schedulers.find((s) => s.name === name);
const boom = (what: string) => new Error(`injected ${what} failure`);

let stops: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  resetSchedulers(Date.now());
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});
afterEach(() => {
  for (const s of stops) s(); stops = [];
  fleet.fail = false;
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
/** noteScheduler as index.ts does it, so the registry lists the scheduler */
const arm = (name: string) => noteScheduler(name, 'TEST', true, 3_600_000);

describe('D-S7-1: a scheduler whose work fails reads failing (run recorded after the work, with its error)', () => {
  it('self_healing: heal() throws', async () => {
    vi.stubEnv('SELF_HEALING_SCHEDULER_ENABLED', 'true'); arm('self_healing');
    const s = new SelfHealingScheduler(fullDb(), { heal: () => { throw boom('heal'); } } as never); stops.push(() => s.stop());
    expect(s.start()).toBe(true); // boot catch-up tick
    expect(entry('self_healing')).toMatchObject({ status: 'failing', last_error: 'injected heal failure' });
  });

  it('specialist_panel_backlog: a panel projection fails', async () => {
    vi.stubEnv('SPECIALIST_PANEL_BACKLOG_ENABLED', 'true'); arm('specialist_panel_backlog');
    const s = new SpecialistPanelBacklogScheduler(fullDb()); stops.push(() => s.stop());
    Object.assign((s as unknown as { panels: object }).panels, {
      listPanels: () => [{ id: 'p1', status: 'consensus_ready', consensus: { decision: 'goal' }, metadata: {} }],
      projectPanelToBacklog: () => { throw boom('projection'); },
    });
    expect(s.start()).toBe(true);
    expect(entry('specialist_panel_backlog')).toMatchObject({ status: 'failing' });
    expect(entry('specialist_panel_backlog')?.last_error).toContain('injected projection failure');
  });

  it('memory_candidate_review: a candidate review fails', async () => {
    vi.stubEnv('MEMORY_CANDIDATE_REVIEW_ENABLED', 'true'); arm('memory_candidate_review');
    const s = new MemoryCandidateReviewScheduler(fullDb()); stops.push(() => s.stop());
    Object.assign((s as unknown as { candidates: object }).candidates, { listPendingPromotion: () => [{ id: 'm1' }] });
    Object.assign(s as unknown as object, { reviewOne: async () => { throw boom('review'); }, maybeGenerateEvolutionProposal: () => false });
    expect(s.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('memory_candidate_review')).toMatchObject({ status: 'failing' });
    expect(entry('memory_candidate_review')?.last_error).toContain('injected review failure');
  });

  it('frontier_experts: ingestion fails', async () => {
    vi.stubEnv('DJIMITFLO_FRONTIER_EXPERTS_ENABLED', 'true'); vi.stubEnv('FRONTIER_EXPERTS_SCHEDULER_ENABLED', 'true'); arm('frontier_experts');
    const s = new FrontierExpertScheduler(fullDb(), {
      ingestion: { ingest: async () => { throw boom('ingest'); } } as never,
      enrichment: { enrichBatch: async () => [] } as never,
      council: { reviewExpert: async () => undefined } as never,
    }); stops.push(() => s.stop());
    expect(s.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('frontier_experts')).toMatchObject({ status: 'failing' });
    expect(entry('frontier_experts')?.last_error).toContain('injected ingest failure');
  });

  it('self_improvement_auto_review: an approval step fails', async () => {
    vi.stubEnv('SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED', 'true'); arm('self_improvement_auto_review');
    const s = new SelfImprovementAutoReviewScheduler(fullDb()); stops.push(() => s.stop());
    Object.assign((s as unknown as { improvements: object }).improvements, {
      listImprovements: () => [{ id: 'si1', type: 'refactor', title: 't', description: '', rationale: '', panelId: null }],
      agentApproveIfReady: () => { throw boom('approve'); },
    });
    expect(s.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('self_improvement_auto_review')).toMatchObject({ status: 'failing' });
    expect(entry('self_improvement_auto_review')?.last_error).toContain('injected approve failure');
  });

  it('dead_code_lane: run() throws', async () => {
    vi.stubEnv('DEAD_CODE_LANE_ENABLED', 'true'); arm('dead_code_lane');
    const s = new DeadCodeSourceService(fullDb()); stops.push(() => s.stop());
    vi.spyOn(s, 'run').mockImplementation(() => { throw boom('dead-code'); });
    s.start(3_600_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(entry('dead_code_lane')).toMatchObject({ status: 'failing', last_error: 'injected dead-code failure' });
  });

  it('finding_fix_lane: run() throws', async () => {
    vi.stubEnv('FINDING_FIX_LANE', 'shadow'); arm('finding_fix_lane');
    const s = new FindingFixSourceService(fullDb()); stops.push(() => s.stop());
    vi.spyOn(s, 'run').mockImplementation(() => { throw boom('finding-fix'); });
    s.start(3_600_000);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(entry('finding_fix_lane')).toMatchObject({ status: 'failing', last_error: 'injected finding-fix failure' });
  });

  it('test_gap_source: the test-gap pass throws', async () => {
    vi.stubEnv('TEST_GAP_SOURCE_ENABLED', 'true'); arm('test_gap_source');
    const s = new TestGapSourceService(fullDb()); stops.push(() => s.stop());
    vi.spyOn(s, 'run').mockImplementation(() => { throw boom('test-gap'); });
    vi.spyOn(s, 'runMutationGaps').mockImplementation(() => ({ created: 0, skipped: 'none' }) as never);
    s.start(3_600_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(entry('test_gap_source')).toMatchObject({ status: 'failing', last_error: 'injected test-gap failure' });
  });

  it('evolution_gym: runOne() rejects', async () => {
    vi.stubEnv('EVOLUTION_GYM_ENABLED', 'true'); vi.stubEnv('EVOLUTION_GYM_FIRST_DELAY_MS', '1000'); arm('evolution_gym');
    const s = new EvolutionGymService(fullDb(), {} as never); stops.push(() => s.stop());
    vi.spyOn(s, 'runOne').mockRejectedValue(boom('gym'));
    s.start(3_600_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry('evolution_gym')).toMatchObject({ status: 'failing', last_error: 'injected gym failure' });
  });

  it('dream_state: replay() rejects', async () => {
    vi.stubEnv('DREAM_STATE_ENABLED', 'true'); arm('dream_state');
    const s = new DreamStateService(fullDb()); stops.push(() => s.stop());
    vi.spyOn(s, 'due').mockReturnValue(true);
    vi.spyOn(s, 'replay').mockRejectedValue(boom('replay'));
    s.start(3_600_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(entry('dream_state')).toMatchObject({ status: 'failing', last_error: 'injected replay failure' });
  });

  it('merge_survival: checkLoopPrs rejects (its tables are missing)', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo'); vi.stubEnv('GITHUB_TOKEN', 'test-token-not-used'); // fetch is stubbed: no network
    vi.stubEnv('MERGE_SURVIVAL_ENABLED', 'true'); arm('merge_survival');
    const stop = startMergeSurvival(emptyDb()); expect(stop).not.toBeNull(); stops.push(stop!);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(entry('merge_survival')?.status).toBe('failing');
    expect(entry('merge_survival')?.last_error).toMatch(/no such table/);
  });

  it('loop_auto_merge: runAutoMergeTick rejects (its tables are missing)', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo'); vi.stubEnv('GITHUB_TOKEN', 'test-token-not-used'); // fetch is stubbed: no network
    vi.stubEnv('LOOP_AUTO_MERGE_TEST_ONLY', 'shadow'); arm('loop_auto_merge');
    const stop = startLoopAutoMerge(emptyDb()); expect(stop).not.toBeNull(); stops.push(stop!);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(entry('loop_auto_merge')?.status).toBe('failing');
    expect(entry('loop_auto_merge')?.last_error).toMatch(/no such table/);
  });

  it('committee_evolution: evolveCommittee throws (its tables are missing)', async () => {
    vi.stubEnv('COMMITTEE_SWARM_ENABLED', 'true'); arm('committee_evolution');
    const stop = startCommitteeEvolution(emptyDb(), 1_000); expect(stop).not.toBeNull(); stops.push(stop!);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry('committee_evolution')?.status).toBe('failing');
    expect(entry('committee_evolution')?.last_error).toMatch(/no such table/);
  });

  it('dream_evolution: trial evaluation and the dream both fail (their tables are missing)', async () => {
    vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); arm('dream_evolution');
    const stop = startDreamEvolution(emptyDb()); expect(stop).not.toBeNull(); stops.push(stop!);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('dream_evolution')?.status).toBe('failing');
    expect(entry('dream_evolution')?.last_error).toMatch(/no such table/);
  });

  it('stall_watch: the async stall-watch tick rejects', async () => {
    vi.stubEnv('STALL_WATCH_ENABLED', 'true'); arm('stall_watch');
    fleet.fail = true;
    const stop = startStallWatch(fullDb(), 1_000); expect(stop).not.toBeNull(); stops.push(stop!);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry('stall_watch')).toMatchObject({ status: 'failing', last_error: 'injected fleet-drift failure' });
    fleet.fail = false; // the next tick succeeds and clears it
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entry('stall_watch')).toMatchObject({ status: 'executing', last_error: null });
  });
});

describe('the fix keeps a healthy tick healthy and lets a failing scheduler recover', () => {
  it('self_healing: a failing tick, then a successful one, reads executing with no error', async () => {
    vi.stubEnv('SELF_HEALING_SCHEDULER_ENABLED', 'true'); vi.stubEnv('SELF_HEALING_INTERVAL_MINUTES', '1'); arm('self_healing');
    let fail = true;
    const s = new SelfHealingScheduler(fullDb(), { heal: () => { if (fail) throw boom('heal'); return { healed: 0 }; } } as never); stops.push(() => s.stop());
    s.start();
    expect(entry('self_healing')?.status).toBe('failing');
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entry('self_healing')).toMatchObject({ status: 'executing', last_error: null });
  });

  it('guardTick: a fn that reports its own error keeps it (the success mark does not overwrite it)', () => {
    arm('own_error');
    guardTick('own_error', () => { markRun('own_error', boom('own')); })();
    expect(entry('own_error')).toMatchObject({ status: 'failing', last_error: 'injected own failure' });
  });

  it('guardTick: an async fn that resolves clears an earlier error; one that rejects records it', async () => {
    arm('async_probe');
    guardTick('async_probe', async () => { throw boom('async'); })();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('async_probe')).toMatchObject({ status: 'failing', last_error: 'injected async failure' });
    guardTick('async_probe', async () => undefined)();
    expect(entry('async_probe')?.status).toBe('failing'); // still in flight: the earlier error stands until it resolves
    await vi.advanceTimersByTimeAsync(0);
    expect(entry('async_probe')).toMatchObject({ status: 'executing', last_error: null });
  });
});
