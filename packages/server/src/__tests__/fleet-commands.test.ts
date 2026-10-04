import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FleetCommands } from '../services/fleet-commands';
import { createFleetHostRoutes, createHostAgentRoutes, HOST_AGENT_SCOPE } from '../routes/host-agent';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';

let db: Database.Database; let fleet: FleetCommands;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); fleet = new FleetCommands(db); });
afterEach(() => { db.close(); vi.useRealTimers(); });

it('runs diagnostics without approval and holds shell commands until a hash-bound human approval', () => {
  const ping = fleet.request('workstation', 'ping', 'op');
  const shell = fleet.request('workstation', 'systemctl restart foo', 'op');
  expect([ping.kind, ping.status, shell.kind, shell.status]).toEqual(['diagnostic', 'queued', 'shell', 'pending_approval']);
  expect(fleet.poll('workstation').map((c) => c.command)).toEqual(['ping']);
  expect(() => fleet.approve(shell.id, 'op', sha('systemctl restart bar'))).toThrow('FLEET_COMMAND_HASH_MISMATCH');
  fleet.approve(shell.id, 'dennis', sha('systemctl restart foo'));
  expect(fleet.poll('macmini')).toEqual([]); // another host never receives it
  expect(fleet.poll('workstation')).toEqual([{ id: shell.id, kind: 'shell', command: 'systemctl restart foo', sha256: sha('systemctl restart foo') }]);
  expect(fleet.poll('workstation')).toEqual([]); // delivered once
  expect(() => fleet.result(shell.id, 'macmini', 0, '')).toThrow('FLEET_COMMAND_NOT_FOUND');
  fleet.result(shell.id, 'workstation', 0, 'restarted; password=hunter2secret');
  expect(fleet.get(shell.id)).toMatchObject({ status: 'done', exit_code: 0, approved_by: 'dennis' });
  expect(fleet.get(shell.id)!.output).not.toContain('hunter2secret');
});

it('lets an unused approval lapse after 15 minutes, and records denials', () => {
  vi.useFakeTimers({ now: Date.parse('2026-09-29T00:00:00Z') });
  const c = fleet.request('workstation', 'reboot', 'op');
  fleet.approve(c.id, 'dennis', sha('reboot'));
  vi.setSystemTime(Date.parse('2026-09-29T00:16:00Z'));
  expect(fleet.poll('workstation')).toEqual([]);
  expect(fleet.get(c.id)!.status).toBe('expired');
  const d = fleet.request('workstation', 'rm -rf /tmp/x', 'op');
  expect(fleet.deny(d.id, 'dennis', 'not now')).toMatchObject({ status: 'denied', decided_reason: 'not now' });
  expect(() => fleet.approve(d.id, 'dennis', sha('rm -rf /tmp/x'))).toThrow('FLEET_COMMAND_NOT_PENDING');
  expect(fleet.hosts(Date.parse('2026-09-29T00:16:30Z'))).toEqual([expect.objectContaining({ host: 'workstation', live: true, seconds_ago: 30 })]);
});

it('routes: agents need their host token; approval needs approve:task', async () => {
  const perms: Record<string, string[]> = { viewer: ['read:evidence'], admin: ['read:evidence', 'manage:config', 'approve:task', 'manage:tokens'] };
  const auth = {
    requireAuth: (req: any, res: any, next: any) => { const role = String(req.get('X-Role') || ''); if (!perms[role]) return res.status(401).end(); req.user = { sub: role }; next(); },
    requirePermission: (p: string) => (req: any, res: any, next: any) => (perms[req.user?.sub]?.includes(p) ? next() : res.status(403).end()),
  } as any;
  const app = express(); app.use(express.json());
  app.use('/api/host-agent', createHostAgentRoutes(db, auth));
  app.use('/api/fleet-hosts', auth.requireAuth, createFleetHostRoutes(db, auth));
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', HOST_AGENT_SCOPE, 60_000);
  expect((await request(app).post('/api/host-agent/poll').set('X-Host', 'workstation').set('X-Host-Token', 'bad')).status).toBe(401);
  expect((await request(app).post('/api/host-agent/poll').set('X-Host', 'macmini').set('X-Host-Token', token)).status).toBe(401); // token of another host
  const created = await request(app).post('/api/fleet-hosts/commands').set('X-Role', 'admin').send({ host: 'workstation', command: 'whoami' });
  expect(created.status).toBe(201);
  expect((await request(app).post(`/api/fleet-hosts/commands/${created.body.id}/approve`).set('X-Role', 'viewer').send({ sha256: sha('whoami') })).status).toBe(403);
  expect((await request(app).post(`/api/fleet-hosts/commands/${created.body.id}/approve`).set('X-Role', 'admin').send({ sha256: sha('whoami') })).status).toBe(200);
  const polled = await request(app).post('/api/host-agent/poll').set('X-Host', 'workstation').set('X-Host-Token', token).send({ version: '1', info: { os: 'linux' } });
  expect(polled.body.commands.map((c: any) => c.command)).toEqual(['whoami']);
  expect((await request(app).post(`/api/host-agent/commands/${created.body.id}/result`).set('X-Host', 'workstation').set('X-Host-Token', token).send({ exit_code: 0, output: 'root' })).status).toBe(200);
  const list = await request(app).get('/api/fleet-hosts').set('X-Role', 'viewer');
  expect(list.body.hosts[0]).toMatchObject({ host: 'workstation', live: true, agent_version: '1' });
  expect(list.body.commands[0]).toMatchObject({ status: 'done', output: 'root', requested_by: 'admin', approved_by: 'admin' });
});
