import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { DreamTaskPlannerService } from '../services/dream-task-planner-service';
import { AgentLureService } from '../services/agent-lure-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { ExternalEventIngestService, scoreAgentOutcomes } from '../services/external-event-ingest-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { DreamCycleService } from '../services/dream-cycle-service';

const prevFlag = process.env.PAPERCLIP_EXPORT_ENABLED;
const prevPending = process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
const prevHome = process.env.HOME;
let db: Database.Database;
let home: string;

beforeEach(() => {
  db = new Database(':memory:'); runPreSchemaMigrations(db); db.exec(schema); runMigrations(db);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
  process.env.HOME = home; delete process.env.PAPERCLIP_EXPORT_ENABLED; delete process.env.DENNIS_AGENT_PAPERCLIP_PENDING;
});
afterEach(() => {
  db.close(); fs.rmSync(home, { recursive: true, force: true }); vi.unstubAllGlobals();
  for (const [k, v] of [['PAPERCLIP_EXPORT_ENABLED', prevFlag], ['DENNIS_AGENT_PAPERCLIP_PENDING', prevPending], ['HOME', prevHome]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const legacyFile = () => path.join(home, '.djimit', 'roborev', 'paperclip-tasks.pending.jsonl');

describe('dream tasks: native Djimitflo intake, Paperclip file is legacy', () => {
  function seedOpportunity() {
    new DreamCycleService(db); // creates dream_opportunities
    db.prepare("INSERT INTO dream_opportunities (id, capability_id, score, kind, title, rationale, suggested_action, status, dedupe_key) VALUES ('o1', 'cap-a', 0.6, 'evaluate', 'Evaluate cap-a', 'because', 'do it', 'proposed', 'dk-1')").run();
  }

  it('creates an idempotent work item and writes no Paperclip file by default', () => {
    seedOpportunity();
    const planner = new DreamTaskPlannerService(db);
    expect(planner.exportPending()).toBe(1);
    expect(planner.exportPending()).toBe(0); // already exported
    const items = db.prepare("SELECT title, source, status, recommended_loop FROM work_items WHERE source = 'dream_cycle'").all();
    expect(items).toEqual([{ title: 'Evaluate cap-a', source: 'dream_cycle', status: 'candidate', recommended_loop: 'outcome-learning-loop' }]);
    expect(fs.existsSync(legacyFile())).toBe(false);
  });

});

describe('roborev findings become Djimitflo work items via the event bus', () => {
  const finding = (extra: Record<string, unknown> = {}) => ({
    _id: '1-0', event_id: 'roborev:1', event_type: 'roborev.finding', source: 'roborev', dedupe_key: 'roborev:djimit/x:abc:sql', task_title: 'SQL built from user input',
    task_type: 'review_fix', severity: 'high', repo: 'djimit/x', sha: 'abc', finding_class: 'sql', affected_files: ['a.ts'], context: 'Line 3 concatenates input', ...extra,
  });

  it('is idempotent on dedupe_key and maps severity to risk and task type to loop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [finding(), finding({ _id: '2-0', event_id: 'roborev:2' })] }), { status: 200 })));
    const service = new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events');
    await service.pollOnce();
    const rows = db.prepare("SELECT title, risk_class, recommended_loop, status, source_ref, metadata FROM work_items WHERE source = 'roborev'").all() as Array<{ metadata: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'SQL built from user input', risk_class: 'high', recommended_loop: 'repo-maintenance-loop', status: 'candidate', source_ref: 'roborev:djimit/x:abc:sql' });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ repo: 'djimit/x', sha: 'abc', affected_files: ['a.ts'] });
  });

  it('decodes list fields the Redis bus delivers as JSON strings; malformed lists become [] without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [
      finding({ affected_files: '["src/a.ts","src/b.ts"]', labels: '["roborev","security"]', blocked_by: '[]' }),
      finding({ _id: '2-0', event_id: 'roborev:2', dedupe_key: 'roborev:djimit/x:abc:bad', affected_files: '[not json', labels: 'plain' }),
    ] }), { status: 200 })));
    await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
    const meta = (ref: string) => JSON.parse((db.prepare("SELECT metadata FROM work_items WHERE source = 'roborev' AND source_ref = ?").get(ref) as { metadata: string }).metadata);
    expect(meta('roborev:djimit/x:abc:sql')).toMatchObject({ affected_files: ['src/a.ts', 'src/b.ts'], labels: ['roborev', 'security'], blocked_by: [] });
    expect(meta('roborev:djimit/x:abc:bad')).toMatchObject({ affected_files: [], labels: [] });
  });

  it('skips a malformed finding without breaking ingestion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [finding({ task_title: '', dedupe_key: '' })] }), { status: 200 })));
    await expect(new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce()).resolves.toBeGreaterThanOrEqual(0);
    expect(db.prepare("SELECT COUNT(*) n FROM work_items WHERE source = 'roborev'").get()).toEqual({ n: 0 });
  });
});

