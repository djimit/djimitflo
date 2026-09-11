import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createTestDb } from './helpers/test-db';
import { createFederationRoutes } from '../routes/federation';

describe('federation work distribution', () => {
  const servers: Server[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }))));

  it('checks peer capacity, dispatches work, and returns the peer result', async () => {
    let offered: unknown;
    const peer = express();
    peer.use(express.json());
    peer.get('/api/federation/capacity', (_req, res) => res.json({ available: true, active: 0, limit: 4 }));
    peer.post('/api/federation/inbox/work', (req, res) => { offered = req.body; res.status(202).json({ accepted: true, loop_run_id: 'remote-run' }); });
    servers.push(await new Promise<Server>(resolve => { const listening = peer.listen(0, () => resolve(listening)); }));

    const db = createTestDb();
    const app = express();
    app.use(express.json());
    const auth = { requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() } as any;
    app.use('/federation', createFederationRoutes(db, auth));
    servers.push(await new Promise<Server>(resolve => { const listening = app.listen(0, () => resolve(listening)); }));
    const peerUrl = `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`;
    db.prepare("INSERT INTO federation_peers (id,url,trust_level,metadata) VALUES ('peer-1',?,'high','{}')").run(peerUrl);

    const response = await fetch(`http://127.0.0.1:${(servers[1].address() as AddressInfo).port}/federation/work`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal_objective: 'Fix the bounded issue' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, peer_id: 'peer-1', result: { loop_run_id: 'remote-run' } });
    expect(offered).toMatchObject({ goal_objective: 'Fix the bounded issue' });
    db.close();
  });

  it('uses the monorepo root for inbox work when launched from packages/server', async () => {
    const previousEvidenceRoot = process.env.LOOP_EVIDENCE_ROOT;
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-loop-'));
    process.env.LOOP_EVIDENCE_ROOT = evidenceRoot;
    const db = createTestDb();
    const app = express();
    app.use(express.json());
    const auth = { requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() } as any;
    app.use('/federation', createFederationRoutes(db, auth));
    const local = await new Promise<Server>(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    servers.push(local);
    try {
      const response = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/federation/inbox/work`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal_objective: 'Use the canonical repository root' }),
      });
      expect(response.status).toBe(202);
      const run = db.prepare('SELECT repository_path FROM loop_runs ORDER BY created_at DESC LIMIT 1').get() as { repository_path: string };
      const expectedRoot = process.cwd().endsWith(path.join('packages', 'server')) ? path.resolve(process.cwd(), '../..') : process.cwd();
      expect(run.repository_path).toBe(expectedRoot);
    } finally {
      db.close();
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
      if (previousEvidenceRoot === undefined) delete process.env.LOOP_EVIDENCE_ROOT;
      else process.env.LOOP_EVIDENCE_ROOT = previousEvidenceRoot;
    }
  });

  it('registers a peer and projects trusted local capabilities', async () => {
    const db = createTestDb();
    const app = express();
    app.use(express.json());
    const auth = { requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() } as any;
    app.use('/federation', createFederationRoutes(db, auth));
    const local = await new Promise<Server>(resolve => { const listening = app.listen(0, () => resolve(listening)); });
    servers.push(local);
    try {
      const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}/federation`;
      const registered = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://peer.fixture.test', trust_level: 'high', metadata: { fixture: true } }) });
      expect(registered.status).toBe(201);
      expect(await registered.json()).toMatchObject({ url: 'https://peer.fixture.test', trust_level: 'high', registered: true });
      db.prepare(`INSERT INTO swarm_capabilities (id,kind,owner,version,status,risk_ceiling,removal_strategy) VALUES (?,?,?,?,?,?,?)`).run('cap-fixture', 'skill', 'fixture', '1.0.0', 'validated', 'low', 'remove');
      expect((await (await fetch(`${base}/peers`)).json()).peers).toHaveLength(1);
      expect((await (await fetch(`${base}/capabilities`)).json()).capabilities).toMatchObject([{ id: 'cap-fixture', status: 'validated' }]);
    } finally { db.close(); }
  });
});
