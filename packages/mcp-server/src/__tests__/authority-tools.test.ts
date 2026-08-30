import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fullSchema } from '../../../server/dist/database/schema.js';
import { runMigrations } from '../../../server/dist/database/migrate.js';
import { registerAuthorityTools } from '../tools/authority.js';

const temporary: string[] = [];

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'authority-test-'));
  temporary.push(dir);
  const db = new Database(join(dir, 'test.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(fullSchema as string);
  runMigrations(db);
  const server = new McpServer({ name: 'authority-test', version: '0' });
  registerAuthorityTools(server, { db, mode: 'live' } as never);
  return { server, db };
}

type ToolBox = Record<
  string,
  { handler: (input?: unknown) => Promise<{ content: Array<{ text: string }> }> }
>;

function toolsOf(server: McpServer): ToolBox {
  return (
    server as unknown as { _registeredTools: ToolBox }
  )._registeredTools;
}

describe('authority ledger MCP tool contracts', () => {
  it('exposes trace, emit and stats tools', () => {
    const { server } = makeServer();
    const tools = toolsOf(server);
    expect(tools).toHaveProperty('djimitflo_authority_trace');
    expect(tools).toHaveProperty('djimitflo_authority_emit');
    expect(tools).toHaveProperty('djimitflo_authority_stats');
  });

  it('emits lifecycle events and traces them back with summary', async () => {
    const { server } = makeServer();
    const tools = toolsOf(server);

    const emit = await tools.djimitflo_authority_emit.handler({
      correlationId: 'corr-e2e-1',
      previousState: 'DRAFT',
      requestedState: 'NORMALIZED',
      policyDecision: 'HOLD',
      actorSubject: 'test-runner',
      actorType: 'ci',
      artifactId: 'art-1',
      payload: { topic: 'authority' },
    });
    const emitted = JSON.parse(emit.content[0].text);
    // eslint-disable-next-line no-console
    expect(emitted.emitted).toBe(true);
    expect(emitted.sequence).toBe(1);
    expect(emitted.payload_digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const emit2 = await tools.djimitflo_authority_emit.handler({
      correlationId: 'corr-e2e-1',
      previousState: 'NORMALIZED',
      requestedState: 'POLICY_VALIDATED',
      policyDecision: 'ALLOW',
      actorSubject: 'gate',
      artifactId: 'art-1',
    });
    const second = JSON.parse(emit2.content[0].text);
    expect(second.sequence).toBe(2);

    const trace = await tools.djimitflo_authority_trace.handler({
      correlationId: 'corr-e2e-1',
    });
    const t = JSON.parse(trace.content[0].text);
    expect(t.ledger_events).toBe(2);
    expect(t.summary.last_decision).toBe('ALLOW');
    expect(t.summary.last_state).toBe('POLICY_VALIDATED');
    expect(Array.isArray(t.loop_runs)).toBe(true);
   });
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});