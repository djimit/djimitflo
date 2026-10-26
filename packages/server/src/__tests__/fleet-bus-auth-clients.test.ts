import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile, execFileSync, spawnSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { schema } from '../database/schema';
import { runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';
import { EventOutboxService, enqueueEvent } from '../services/event-outbox-service';
import { BoardHandoffService } from '../services/board-handoff-service';
import { AgentRegistrySyncService } from '../services/agent-registry-sync-service';
import { fetchFleetAgents } from '../routes/federation';

/**
 * S3 (docs/runbooks/fleet-bus-auth.md): every Djimitflo client of the fleet event bus and agent registry sends this host's
 * bearer token when one is configured, so the services can move from AUTH_MODE=log to enforce without losing a caller.
 */
const TOKEN = 'test-host-token-0123456789abcdef';
const SCRIPTS = path.resolve(__dirname, '../../../../scripts');
const run = promisify(execFile);

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runPreSchemaMigrations(db);
  db.exec(schema);
  runMigrations(db);
  return db;
}

const okJson = (body: unknown) => vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
const authOf = (fetchMock: ReturnType<typeof vi.fn>): string | undefined =>
  new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get('authorization') ?? undefined;

describe('S3 Djimitflo bus/registry clients send the host bearer token', () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('ingest polls the bus with DJIMIT_EVENT_BUS_TOKEN', async () => {
    vi.stubEnv('DJIMIT_EVENT_BUS_TOKEN', TOKEN);
    const fetchMock = okJson({ events: [] });
    vi.stubGlobal('fetch', fetchMock);
    await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
    expect(authOf(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('ingest sends no Authorization header when no token is set (unchanged behaviour)', async () => {
    vi.stubEnv('DJIMIT_EVENT_BUS_TOKEN', '');
    const fetchMock = okJson({ events: [] });
    vi.stubGlobal('fetch', fetchMock);
    await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
    expect(authOf(fetchMock)).toBeUndefined();
  });

  it('outbox publishes with the token', async () => {
    vi.stubEnv('EVENT_PUBLISH_ENABLED', 'true');
    vi.stubEnv('DJIMIT_EVENT_BUS_URL', 'http://event-bus');
    vi.stubEnv('DJIMIT_EVENT_BUS_TOKEN', TOKEN);
    enqueueEvent(db, { type: 'djimitflo.x', aggregateId: 'a' });
    const fetchMock = okJson({ id: '1-0' });
    expect((await new EventOutboxService(db, fetchMock as unknown as typeof fetch).publishPending()).published).toBe(1);
    expect(authOf(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('board handoff publishes with the token', async () => {
    vi.stubEnv('DJIMIT_EVENT_BUS_URL', 'http://event-bus');
    vi.stubEnv('DJIMIT_EVENT_BUS_TOKEN', TOKEN);
    const service = new BoardHandoffService(db);
    db.prepare("INSERT INTO board_handoff_outbox (source_ref, event_id, payload) VALUES ('ref-1', 'ev-1', '{\"event_type\":\"x\"}')").run();
    const fetchMock = okJson({ id: '1-0' });
    vi.stubGlobal('fetch', fetchMock);
    expect((await service.publishPending()).published).toBe(1);
    expect(authOf(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('registry sync and fleet discovery use AGENT_REGISTRY_TOKEN, else the bus token', async () => {
    vi.stubEnv('AGENT_REGISTRY_URL', 'http://agent-registry');
    vi.stubEnv('DJIMIT_EVENT_BUS_TOKEN', TOKEN);
    vi.stubEnv('AGENT_REGISTRY_TOKEN', '');
    const syncFetch = okJson([]);
    expect((await new AgentRegistrySyncService(db, syncFetch as unknown as typeof fetch).sync()).status).toBe('OK');
    expect(authOf(syncFetch)).toBe(`Bearer ${TOKEN}`);

    vi.stubEnv('AGENT_REGISTRY_TOKEN', 'registry-specific-token');
    const fleetFetch = okJson([]);
    vi.stubGlobal('fetch', fleetFetch);
    expect((await fetchFleetAgents('http://agent-registry')).ok).toBe(true);
    expect(authOf(fleetFetch)).toBe('Bearer registry-specific-token');
  });
});

const python = spawnSync('python3', ['--version']).status === 0;
const git = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!python)('S3 host emitters (scripts/) send the host bearer token', () => {
  let server: http.Server;
  let bus: string;
  let seen: Array<{ method?: string; authorization?: string }>;
  let dir: string;
  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, authorization: req.headers.authorization });
      req.resume();
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(req.method === 'GET' ? '{"events":[]}' : '{"id":"1-0"}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bus = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bus-token-'));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string>) => {
    const base: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
    delete base.DJIMIT_EVENT_BUS_TOKEN;
    delete base.DJIMIT_FLEET_BUS_TOKEN_FILE;
    return { ...base, ...extra };
  };

  it('emit-agent-outcome.py reads ~/.djimit/fleet-bus.token', async () => {
    fs.mkdirSync(path.join(dir, '.djimit'));
    fs.writeFileSync(path.join(dir, '.djimit', 'fleet-bus.token'), `${TOKEN}\n`, { mode: 0o600 });
    await run('python3', [path.join(SCRIPTS, 'emit-agent-outcome.py'), '--agent', 'hermes', '--task-kind', 'briefing', '--success', 'true', '--bus', bus], { env: env({}) });
    expect(seen).toEqual([{ method: 'POST', authorization: `Bearer ${TOKEN}` }]);
  });

  it('fleet-discovery-publisher.py sends DJIMIT_EVENT_BUS_TOKEN on the interest read and on every publish', async () => {
    fs.writeFileSync(path.join(dir, 'briefing.md'), '"A Paper About Agent Tooling" — https://arxiv.org/abs/2609.12345\n');
    await run('python3', [path.join(SCRIPTS, 'fleet-discovery-publisher.py'), '--agent', 'hermes-macmini', '--dir', dir, '--interests-from-bus',
      '--bus', bus, '--state', path.join(dir, 'sent.json')], { env: env({ DJIMIT_EVENT_BUS_TOKEN: TOKEN }) });
    expect(seen).toEqual([{ method: 'GET', authorization: `Bearer ${TOKEN}` }, { method: 'POST', authorization: `Bearer ${TOKEN}` }]);
  });

  it('emitters without a token send no Authorization header (unchanged behaviour)', async () => {
    await run('python3', [path.join(SCRIPTS, 'emit-agent-outcome.py'), '--agent', 'hermes', '--task-kind', 'briefing', '--success', 'true', '--bus', bus], { env: env({}) });
    expect(seen).toEqual([{ method: 'POST', authorization: undefined }]);
  });

  it.skipIf(!git)('wiki-delta-emitter.sh hands the token to curl on stdin, never on argv', () => {
    const wiki = path.join(dir, 'wiki');
    fs.mkdirSync(wiki);
    const g = (...args: string[]) => execFileSync('git', ['-C', wiki, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]).toString().trim();
    g('init', '-q');
    fs.writeFileSync(path.join(wiki, 'a.md'), 'one');
    g('add', '.'); g('commit', '-qm', 'one');
    const first = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(wiki, 'a.md'), 'two');
    g('commit', '-qam', 'two');
    const state = path.join(dir, 'state');
    fs.writeFileSync(state, `${first}\n`);
    const fakeCurl = path.join(dir, 'curl');
    fs.writeFileSync(fakeCurl, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, '.djimit'));
    fs.writeFileSync(path.join(dir, '.djimit', 'fleet-bus.token'), `${TOKEN}\n`, { mode: 0o600 });
    execFileSync('bash', [path.join(SCRIPTS, 'wiki-delta-emitter.sh')], { env: env({ WIKI_DIR: wiki, WIKI_EMITTER_STATE: state, CURL_BIN: fakeCurl }) });
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
    const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8');
    expect(argv).toContain('--config');
    expect(argv).not.toContain(TOKEN);
  });
});
