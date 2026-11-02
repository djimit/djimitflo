// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { registerMissionControlTools } from '../tools/mission-control.js';
import type { DbHandle } from '../db.js';

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('registerMissionControlTools', () => {
  let db: Database.Database;
  let handle: DbHandle;
  let server: McpServer;

  const getHandler = (name: string) => (server as any)._registeredTools?.[name]?.handler;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO system_state VALUES ('database_instance_id', 'mc-fixture');
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE goals (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
        status TEXT NOT NULL, capabilities TEXT NOT NULL, model TEXT, metadata TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE loop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, level TEXT, message TEXT, created_at TEXT);
    `);
    handle = { db, mode: 'live', close: () => db.close() };
    server = new McpServer({ name: 'mission-control-fixture', version: '1' });
    registerMissionControlTools(server, handle);
  });

  afterEach(() => handle.close());

  it('registers both mission control tools', () => {
    expect(getHandler('djimitflo_get_mission_control')).toBeDefined();
    expect(getHandler('djimitflo_get_system_health')).toBeDefined();
  });

  it('reports empty summary and provenance on an empty database', async () => {
    const body = parse(await getHandler('djimitflo_get_mission_control')());
    expect(body.database).toMatchObject({ instance_id: 'mc-fixture', mode: 'live' });
    expect(body.summary).toEqual({ activeLoans: 0, pendingGoals: 0, activeAgents: 0, runningWorkers: 0 });
    expect(body.recentEvents).toEqual([]);
  });

  it('counts only the matching statuses for each summary field', async () => {
    db.prepare("INSERT INTO loop_runs VALUES ('l1','running')").run();
    db.prepare("INSERT INTO loop_runs VALUES ('l2','verifying')").run();
    db.prepare("INSERT INTO loop_runs VALUES ('l3','completed')").run();
    db.prepare("INSERT INTO goals VALUES ('g1','created')").run();
    db.prepare("INSERT INTO goals VALUES ('g2','approved')").run();
    db.prepare("INSERT INTO agents VALUES ('a1','A','d','active','[]',NULL,NULL,'t','t')").run();
    db.prepare("INSERT INTO agents VALUES ('a2','B','d','idle','[]',NULL,NULL,'t','t')").run();
    db.prepare("INSERT INTO worker_leases VALUES ('w1','running')").run();
    db.prepare("INSERT INTO worker_leases VALUES ('w2','released')").run();

    const body = parse(await getHandler('djimitflo_get_mission_control')());
    expect(body.summary).toEqual({ activeLoans: 2, pendingGoals: 1, activeAgents: 1, runningWorkers: 1 });
  });

  it('returns the five most recent events in descending order', async () => {
    for (let i = 0; i < 7; i += 1) {
      db.prepare('INSERT INTO loop_events (event_type, level, message, created_at) VALUES (?, ?, ?, ?)').run(
        'tick', 'info', `msg-${i}`, `2026-10-10T00:00:${String(i).padStart(2, '0')}Z`,
      );
    }
    const body = parse(await getHandler('djimitflo_get_mission_control')());
    expect(body.recentEvents).toHaveLength(5);
    expect(body.recentEvents[0].message).toBe('msg-6');
    expect(body.recentEvents[4].message).toBe('msg-2');
  });

  it('reports table counts and only error/critical recent errors', async () => {
    db.prepare("INSERT INTO goals VALUES ('g1','created')").run();
    db.prepare('INSERT INTO loop_events (event_type, level, message, created_at) VALUES (?, ?, ?, ?)').run('ok', 'info', 'fine', 't1');
    db.prepare('INSERT INTO loop_events (event_type, level, message, created_at) VALUES (?, ?, ?, ?)').run('boom', 'error', 'bad', 't2');
    db.prepare('INSERT INTO loop_events (event_type, level, message, created_at) VALUES (?, ?, ?, ?)').run('fatal', 'critical', 'worse', 't3');

    const body = parse(await getHandler('djimitflo_get_system_health')());
    expect(body.database.instance_id).toBe('mc-fixture');
    expect(typeof body.tableCounts.goals).toBe('number');
    expect(body.tableCounts.loop_runs).toBeDefined();
    // The health query returns event_type/message/created_at (no level column).
    expect(body.recentErrors.map((e: any) => e.event_type)).toEqual(['fatal', 'boom']);
  });
});
