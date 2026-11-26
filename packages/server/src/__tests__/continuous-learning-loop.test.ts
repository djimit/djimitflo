import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { createTestDb } from './helpers/test-db';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentLureService } from '../services/agent-lure-service';
import type { TrajectoryStore } from '../services/trajectory-store';


let db: Database.Database;
let loop: ContinuousLearningLoop;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  loop = new ContinuousLearningLoop(db, { intervalMs: 999999999 });
});

afterEach(() => { db?.close(); loop.stop(); });

describe('G127: Continuous Learning Loop', () => {
  it('runs a learning cycle', async () => {
    const result = await loop.runCycle();
    expect(result.id).toBeDefined();
    expect(result.timestamp).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(10_000);
    expect(result.producer).toBe('continuous-learning-loop');
    expect(result.schemaVersion).toBe(1);
  });

  it('counts one social exchange even though it emits two peer messages', async () => {
    const heartbeat = new Date().toISOString();
    const metadata = JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: heartbeat } });
    db.prepare('INSERT INTO agents (id, name, description, status, capabilities_json, metadata) VALUES (?, ?, ?, ?, ?, ?)').run('social-a', 'Social A', 'Social fixture', 'active', '["research"]', metadata);
    db.prepare('INSERT INTO agents (id, name, description, status, capabilities_json, metadata) VALUES (?, ?, ?, ?, ?, ?)').run('social-b', 'Social B', 'Social fixture', 'active', '["engineering"]', metadata);

    const result = await loop.runCycle();
    expect(result.socialExchangesStarted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question'").get()).toEqual({ count: 2 });
  });

  it('casts one autonomous lure when the commons is empty and does not repeat while it is open (AUTONOMOUS_LURES_ENABLED=true)', async () => {
    const pending = `${process.env.TMPDIR || '/tmp'}/lure-loop-${Date.now()}.jsonl`;
    process.env.DENNIS_AGENT_PAPERCLIP_PENDING = pending;
    process.env.AUTONOMOUS_LURES_ENABLED = 'true';
    try {
      // lapsed Commons members (had a social runtime); never-connected agents are not lured autonomously
      const lapsed = JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2026-09-13T19:33:37.041Z' } });
      db.prepare("INSERT INTO agents (id, name, description, status, metadata) VALUES ('quiet-a', 'Quiet A', '', 'active', ?), ('quiet-b', 'Quiet B', '', 'idle', ?)").run(lapsed, lapsed);
      const first = await loop.runCycle();
      expect(first.socialExchangesStarted).toBe(0);
      expect(first.luresCast).toBe(1);
      const invites = db.prepare("SELECT to_agent FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.invite' ORDER BY to_agent").all();
      expect(invites).toEqual([{ to_agent: 'quiet-a' }, { to_agent: 'quiet-b' }]);
      const second = await loop.runCycle();
      expect(second.luresCast).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM social_lures').get()).toEqual({ n: 1 });
    } finally {
      delete process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
      delete process.env.AUTONOMOUS_LURES_ENABLED;
    }
  });

  it('casts no autonomous lure on an empty commons when AUTONOMOUS_LURES_ENABLED is unset, but still sweeps expiries', async () => {
    const pending = `${process.env.TMPDIR || '/tmp'}/lure-loop-off-${Date.now()}.jsonl`;
    process.env.DENNIS_AGENT_PAPERCLIP_PENDING = pending;
    delete process.env.AUTONOMOUS_LURES_ENABLED;
    try {
      const lapsed = JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2026-09-13T19:33:37.041Z' } });
      db.prepare("INSERT INTO agents (id, name, description, status, metadata) VALUES ('quiet-a', 'Quiet A', '', 'active', ?), ('quiet-b', 'Quiet B', '', 'idle', ?)").run(lapsed, lapsed);
      // an older lure (e.g. a manual dashboard cast) whose window has closed
      const lure = new AgentLureService(db, new AgentCommunicationService(db));
      lure.castLure({ by: 'operator', baseUrl: 'http://127.0.0.1:3001', mintTokens: false, reach: 'lapsed' });
      db.prepare("UPDATE social_lures SET expires_at = '2026-01-01T00:00:00.000Z'").run();
      const result = await loop.runCycle();
      expect(result.socialExchangesStarted).toBe(0);
      expect(result.luresCast).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM social_lures').get()).toEqual({ n: 1 });
      const expired = db.prepare("SELECT COUNT(*) AS n FROM lure_events WHERE transition IN ('expired_undelivered', 'expired_delivered_no_response')").get() as { n: number };
      expect(expired.n).toBe(2);
    } finally {
      delete process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
    }
  });

  // M1 (A #26, prod 14 d): 412 learning_cycles rows, every counter 0 — the hourly/boot cycle wrote a row when nothing happened.
  it('M1: a scheduled cycle that ingested and produced nothing writes no learning_cycles row', async () => {
    const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM learning_cycles').get() as { n: number }).n;
    const result = await loop.runCycle({ skipEmpty: true });
    expect(result.episodesIngested).toBe(0);
    expect(rows()).toBe(0);
    vi.useFakeTimers();
    try {
      const scheduled = new ContinuousLearningLoop(db, { intervalMs: 1000 });
      scheduled.start();
      vi.advanceTimersByTime(3000);
      scheduled.stop();
    } finally { vi.useRealTimers(); }
    await new Promise((r) => setTimeout(r, 0));
    expect(rows()).toBe(0);
  });

  it('M1: a scheduled cycle that did something still records its row', async () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"analysis\"]'), ('agent-b', 'Agent B', 'active', '[\"research\"]')").run();
    const communication = new AgentCommunicationService(db);
    communication.heartbeat('agent-a', 'runtime-a', 'model-a', 'runtime_token');
    communication.heartbeat('agent-b', 'runtime-b', 'model-b', 'runtime_token');
    const result = await loop.runCycle({ skipEmpty: true });
    expect(result.socialExchangesStarted).toBe(1);
    expect(db.prepare('SELECT id FROM learning_cycles').all()).toEqual([{ id: result.id }]);
  });

  it('tracks history', async () => {
    await loop.runCycle();
    await loop.runCycle();
    const hist = loop.getHistory(10);
    expect(hist).toHaveLength(2);
    expect(hist[0].producer).toBe('continuous-learning-loop');
    expect(hist[0].schemaVersion).toBe(1);
    expect(hist[0].id).toBeDefined();
  });

  it('gets last cycle', async () => {
    await loop.runCycle();
    expect(loop.getLastCycle()).not.toBeNull();
  });

  it('opens one bounded social round for connected runtimes', async () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"analysis\"]'), ('agent-b', 'Agent B', 'active', '[\"research\"]')").run();
    const communication = new AgentCommunicationService(db);
    communication.heartbeat('agent-a', 'runtime-a', 'model-a', 'runtime_token');
    communication.heartbeat('agent-b', 'runtime-b', 'model-b', 'runtime_token');
    process.env.DJIMITFLO_COMMIT_SHA = 'a'.repeat(40);
    try {
      const result = await loop.runCycle();
      expect(result.socialExchangesStarted).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question'").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT DISTINCT json_extract(payload_json, '$.params.facilitator_commit') AS commit_sha FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question'").all()).toEqual([{ commit_sha: 'a'.repeat(40) }]);
      expect(db.prepare("SELECT DISTINCT json_extract(payload_json, '$.params.facilitator_trigger') AS trigger FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question'").all()).toEqual([{ trigger: 'autonomous' }]);
    } finally { delete process.env.DJIMITFLO_COMMIT_SHA; }
  });

  it('ignores foreign cycle records in history and watermarks', async () => {
    await loop.runCycle();
    db.prepare('INSERT INTO learning_cycles (id, result_json) VALUES (?, ?)').run(
      'foreign-cycle',
      JSON.stringify({ timestamp: '2999-01-01T00:00:00.000Z', sourceWatermark: 'foreign' }),
    );

    expect(loop.getHistory(10)).toHaveLength(1);
    expect(loop.getLastCycle()?.producer).toBe('continuous-learning-loop');
  });

  it('learns only verified maker runs and does not reflect twice after restart', async () => {
    const now = new Date().toISOString();
    const insertRun = db.prepare(`
      INSERT INTO loop_runs (
        id, loop_name, mode, status, findings_json, plan_json, gates_json,
        next_actions_json, metadata, created_at, updated_at, completed_at
      ) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?, ?)
    `);
    insertRun.run('verified-run', JSON.stringify({ dry_run: true }), now, now, now);
    insertRun.run('discovery-only-run', JSON.stringify({ dry_run: true, outcome: 'no_change_required' }), now, now, now);
    db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at
      ) VALUES ('verified-maker', 'verified-run', 'maker', 'mock', 'completed', '{}', '{}', ?, ?)
    `).run(now, now);

    const first = await loop.runCycle();
    expect(first.episodesIngested).toBe(1);
    expect(first.reflectionsGenerated).toBe(1);
    expect(first.proposalsGenerated).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM central_memories WHERE type = 'episode'").get() as { n: number }).n).toBe(1);

    loop.stop();
    loop = new ContinuousLearningLoop(db, { intervalMs: 999999999 });
    const second = await loop.runCycle();
    expect(second.episodesIngested).toBe(0);
    expect(second.reflectionsGenerated).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM reflections WHERE loop_run_id = 'verified-run'").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM reflections WHERE loop_run_id = 'discovery-only-run'").get() as { count: number }).count).toBe(0);
  });

  it('turns a failed checked run into one inert, deduplicated proposal', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at, completed_at)
      VALUES ('failed-check-run', 'repo-maintenance-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?, ?)
    `).run(now, now, now);
    const insertLease = db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, capability_id, status, budget_json, metadata, created_at, updated_at)
      VALUES (?, 'failed-check-run', ?, 'mock', ?, ?, '{}', '{}', ?, ?)
    `);
    insertLease.run('failed-maker', 'maker', 'repo-edit', 'completed', now, now);
    insertLease.run('failed-checker', 'checker', 'test-validation', 'failed', now, now);

    const first = await loop.runCycle();
    expect(first.proposalsGenerated).toBe(1);
    expect(first.goalsGenerated).toBe(0);
    const proposal = db.prepare('SELECT status, panel_id, evidence_refs_json FROM self_improvements').get() as any;
    expect(proposal.status).toBe('proposed');
    expect(proposal.panel_id).toBeTruthy();
    expect(JSON.parse(proposal.evidence_refs_json)).toContain('loop:failed-check-run');

    const second = await loop.runCycle();
    expect(second.proposalsGenerated).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM self_improvements').get() as { count: number }).count).toBe(1);
  });

  it('legacy dream ranking and SEGML are off unless explicitly enabled (plan E14)', async () => {
    const spy = { runCycle: () => { throw new Error('legacy dream must not run'); }, exportPending: () => { throw new Error('no export'); } };
    Object.assign(loop as unknown as { dreams: unknown; dreamTasks: unknown }, { dreams: spy, dreamTasks: spy });
    const result = await loop.runCycle();
    expect(result.dreamOpportunitiesGenerated).toBe(0);
    expect(result.dreamTasksPlanned).toBe(0);
    loop.start();
    expect((loop as unknown as { segmlTimer: unknown }).segmlTimer).toBeNull();
    loop.stop();
    process.env.SEGML_ENABLED = 'true';
    try { loop.start(); expect((loop as unknown as { segmlTimer: unknown }).segmlTimer).not.toBeNull(); } finally { loop.stop(); delete process.env.SEGML_ENABLED; }
  });

  it('start/stop timer', () => {
    loop.start();
    loop.stop();
    expect(true).toBe(true);
  });

  it('uses the default 3600_000ms interval when no options are given', () => {
    const defaultLoop = new ContinuousLearningLoop(db);
    try {
      expect((defaultLoop as unknown as { intervalMs: number }).intervalMs).toBe(3600_000);
    } finally {
      defaultLoop.stop();
    }
  });

  it('does not start a second timer on double start()', () => {
    const spy = vi.spyOn(global, 'setInterval');
    try {
      loop.start();
      const callsAfterFirst = spy.mock.calls.length;
      loop.start();
      expect(spy.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      spy.mockRestore();
      loop.stop();
    }
  });

  it('a scheduled cycle that has data writes a learning_cycles row via the timer', async () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json) VALUES ('agent-a', 'Agent A', 'active', '[\"analysis\"]'), ('agent-b', 'Agent B', 'active', '[\"research\"]')").run();
    const communication = new AgentCommunicationService(db);
    communication.heartbeat('agent-a', 'runtime-a', 'model-a', 'runtime_token');
    communication.heartbeat('agent-b', 'runtime-b', 'model-b', 'runtime_token');
    vi.useFakeTimers();
    try {
      const scheduled = new ContinuousLearningLoop(db, { intervalMs: 1000 });
      scheduled.start();
      await vi.advanceTimersByTimeAsync(1000);
      scheduled.stop();
    } finally { vi.useRealTimers(); }
    await new Promise((r) => setTimeout(r, 0));
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM learning_cycles').get() as { n: number }).n;
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  it('enriches episodes with a trajectory summary when one is available', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at, completed_at)
      VALUES ('traj-run', 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?, ?)
    `).run(now, now, now);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at)
      VALUES ('traj-maker', 'traj-run', 'maker', 'mock', 'completed', '{}', '{}', ?, ?)
    `).run(now, now);
    loop.setTrajectoryStore({ getTrajectorySummary: () => '✓ edit(mock-runtime)' } as unknown as TrajectoryStore);
    await loop.runCycle();
    const mem = db.prepare("SELECT content FROM central_memories WHERE type = 'episode'").get() as { content: string };
    expect(mem.content).toContain('trajectory: ✓ edit(mock-runtime)');
  });

  it('does not enrich episodes when the trajectory summary says none was recorded', async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at, completed_at)
      VALUES ('traj-none-run', 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?, ?)
    `).run(now, now, now);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at)
      VALUES ('traj-none-maker', 'traj-none-run', 'maker', 'mock', 'completed', '{}', '{}', ?, ?)
    `).run(now, now);
    loop.setTrajectoryStore({ getTrajectorySummary: () => '_No trajectory recorded_' } as unknown as TrajectoryStore);
    await loop.runCycle();
    const mem = db.prepare("SELECT content FROM central_memories WHERE type = 'episode'").get() as { content: string };
    expect(mem.content).not.toContain('trajectory');
  });

  it('runs the legacy dream ranking when DREAM_CYCLE_LEGACY_ENABLED is true', async () => {
    const dreamMock = { runCycle: () => [{ id: 'dream-1' }], exportPending: () => 0 };
    Object.assign(loop as unknown as { dreams: unknown; dreamTasks: unknown }, { dreams: dreamMock, dreamTasks: dreamMock });
    process.env.DREAM_CYCLE_LEGACY_ENABLED = 'true';
    try {
      const result = await loop.runCycle();
      expect(result.dreamOpportunitiesGenerated).toBe(1);
      expect(result.dreamTasksPlanned).toBe(0);
    } finally {
      delete process.env.DREAM_CYCLE_LEGACY_ENABLED;
    }
  });

  it('uses DJIMITFLO_PUBLIC_URL as the lure baseUrl when set', async () => {
    const pending = `${process.env.TMPDIR || '/tmp'}/lure-url-${Date.now()}.jsonl`;
    process.env.DENNIS_AGENT_PAPERCLIP_PENDING = pending;
    process.env.AUTONOMOUS_LURES_ENABLED = 'true';
    process.env.DJIMITFLO_PUBLIC_URL = 'http://public.example.test';
    try {
      const lapsed = JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2026-09-13T19:33:37.041Z' } });
      db.prepare("INSERT INTO agents (id, name, description, status, metadata) VALUES ('url-a', 'Url A', '', 'active', ?)").run(lapsed);
      await loop.runCycle();
      const joinUrls = db.prepare("SELECT json_extract(payload_json, '$.params.join') AS join_url FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.invite'").all() as Array<{ join_url: string }>;
      expect(joinUrls.length).toBeGreaterThan(0);
      expect(joinUrls.every((u) => u.join_url.startsWith('http://public.example.test/'))).toBe(true);
    } finally {
      delete process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
      delete process.env.AUTONOMOUS_LURES_ENABLED;
      delete process.env.DJIMITFLO_PUBLIC_URL;
    }
  });

  it('uses PORT in the lure fallback baseUrl when DJIMITFLO_PUBLIC_URL is unset', async () => {
    const pending = `${process.env.TMPDIR || '/tmp'}/lure-port-${Date.now()}.jsonl`;
    process.env.DENNIS_AGENT_PAPERCLIP_PENDING = pending;
    process.env.AUTONOMOUS_LURES_ENABLED = 'true';
    process.env.PORT = '4321';
    delete process.env.DJIMITFLO_PUBLIC_URL;
    try {
      const lapsed = JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2026-09-13T19:33:37.041Z' } });
      db.prepare("INSERT INTO agents (id, name, description, status, metadata) VALUES ('port-a', 'Port A', '', 'active', ?)").run(lapsed);
      await loop.runCycle();
      const joinUrls = db.prepare("SELECT json_extract(payload_json, '$.params.join') AS join_url FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.invite'").all() as Array<{ join_url: string }>;
      expect(joinUrls.length).toBeGreaterThan(0);
      expect(joinUrls.every((u) => u.join_url.startsWith('http://127.0.0.1:4321/'))).toBe(true);
    } finally {
      delete process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
      delete process.env.AUTONOMOUS_LURES_ENABLED;
      delete process.env.PORT;
    }
  });
});
