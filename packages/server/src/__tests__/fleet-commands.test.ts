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
  expect(list.body.hosts[0]).toMatchObject({ host: 'workstation', live: true, agent_version: '1', info: { os: 'linux' } });
  expect(list.body.commands[0]).toMatchObject({ status: 'done', output: 'root', requested_by: 'admin', approved_by: 'admin' });
});

it('rejects invalid host, command, and actor in request', () => {
  expect(() => fleet.request('invalid host!', 'ping', 'op')).toThrow('FLEET_HOST_INVALID');
  expect(() => fleet.request('!workstation', 'ping', 'op')).toThrow('FLEET_HOST_INVALID');
  expect(() => fleet.request('workstation!', 'ping', 'op')).toThrow('FLEET_HOST_INVALID');
  expect(() => fleet.request('x'.repeat(81), 'ping', 'op')).toThrow('FLEET_HOST_INVALID');
  expect(() => fleet.request('workstation', '', 'op')).toThrow('FLEET_COMMAND_INVALID');
  expect(() => fleet.request('workstation', 'x'.repeat(4001), 'op')).toThrow('FLEET_COMMAND_INVALID');
  expect(() => fleet.request('workstation', null as any, 'op')).toThrow('FLEET_COMMAND_INVALID');
  expect(() => fleet.request('workstation', 'ping', '  ')).toThrow('FLEET_ACTOR_REQUIRED');
  expect(() => fleet.request('workstation', 'ping', '')).toThrow('FLEET_ACTOR_REQUIRED');
  expect(fleet.request('workstation', 'x'.repeat(4000), 'op').command).toHaveLength(4000);
});

it('approve: validates existence, pending status, empty approver, hash mismatch, and records self-approval', () => {
  const c = fleet.request('workstation', 'reboot', 'op');
  expect(() => fleet.approve('nonexistent-id', 'op', sha('reboot'))).toThrow('FLEET_COMMAND_NOT_FOUND');
  expect(() => fleet.approve(c.id, '  ', sha('reboot'))).toThrow('FLEET_ACTOR_REQUIRED');
  expect(() => fleet.approve(c.id, 'dennis', sha('wrong'))).toThrow('FLEET_COMMAND_HASH_MISMATCH');
  const approved = fleet.approve(c.id, 'op', sha('reboot'));
  expect(approved.self_approved).toBeTruthy();
  const c2 = fleet.request('workstation', 'whoami', 'alice');
  const approved2 = fleet.approve(c2.id, 'bob', sha('whoami'));
  expect(approved2.self_approved).toBeFalsy();
  expect(() => fleet.approve(c.id, 'dennis', sha('reboot'))).toThrow('FLEET_COMMAND_NOT_PENDING');
  const c3 = fleet.request('workstation', 'ls', 'op');
  db.prepare('UPDATE fleet_commands SET command_sha256 = ? WHERE id = ?').run(sha('tampered'), c3.id);
  expect(() => fleet.approve(c3.id, 'dennis', sha('tampered'))).toThrow('FLEET_COMMAND_HASH_MISMATCH');
});

it('deny: validates existence, pending/queued status, and truncates long reasons', () => {
  expect(() => fleet.deny('nonexistent-id', 'op')).toThrow('FLEET_COMMAND_NOT_FOUND');
  const c = fleet.request('workstation', 'reboot', 'op');
  fleet.approve(c.id, 'dennis', sha('reboot'));
  const denied = fleet.deny(c.id, 'dennis', 'x'.repeat(500));
  expect(denied).toMatchObject({ status: 'denied' });
  expect(denied.decided_reason).toHaveLength(300);
  const done = fleet.request('workstation', 'uptime', 'op');
  fleet.poll('workstation');
  fleet.result(done.id, 'workstation', 0, 'up');
  expect(() => fleet.deny(done.id, 'dennis')).toThrow('FLEET_COMMAND_NOT_PENDING');
});

it('result: validates running status and exit code mapping', () => {
  const c = fleet.request('workstation', 'reboot', 'op');
  expect(() => fleet.result(c.id, 'workstation', 0, '')).toThrow('FLEET_COMMAND_NOT_RUNNING');
  fleet.approve(c.id, 'dennis', sha('reboot'));
  fleet.poll('workstation');
  fleet.result(c.id, 'workstation', 1, 'error');
  expect(fleet.get(c.id)).toMatchObject({ status: 'failed', exit_code: 1 });
  const d = fleet.request('workstation', 'ping', 'op');
  fleet.poll('workstation');
  fleet.result(d.id, 'workstation', 1.5 as any, 'partial');
  expect(fleet.get(d.id)!.exit_code).toBeNull();
  const e = fleet.request('workstation', 'uptime', 'op');
  fleet.poll('workstation');
  fleet.result(e.id, 'workstation', 0, null as any);
  expect(fleet.get(e.id)!.output).toBe('');
});

