/**
 * One SSE transport with a bounded backpressure contract (OBS-001, forensic audit 2026-10-26).
 *
 * - write() returning false means the client is not keeping up: from then on events are dropped (counted, never
 *   queued) until 'drain'. Retained bytes per client stay below the socket's writable high-water mark plus one frame
 *   (frames larger than MAX_EVENT_BYTES are dropped, not written).
 * - the client learns of every gap through a `stream_dropped` event ({ dropped, reason }): after a backpressure loss
 *   it is sent on 'drain'; an oversized frame on a healthy socket is reported at once (no drain may ever come). Live events are not replayed: durable records (audit log, evidence, outbox) are the replay source.
 * - a client that does not drain within SSE_STALL_TIMEOUT_MS (default 30 s) is disconnected: the stream ends finitely.
 * - every end path (client close, stall, socket error) runs the close hooks exactly once (unsubscribe, timers).
 */
import type { Request, Response } from 'express';

export const MAX_EVENT_BYTES = 64 * 1024;
const KEEPALIVE_MS = 15_000;
const stallTimeoutMs = (): number => Number(process.env.SSE_STALL_TIMEOUT_MS) || 30_000;

export interface SseStream {
  /** Sends one `data:` event; false when it was dropped (backpressure, oversize) or the stream is closed. */
  send(event: unknown): boolean;
  /** Registers a hook that runs once when the stream ends for any reason. */
  onClose(hook: () => void): void;
}

export function openSseStream(req: Request, res: Response, opts: { onDrop?: (count: number) => void } = {}): SseStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const hooks: Array<() => void> = [];
  let closed = false;
  let dropped = 0;
  let stall: ReturnType<typeof setTimeout> | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    if (stall) clearTimeout(stall);
    for (const hook of hooks.splice(0)) { try { hook(); } catch { /* a hook never blocks the others */ } }
  };

  /** Writes a frame unless the client is backpressured; arms the stall deadline when this write fills the buffer. */
  const write = (frame: string): boolean => {
    if (closed || res.destroyed || res.writableNeedDrain) return false;
    if (!res.write(frame) && !stall) {
      stall = setTimeout(() => { res.destroy(); close(); }, stallTimeoutMs());
    }
    return true;
  };

  const drop = (): false => {
    dropped++;
    try { opts.onDrop?.(1); } catch { /* accounting never breaks the stream */ }
    return false;
  };

  /** Sends the pending loss notice when the socket accepts writes; otherwise it waits for 'drain'. */
  const notifyLoss = (reason: 'backpressure' | 'oversize'): void => {
    if (dropped === 0) return;
    const count = dropped;
    if (write(`data: ${JSON.stringify({ type: 'stream_dropped', timestamp: new Date().toISOString(), data: { dropped: count, reason } })}\n\n`)) dropped = 0;
  };

  res.on('drain', () => {
    if (stall) { clearTimeout(stall); stall = null; }
    notifyLoss('backpressure');
  });
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);

  const keepalive = setInterval(() => { write(': keepalive\n\n'); }, KEEPALIVE_MS);

  return {
    send(event: unknown): boolean {
      if (closed) return false;
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) { drop(); notifyLoss('oversize'); return false; }
      return write(frame) || drop();
    },
    onClose(hook: () => void): void {
      if (closed) hook(); else hooks.push(hook);
    },
  };
}
