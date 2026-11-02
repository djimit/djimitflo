/**
 * Forensic audit 2026-10-26 OBS-001: the live SSE stream has a bounded backpressure/drop contract.
 * A client that stops reading (fake slow client: a raw socket that never reads) must not make the server retain
 * unbounded bytes; dropped events are counted truthfully, a drain reports the loss, a stall ends the stream
 * finitely and every end path unsubscribes from the bus.
 *
 * Every wait is on the real event (the client receiving a frame, the server stream's 'close'), not a polled
 * deadline: the server subscribes to the bus in the same tick it writes the `connected` frame, and a stream's
 * cleanup (unsubscribe) has run once its 'close' has been emitted. Each test's streams are closed before the next
 * test starts, so no stale subscriber from an earlier test can stand in for the current one.
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

/** Resolves once the bytes the client has read match `pattern`; accumulates from the moment it is called. */
function received(socket: net.Socket, pattern: RegExp): Promise<string> {
  let text = '';
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (pattern.test(text)) { socket.off('data', onData); resolve(text); }
    };
    socket.on('data', onData);
  });
}

const frameOf = (text: string, type: string) => {
  const line = text.split('\n').find((l) => l.includes(`"type":"${type}"`))!;
  return JSON.parse(line.slice(line.indexOf('{')));
};

describe('observability SSE backpressure (OBS-001)', () => {
  let server: Server;
  let db: ReturnType<typeof createTestDb>;
  let streamRes: ServerResponse | null;
  let streamClosed: Promise<void>;
  let allClosed: Array<Promise<void>>;
  let port: number;
  const baseListeners = swarmEventBus.getListenerCount();

  beforeEach(async () => {
    process.env.SSE_STALL_TIMEOUT_MS = '400';
    db = createTestDb();
    const auth = { requireAuth: (_q: any, _s: any, next: any) => next(), requirePermission: () => (_q: any, _s: any, next: any) => next() } as any;
    streamRes = null;
    allClosed = [];
    const app = express()
      .use((_req, res, next) => {
        streamRes = res;
        streamClosed = new Promise<void>((resolve) => res.once('close', () => resolve()));
        allClosed.push(streamClosed);
        next();
      })
      .use('/observability', createObservabilityRoutes(db, auth));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    delete process.env.SSE_STALL_TIMEOUT_MS;
    server.closeAllConnections();
    await Promise.all(allClosed); // every stream of this test has run its cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    expect(swarmEventBus.getListenerCount()).toBe(baseListeners);
  });

  /**
   * Opens the stream and waits for the `connected` frame (the server is subscribed by then). A slow client then
   * stops reading: the kernel buffer fills and res.write starts returning false.
   */
  async function openClient(mode: 'slow' | 'reading'): Promise<net.Socket> {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const connected = received(socket, /"type":"connected"/);
    socket.write(`GET /observability/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    await connected;
    expect(swarmEventBus.getListenerCount()).toBe(baseListeners + 1);
    if (mode === 'slow') socket.pause();
    return socket;
  }

  function flood(n: number): void {
    const blob = 'x'.repeat(EVENT_BYTES);
    for (let i = 0; i < n; i++) swarmEventBus.emit('budget_burn', { i, blob });
  }

  it('bounds retained bytes and counts dropped events for a client that stops reading', async () => {
    const socket = await openClient('slow');
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
    const socket = await openClient('slow');
    // keep offering events until the kernel socket buffers are full too and no drain can come
    const pump = setInterval(() => flood(20), 10);
    try {
      await streamClosed; // the server ends the stream itself (stall deadline), the client never disconnects
      expect(swarmEventBus.getListenerCount()).toBe(baseListeners);
      expect(streamRes!.writableLength).toBeLessThanOrEqual(RETAINED_CEILING);
      expect(streamRes!.destroyed || streamRes!.writableEnded).toBe(true);
    } finally {
      clearInterval(pump);
      socket.destroy();
    }
  });

  it('reports the loss to the client after a drain', async () => {
    process.env.SSE_STALL_TIMEOUT_MS = '10000';
    const socket = await openClient('slow');
    try {
      flood(400);
      const notice = received(socket, /"type":"stream_dropped"/);
      socket.resume();
      expect(frameOf(await notice, 'stream_dropped').data.dropped).toBeGreaterThan(0);
      // the stream stays open after a drain: new events still arrive
      const after = received(socket, /"after":"drain"/);
      swarmEventBus.emit('convergence', { after: 'drain' });
      await after;
    } finally {
      socket.destroy();
    }
  });

  it('reports an oversized-event drop to a healthy client without waiting for a drain', async () => {
    const socket = await openClient('reading'); // the socket never backs up, so no 'drain' will ever fire
    const droppedBefore = swarmEventBus.getDroppedEvents();
    try {
      const notice = received(socket, /"type":"stream_dropped"/);
      swarmEventBus.emit('budget_burn', { blob: 'x'.repeat(100 * 1024) }); // > MAX_EVENT_BYTES
      const text = await notice;
      expect(frameOf(text, 'stream_dropped').data).toMatchObject({ dropped: 1, reason: 'oversize' });
      expect(swarmEventBus.getDroppedEvents() - droppedBefore).toBe(1);
      expect(text).not.toContain('x'.repeat(1024));
    } finally {
      socket.destroy();
    }
  });

  it('unsubscribes when the client disconnects', async () => {
    const socket = await openClient('slow');
    socket.destroy();
    await streamClosed;
    expect(swarmEventBus.getListenerCount()).toBe(baseListeners);
  });
});
