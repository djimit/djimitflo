/**
 * Review of #1056 (CODE-004 follow-up): a delivery whose response is lost after the receiver applied it has an
 * unknown outcome. It must not be replayed automatically (retry timer) nor by the dead-letter replay; an operator
 * reconciles it against the receiver first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SQLite from 'better-sqlite3';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { AuditAnchoringService } from '../services/audit-anchoring';

describe('audit anchoring: applied but response lost (unknown outcome)', () => {
  let db: SQLite.Database;
  let server: Server;
  let endpoint: string;
  let received: Array<Record<string, unknown>>;
  const services: AuditAnchoringService[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);

  beforeEach(async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50));
    db = new SQLite(':memory:');
    db.exec(`CREATE TABLE compliance_audit_log (id TEXT, timestamp TEXT, actor TEXT, action TEXT,
      resource TEXT, outcome TEXT, hash TEXT, previous_hash TEXT);
      INSERT INTO compliance_audit_log VALUES ('e1','2026-01-01T00:00:00Z','fixture','read','fixture','success','hash1','genesis')`);
    received = [];
    // the receiver reads and applies the body, then never answers: the response is lost
    server = createServer(async (req) => {
      let body = '';
      for await (const part of req) body += part;
      received.push(JSON.parse(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of services.splice(0)) s.clearRetryTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  const service = () => {
    const s = new AuditAnchoringService(db, { siem_type: 'custom', webhook_url: endpoint }, { max_retries: 3, initial_delay_ms: 10, max_delay_ms: 10 });
    services.push(s);
    return s;
  };

  for (const type of ['webhook', 'siem'] as const) {
    it(`${type}: records unknown, never re-sends, and replays only after reconciliation`, async () => {
      const s = service();
      const anchor = await s.anchorToExternal(endpoint, type);
      expect(anchor.status).toBe('unknown');
      expect(anchor.last_error).toMatch(/outcome unknown/);
      expect(anchor.next_retry_at).toBeUndefined();

      await new Promise((r) => setTimeout(r, 100)); // well past every backoff
      expect(received).toHaveLength(1);
      expect(await s.retryDeadLetters()).toEqual({ retried: 0, succeeded: 0 });
      expect(received).toHaveLength(1);
      expect(s.getUnknownDeliveries().map((a) => a.anchor_id)).toEqual([anchor.anchor_id]);
      expect(s.getLatestAnchor()).toBeNull();

      // the operator checked the receiver: it has the anchor
      expect(s.reconcileUnknown(anchor.anchor_id, 'received')).toMatchObject({ status: 'confirmed' });
      expect(s.getLatestAnchor()?.anchor_id).toBe(anchor.anchor_id);
      expect(s.getUnknownDeliveries()).toEqual([]);
      expect(received).toHaveLength(1);
    });
  }

  it('a reconciled "not received" becomes a dead letter that the manual replay may send', async () => {
    const s = service();
    const anchor = await s.anchorToExternal(endpoint, 'webhook');
    expect(s.reconcileUnknown(anchor.anchor_id, 'not_received')).toMatchObject({ status: 'dead_letter' });
    expect(s.getDeadLetterQueue().map((a) => a.anchor_id)).toEqual([anchor.anchor_id]);
    expect(() => s.reconcileUnknown(anchor.anchor_id, 'received')).toThrow(/not an unknown delivery/);
  });
});
