/**
 * Forensic audit 2026-10-26 OBS-001: the live SSE stream has a bounded backpressure/drop contract.
 * A client that stops reading (fake slow client: a raw socket that never reads) must not make the server retain
 * unbounded bytes; dropped events are counted truthfully, a drain reports the loss, a stall ends the stream
 * finitely and every end path unsubscribes from the bus.
 */
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createObservabilityRoutes } from '../routes/observability';
import { swarmEventBus } from '../services/swarm-event-bus';

const EVENT_BYTES = 32 * 1024; // each event is ~32 KiB on the wire
const RETAINED_CEILING = 128 * 1024; // writable high-water mark + one max-size frame, with headroom
const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise((r) => setTimeout(r, 10)); }
};

describe('observability SSE backpressure (OBS-001)', () => {
  let server: Server;
  let db: ReturnType<typeof createTestDb>;
  let streamRes: ServerResponse | null;
  let port: number;
  const baseListeners = swarmEventBus.getListenerCount();

  beforeEach(async () => {
    process.env.SSE_STALL_TIMEOUT_MS = '400';
    db = createTestDb();
    const auth = { requireAuth: (_q: any, _s: any, next: any) => next(), requirePermission: () => (_q: any, _s: any, next: any) => next() } as any;
    streamRes = null;
    const app = express()
      .use((_req, res, next) => { streamRes = res; next(); })
      .use('/observability', createObservabilityRoutes(db, auth));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    delete process.env.SSE_STALL_TIMEOUT_MS;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  /** A client that sends the request and then never reads: the kernel buffer fills and res.write starts returning false. */
  async function slowClient(): Promise<net.Socket> {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`GET /observability/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    socket.pause();
    await until(() => swarmEventBus.getListenerCount() === baseListeners + 1);
    return socket;
  }

  function flood(n: number): void {
    const blob = 'x'.repeat(EVENT_BYTES);
    for (let i = 0; i < n; i++) swarmEventBus.emit('budget_burn', { i, blob });
  }

  it('bounds retained bytes and counts dropped events for a client that stops reading', async () => {
    const socket = await slowClient();
    const droppedBefore = swarmEventBus.getDroppedEvents();
    try {
      flood(400); // ~12.5 MiB offered, far beyond any socket buffer
      expect(streamRes!.writableLength).toBeLessThanOrEqual(RETAINED_CEILING);
      expect(swarmEventBus.getDroppedEvents() - droppedBefore).toBeGreaterThan(0);
    } finally {
      socket.destroy();
    }
  });

  it('ends a stalled stream finitely and unsubscribes from the bus', async () => {
    const socket = await slowClient();
    // keep offering events until the kernel socket buffers are full too and no drain can come
    const pump = setInterval(() => flood(20), 10);
    try {
      await until(() => swarmEventBus.getListenerCount() === baseListeners, 5_000);
      expect(streamRes!.writableLength).toBeLessThanOrEqual(RETAINED_CEILING);
      expect(streamRes!.destroyed || streamRes!.writableEnded).toBe(true);
    } finally {
      clearInterval(pump);
      socket.destroy();
    }
  });

  it('reports the loss to the client after a drain', async () => {
    process.env.SSE_STALL_TIMEOUT_MS = '10000';
    const socket = await slowClient();
    let received = '';
    try {
      flood(400);
      socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
      socket.resume();
      await until(() => /"type":"stream_dropped"/.test(received), 5_000);
      const notice = received.split('\n').find((l) => l.includes('"stream_dropped"'))!;
      const event = JSON.parse(notice.slice(notice.indexOf('{')));
      expect(event.data.dropped).toBeGreaterThan(0);
      // the stream stays open after a drain: new events still arrive
      swarmEventBus.emit('convergence', { after: 'drain' });
      await until(() => received.includes('"after":"drain"'));
    } finally {
      socket.destroy();
    }
  });

  it('unsubscribes when the client disconnects', async () => {
    const socket = await slowClient();
    socket.destroy();
    await until(() => swarmEventBus.getListenerCount() === baseListeners);
  });
});