it('poll: caps version and info, and filters tampered commands', () => {
  fleet.poll('workstation', { os: 'linux' }, 'x'.repeat(50));
  const h = fleet.hosts()[0];
  expect(h.agent_version).toHaveLength(40);
  const bigInfo: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) bigInfo[`key${i}`] = 'x'.repeat(30);
  fleet.poll('macmini', bigInfo, '1');
  const stored = db.prepare('SELECT info_json FROM fleet_hosts WHERE host = ?').get('macmini') as { info_json: string };
  expect(stored.info_json.length).toBeLessThanOrEqual(4000);
  const tampered = fleet.request('workstation', 'rm -rf /', 'op');
  fleet.approve(tampered.id, 'dennis', sha('rm -rf /'));
  db.prepare('UPDATE fleet_commands SET command_sha256 = ? WHERE id = ?').run(sha('WRONG'), tampered.id);
  const delivered = fleet.poll('workstation');
  expect(delivered.map((c) => c.command)).not.toContain('rm -rf /');
});

it('hosts: live boundary at 120 seconds and handles empty info_json', () => {
  vi.useFakeTimers({ now: Date.parse('2026-09-29T00:00:00Z') });
  fleet.poll('workstation', { os: 'linux' }, '1');
  vi.setSystemTime(Date.parse('2026-09-29T00:02:00Z'));
  expect(fleet.hosts()[0].live).toBe(true);
  vi.setSystemTime(Date.parse('2026-09-29T00:02:01Z'));
  expect(fleet.hosts()[0].live).toBe(false);
  db.prepare("INSERT INTO fleet_hosts (host, last_seen, agent_version, info_json) VALUES (?, ?, ?, ?)")
    .run('emptyinfo', '2026-09-29T00:00:00Z', null, '');
  const hosts = fleet.hosts(Date.parse('2026-09-29T00:00:00Z'));
  const empty = hosts.find((h) => h.host === 'emptyinfo')!;
  expect(empty.info).toEqual({});
});

it('poll: never hands out a shell row without a future expiry and a recorded, sha-matching human approval', () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-30T00:00:00Z') });
  const insert = (command: string, extra: { approved_by?: string | null; approved_at?: string | null; expires_at?: string | null }) => {
    const id = `row-${command.replace(/\W/g, '')}`;
    db.prepare(`INSERT INTO fleet_commands (id, host, kind, command, command_sha256, status, requested_by, approved_by, approved_at, expires_at, created_at)
      VALUES (?, 'workstation', 'shell', ?, ?, 'queued', 'op', ?, ?, ?, ?)`)
      .run(id, command, sha(command), extra.approved_by ?? null, extra.approved_at ?? null, extra.expires_at ?? null, '2026-10-29T23:59:00Z');
    return id;
  };
  const noExpiry = insert('id one', { approved_by: 'dennis', approved_at: '2026-10-29T23:59:30Z', expires_at: null });
  const noAudit = insert('id two', { approved_by: 'dennis', approved_at: '2026-10-29T23:59:30Z', expires_at: '2026-10-30T00:10:00Z' });
  const unapproved = insert('id three', { expires_at: '2026-10-30T00:10:00Z' });
  // approved through the service, then the text (and its sha) swapped: the recorded approval is for another sha
  const swapped = fleet.request('workstation', 'uptime -p', 'op');
  fleet.approve(swapped.id, 'dennis', sha('uptime -p'));
  db.prepare('UPDATE fleet_commands SET command = ?, command_sha256 = ? WHERE id = ?').run('id four', sha('id four'), swapped.id);
  // a real approval whose expiry was pushed past the approval window
  const stretched = fleet.request('workstation', 'hostname', 'op');
  fleet.approve(stretched.id, 'dennis', sha('hostname'));
  db.prepare('UPDATE fleet_commands SET expires_at = ? WHERE id = ?').run('2099-01-01T00:00:00Z', stretched.id);
  const legit = fleet.request('workstation', 'whoami', 'op');
  fleet.approve(legit.id, 'dennis', sha('whoami'));
  const ping = fleet.request('workstation', 'ping', 'op');

  expect(fleet.poll('workstation').map((c) => c.id).sort()).toEqual([legit.id, ping.id].sort());
  for (const id of [noExpiry, noAudit, unapproved, swapped.id, stretched.id]) {
    const row = fleet.get(id)!;
    expect(row.status, id).toBe('refused'); // marked with a reason, never deleted
    expect(row.decided_reason, id).toMatch(/^shell_/);
    expect(row.finished_at, id).toBeTruthy();
  }
  expect(fleet.get(noExpiry)!.decided_reason).toBe('shell_expiry_missing_or_invalid');
  expect(fleet.get(stretched.id)!.decided_reason).toBe('shell_expiry_missing_or_invalid');
  expect(fleet.get(noAudit)!.decided_reason).toBe('shell_approval_not_recorded');
  expect(fleet.get(unapproved)!.decided_reason).toBe('shell_approval_not_recorded');
  expect(fleet.get(swapped.id)!.decided_reason).toBe('shell_approval_not_recorded');
  expect(fleet.poll('workstation')).toEqual([]); // refused rows stay refused
});

it('poll: a row whose text no longer matches its sha is refused, not left running', () => {
  const c = fleet.request('workstation', 'whoami', 'op');
  fleet.approve(c.id, 'dennis', sha('whoami'));
  db.prepare('UPDATE fleet_commands SET command_sha256 = ? WHERE id = ?').run(sha('WRONG'), c.id);
  expect(fleet.poll('workstation')).toEqual([]);
  expect(fleet.get(c.id)).toMatchObject({ status: 'refused', decided_reason: 'command_sha_mismatch' });
});
