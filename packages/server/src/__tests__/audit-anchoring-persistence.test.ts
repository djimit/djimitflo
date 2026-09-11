import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SQLite from 'better-sqlite3';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditAnchoringService } from '../services/audit-anchoring';

describe('durable audit anchoring with a local HTTP receiver', () => {
  let db: SQLite.Database;
  let root: string;
  let server: Server;
  let endpoint: string;
  let failRequests: number;
  let received: Array<Record<string, unknown>>;
  const services: AuditAnchoringService[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'djimitflo-anchor-proof-'));
    db = new SQLite(join(root, 'audit.sqlite'));
    db.exec(`CREATE TABLE compliance_audit_log (id TEXT, timestamp TEXT, actor TEXT, action TEXT,
      resource TEXT, outcome TEXT, hash TEXT, previous_hash TEXT);
      INSERT INTO compliance_audit_log VALUES ('e1','2026-01-01T00:00:00Z','fixture','read','fixture','success','hash1','genesis')`);
    failRequests = 0;
    received = [];
    server = createServer(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      received.push(JSON.parse(body));
      res.writeHead(failRequests-- > 0 ? 503 : 200);
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const service of services.splice(0)) service.clearRetryTimers();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function service(max_retries = 0) {
    const instance = new AuditAnchoringService(db, { siem_type: 'custom', webhook_url: endpoint },
      { max_retries, initial_delay_ms: 20, max_delay_ms: 20 });
    services.push(instance);
    return instance;
  }

  function reopen() {
    db.close();
    db = new SQLite(join(root, 'audit.sqlite'));
  }

  it('reads confirmed receipt identity after closing SQLite and constructing a fresh service', async () => {
    const original = service();
    const observer = service();
    const anchor = await original.anchorToExternal(endpoint, 'webhook');
    expect(anchor.status).toBe('confirmed');
    expect(anchor.chain_start).toBe('2026-01-01T00:00:00Z');
    expect(anchor.chain_end).toBe(anchor.chain_start);
    expect(received).toMatchObject([{ anchor_id: anchor.anchor_id, merkle_root: anchor.merkle_root, event_count: 1 }]);
    expect(observer.getLatestAnchor()).toEqual(anchor);
    reopen();
    expect(service().getAnchors()).toEqual([anchor]);
  });

  it('retries the same immutable anchor without duplicate insert, then exposes the receipt after restart', async () => {
    failRequests = 1;
    const original = service();
    const anchor = await original.anchorToExternal(endpoint, 'siem');
    expect(anchor.status).toBe('dead_letter');
    reopen();
    const restarted = service();
    expect(restarted.getDeadLetterQueue()).toEqual([anchor]);
    expect(await restarted.retryDeadLetters()).toEqual({ retried: 1, succeeded: 1 });
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_anchors').get()).toEqual({ n: 1 });
    reopen();
    expect(service().getLatestAnchor()).toMatchObject({ anchor_id: anchor.anchor_id, merkle_root: anchor.merkle_root, status: 'confirmed' });
    expect(service().getDeadLetterQueue()).toEqual([]);
  });

  it('never confirms an anchor when no delivery endpoint is configured', async () => {
    const unconfigured = new AuditAnchoringService(db, undefined, { max_retries: 0 });
    const anchor = await unconfigured.anchorToExternal('unconfigured', 'webhook');
    expect(anchor.status).toBe('dead_letter');
    expect(anchor.last_error).toContain('not configured');
    expect(unconfigured.getLatestAnchor()).toBeNull();
    expect(received).toEqual([]);
  });

  it('automatically retries once with the original snapshot and clears stale failure state', async () => {
    failRequests = 1;
    const original = service(1);
    const anchor = await original.anchorToExternal(endpoint, 'webhook');
    expect(anchor.status).toBe('failed');
    expect(service().getAnchors()).toEqual([anchor]);
    // A caller cannot modify the internally scheduled snapshot via the returned value.
    anchor.merkle_root = 'caller-mutation';
    await vi.waitFor(() => expect(original.getLatestAnchor()?.status).toBe('confirmed'));
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(received[0]);
    const confirmed = original.getLatestAnchor()!;
    expect(confirmed.retry_count).toBe(1);
    expect(confirmed.last_error).toBeUndefined();
    expect(confirmed.next_retry_at).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_anchors').get()).toEqual({ n: 1 });
    reopen();
    expect(service().getLatestAnchor()).toEqual(confirmed);
  });

  it('rejects changes to immutable snapshot fields during delivery-status persistence', async () => {
    const original = service();
    const anchor = await original.anchorToExternal(endpoint, 'webhook');
    for (const field of ['merkle_root', 'chain_start', 'chain_end', 'event_count', 'anchored_at', 'anchor_type', 'destination']) {
      const changed = { ...anchor, [field]: field === 'event_count' ? 999 : 'changed' };
      expect(() => (original as any).persistAnchor(changed)).toThrow('immutable identity mismatch');
      expect(original.getAnchors()).toEqual([anchor]);
    }
  });

  it('reads interrupted retries after restart without automatically resending them', async () => {
    failRequests = 1;
    const original = service(1);
    const anchor = await original.anchorToExternal(endpoint, 'webhook');
    original.clearRetryTimers();
    reopen();
    expect(service().getAnchors()).toEqual([anchor]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
  });
});