describe('ecosystem map: Djimitflo is the core', () => {
  it('describes Paperclip as retiring and routes roborev to Djimitflo', () => {
    const svc = new SwarmIntelligenceService(db) as unknown as { ecosystemMapSummary: (input: unknown) => { nodes: Array<{ id: string; label: string; responsibility: string }>; declared_contracts: Array<{ from: string; to: string }> } };
    const view = svc.ecosystemMapSummary({ interactions: [], outcomeLearning: [], reviewerIndependence: [], integrationSpine: { chains: [] } });
    expect(view.nodes.find((n) => n.id === 'djimitflo')!.responsibility).toContain('core of the ecosystem');
    expect(view.nodes.find((n) => n.id === 'paperclip')!.label).toContain('retiring');
    expect(view.declared_contracts).toContainEqual(expect.objectContaining({ from: 'roborev', to: 'djimitflo' }));
    expect(view.declared_contracts.some((c) => c.from === 'paperclip' && c.to === 'djimitflo')).toBe(false);
  });
});

describe('every external agent signal is recorded, not only allow-listed types', () => {
  it('keeps an Eve-V action event (observe-only) and skips Djimitflo\'s own echo', async () => {
    const events = [
      { _id: '3-0', event_id: 'eve:1', event_type: 'work.action.required', source: 'eve-action-processor', occurred_at: '2026-09-27T10:00:00Z', title: 'Patch VPN firmware' },
      { _id: '2-0', event_id: 'own:1', event_type: 'djimitflo.goal.started', source: 'djimitflo', occurred_at: '2026-09-27T10:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
    await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
    expect(db.prepare('SELECT event_type, source FROM external_events ORDER BY event_type').all())
      .toEqual([{ event_type: 'work.action.required', source: 'eve-action-processor' }]);
  });
});

describe('N2: agent.outcome becomes a fleet skill outcome', () => {
  it('records agent:<agent>:<task_kind> once per event; malformed outcomes are stored but not scored', async () => {
    const events = [
      { _id: '5-0', event_id: 'agent-outcome:1', event_type: 'agent.outcome', source: 'hermes-eve-v', agent: 'hermes-eve-v', task_kind: 'briefing', success: 'true', model: 'kimi-k3', tokens: '1200', occurred_at: '2026-09-27T10:00:00Z' }, // the bus returns strings
      { _id: '4-0', event_id: 'agent-outcome:2', event_type: 'agent.outcome', source: 'eve', agent: 'bad agent name!', task_kind: 'x', success: 'yes', occurred_at: '2026-09-27T10:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
    const service = new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events');
    await service.pollOnce();
    await service.pollOnce(); // replay: the same event is not scored twice
    expect(db.prepare("SELECT skill_id, success, model, agent_id, domain FROM skill_outcomes").all())
      .toEqual([{ skill_id: 'agent:hermes-eve-v:briefing', success: 1, model: 'kimi-k3', agent_id: 'hermes-eve-v', domain: 'fleet' }]);
  });
});

it('N2: an agent.outcome stored before scoring worked is scored by the catch-up pass, once', () => {
  new SkillEvolutionEngine(db);
  db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES ('agent-outcome:old', 'agent.outcome', 'eve-maintainer', '2026-09-28T08:15:00Z', ?)")
    .run(JSON.stringify({ agent: 'eve-maintainer', task_kind: 'repo-maintenance', success: 'false' }));
  expect(scoreAgentOutcomes(db)).toBe(1);
  expect(scoreAgentOutcomes(db)).toBe(0);
  expect(db.prepare("SELECT skill_id, success FROM skill_outcomes WHERE domain = 'fleet'").all()).toEqual([{ skill_id: 'agent:eve-maintainer:repo-maintenance', success: 0 }]);
});
