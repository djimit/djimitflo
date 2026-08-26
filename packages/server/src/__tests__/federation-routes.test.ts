import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
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
});
