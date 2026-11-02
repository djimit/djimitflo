/**
 * O2c (re-20261029 C-reliability candidate 6): agents read a July snapshot through this MCP server as if it were prod.
 * Every response of a db.ts-backed tool now carries a data label: data_as_of (newest loop_runs.created_at, else the DB
 * file's mtime) and is_production (true only for the prod path /data/djimitflo.sqlite).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { dataLabel, PROD_DB_PATH, type DbHandle } from '../db.js';
import { registerTools } from '../index.js';

let tempDir: string | undefined;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; });

const handleOf = (db: Database.Database, path?: string): DbHandle => ({ db, path, close: () => db.close() });
const label = (result: { content: Array<{ type: string; text: string }> }) => {
  const block = result.content.find((c) => c.type === 'text' && c.text.includes('"data_as_of"'));
  return block ? JSON.parse(block.text) as { data_as_of: string | null; is_production: boolean; db_path: string } : null;
};

describe('dataLabel', () => {
  it('data_as_of = newest loop_runs.created_at; a non-prod path is not production', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE loop_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); INSERT INTO loop_runs VALUES ('a', '2026-07-01T10:00:00Z'), ('b', '2026-07-14T09:00:00Z')");
    expect(dataLabel(handleOf(db, '/Users/x/.data/djimitflo.sqlite'))).toEqual({ data_as_of: '2026-07-14T09:00:00Z', is_production: false, db_path: '/Users/x/.data/djimitflo.sqlite' });
    expect(dataLabel(handleOf(db, PROD_DB_PATH)).is_production).toBe(true);
    expect(PROD_DB_PATH).toBe('/data/djimitflo.sqlite');
    db.close();
  });

  it('no loop_runs rows: the DB file mtime; no file either: null (unknown), never now', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-label-'));
    const file = join(tempDir, 'djimitflo.sqlite');
    const db = new Database(file); db.exec('CREATE TABLE loop_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    const mtime = new Date('2026-07-20T00:00:00Z'); utimesSync(file, mtime, mtime);
    expect(dataLabel(handleOf(db, file)).data_as_of).toBe(mtime.toISOString());
    db.close();
    const mem = new Database(':memory:');
    expect(dataLabel(handleOf(mem, ':memory:'))).toMatchObject({ data_as_of: null, is_production: false });
    mem.close();
  });
});

describe('every db-backed tool response carries the label', () => {
  it('list_loop_runs and get_loop_status (also the error path) are labelled; content[0] is unchanged', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, mode TEXT, status TEXT, gates_json TEXT, next_actions_json TEXT, created_at TEXT NOT NULL, updated_at TEXT, completed_at TEXT);
      CREATE TABLE worker_leases (id TEXT, loop_run_id TEXT, role TEXT, status TEXT, runtime TEXT, created_at TEXT);
      CREATE TABLE loop_events (loop_run_id TEXT, event_type TEXT, severity TEXT, message TEXT, created_at TEXT);
      INSERT INTO loop_runs VALUES ('r1', 'doc-drift-and-small-fix-loop', 'closed', 'completed', '[]', '[]', '2026-07-14T09:00:00Z', '2026-07-14T09:00:00Z', NULL);`);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTools(server, handleOf(db, '/tmp/snapshot.sqlite'));
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> })._registeredTools;
    const list = await tools.djimitflo_list_loop_runs.handler({});
    expect(JSON.parse(list.content[0].text)).toHaveLength(1);
    expect(label(list)).toEqual({ data_as_of: '2026-07-14T09:00:00Z', is_production: false, db_path: '/tmp/snapshot.sqlite' });
    const missing = await tools.djimitflo_get_loop_status.handler({ runId: 'nope' });
    expect(missing.isError).toBe(true);
    expect(label(missing)?.is_production).toBe(false);
    expect(label(await tools.djimitflo_get_loop_status.handler({ runId: 'r1' }))?.data_as_of).toBe('2026-07-14T09:00:00Z');
    db.close();
  });

  it('every tool registered with the DB handle is wrapped; the OKF / notebook tools (no DB) are not', async () => {
    const db = new Database(':memory:');
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTools(server, handleOf(db, '/tmp/snapshot.sqlite'));
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })._registeredTools;
    const labelled = Object.entries(tools).filter(([, t]) => (t.handler as { djimitfloDataLabel?: boolean }).djimitfloDataLabel).map(([n]) => n);
    expect(labelled).toEqual(expect.arrayContaining(['djimitflo_list_loop_runs', 'djimitflo_list_goals', 'djimitflo_list_agents', 'djimitflo_get_mission_control', 'djimitflo_openmythos_leaderboard', 'explainer_list_tasks', 'djimitflo_authority_stats']));
    expect(labelled.some((n) => n.startsWith('okf_') || n.startsWith('notebook_'))).toBe(false);
    db.close();
  });
});
