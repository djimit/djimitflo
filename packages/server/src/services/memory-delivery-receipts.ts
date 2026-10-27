import type { Database } from 'better-sqlite3';

/**
 * CODE-004 follow-up to #1056 (forensic audit 2026-10-26): per-task, per-target delivery receipts for the memory fan-out
 * (memory-sync-service). MEMORY_DELIVERY_RECEIPTS:
 * - off (default): nothing is recorded, no table is created; the fan-out behaves exactly as before.
 * - shadow: every leg writes a receipt ahead (`unknown`, detail `in_flight`) and its outcome after; nothing is replayed.
 * - on: shadow + a bounded reconciliation pass at boot and on a tick (MemorySyncService.reconcile).
 * Status: delivered | failed (a definite non-delivery: an error response, no embedding, refused connection) | unknown
 * (a timeout, or the process died mid-leg: the target may or may not have applied it).
 */
export type ReceiptMode = 'off' | 'shadow' | 'on';
export type DeliveryTarget = 'uams' | 'qdrant' | 'okf';
export type DeliveryStatus = 'delivered' | 'failed' | 'unknown';
export interface LegOutcome { status: DeliveryStatus; detail: string }

/**
 * idempotent: resending cannot duplicate — Qdrant upserts one stable point id per task (utils/qdrant-point-id), OKF
 * overwrites one file per task. Both also have a read-back (GET the point / the file exists). UAMS POST /memory/entry is
 * not proven idempotent and has no read-by-id contract: its failed and unknown legs are reported, never resent.
 */
export const DELIVERY_TARGETS: Record<DeliveryTarget, { idempotent: boolean }> = {
  uams: { idempotent: false },
  qdrant: { idempotent: true },
  okf: { idempotent: true },
};
const IDEMPOTENT = (Object.keys(DELIVERY_TARGETS) as DeliveryTarget[]).filter((t) => DELIVERY_TARGETS[t].idempotent);

/** Sends per receipt (first delivery included) before a failed idempotent leg is left failed and reported as exhausted. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** Receipts per reconciliation pass. */
export const RECONCILE_BATCH = 25;
/** An `unknown` receipt younger than this (and written by this process) may still be in flight; longer than any leg's deadlines. */
export const IN_FLIGHT_GRACE_MS = 120_000;

export function receiptMode(env: NodeJS.ProcessEnv = process.env): ReceiptMode {
  const v = (env.MEMORY_DELIVERY_RECEIPTS || '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

/** Additive and idempotent. */
export function ensureReceiptsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_sync_receipts (
    task_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'unknown')),
    detail TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, target)
  )`);
}

/** Write-ahead before a send: the leg is `unknown` until its outcome is recorded, so a crash mid-leg leaves `unknown`. */
export function recordAttempt(db: Database, taskId: string, target: DeliveryTarget, now = Date.now()): void {
  db.prepare(`INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at) VALUES (?, ?, 'unknown', 'in_flight', 1, ?)
    ON CONFLICT (task_id, target) DO UPDATE SET status = 'unknown', detail = 'in_flight', attempts = attempts + 1, updated_at = excluded.updated_at`)
    .run(taskId, target, new Date(now).toISOString());
}

export function recordOutcome(db: Database, taskId: string, target: DeliveryTarget, outcome: LegOutcome, now = Date.now()): void {
  db.prepare(`INSERT INTO memory_sync_receipts (task_id, target, status, detail, attempts, updated_at) VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT (task_id, target) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`)
    .run(taskId, target, outcome.status, outcome.detail.slice(0, 300), new Date(now).toISOString());
}

/** A leg with nothing to deliver (e.g. empty content) keeps no receipt. */
export function dropReceipt(db: Database, taskId: string, target: DeliveryTarget): void {
  db.prepare('DELETE FROM memory_sync_receipts WHERE task_id = ? AND target = ?').run(taskId, target);
}

export interface ReceiptRow { task_id: string; target: DeliveryTarget; status: DeliveryStatus; attempts: number }

/**
 * The bounded work of one pass: idempotent targets only, `failed` with attempts left or `unknown`, settled (written
 * before `bootIso`, i.e. by an earlier process, or older than the in-flight grace), oldest first.
 */
export function reconcileCandidates(db: Database, now: number, bootIso: string, limit = RECONCILE_BATCH): ReceiptRow[] {
  const settled = new Date(now - IN_FLIGHT_GRACE_MS).toISOString();
  return db.prepare(`SELECT task_id, target, status, attempts FROM memory_sync_receipts
    WHERE target IN (${IDEMPOTENT.map(() => '?').join(', ')})
      AND ((status = 'failed' AND attempts < ?) OR status = 'unknown')
      AND (updated_at <= ? OR updated_at <= ?)
    ORDER BY updated_at LIMIT ?`).all(...IDEMPOTENT, MAX_DELIVERY_ATTEMPTS, bootIso, settled, limit) as ReceiptRow[];
}

/** Leaves the status alone but moves the row to the back of the queue (an inconclusive read-back must not starve the batch). */
export function touchReceipt(db: Database, taskId: string, target: DeliveryTarget, detail: string, now = Date.now()): void {
  db.prepare('UPDATE memory_sync_receipts SET detail = ?, updated_at = ? WHERE task_id = ? AND target = ?').run(detail.slice(0, 300), new Date(now).toISOString(), taskId, target);
}

/** `unknown` legs no pass can settle: non-idempotent targets without a read-back (UAMS). */
export function unreconcilableUnknown(db: Database): number {
  const others = (Object.keys(DELIVERY_TARGETS) as DeliveryTarget[]).filter((t) => !DELIVERY_TARGETS[t].idempotent);
  if (!others.length) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_sync_receipts WHERE status = 'unknown' AND target IN (${others.map(() => '?').join(', ')})`).get(...others) as { n: number }).n;
}

/**
 * Read-only evidence (evolution-evidence `memory_delivery`): receipt counts per target and status, failed idempotent legs
 * out of attempts, and the oldest `unknown`. `by_target: null` when no receipt table exists (off, never armed) — not zero.
 */
export function memoryDeliveryEvidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const mode = receiptMode(env);
  type Row = { target: string; status: string; n: number; exhausted: number };
  let rows: Row[] | null = null;
  let oldestUnknown: string | null = null;
  try {
    rows = db.prepare(`SELECT target, status, COUNT(*) AS n, COALESCE(SUM(status = 'failed' AND attempts >= ?), 0) AS exhausted
      FROM memory_sync_receipts GROUP BY 1, 2`).all(MAX_DELIVERY_ATTEMPTS) as Row[];
    oldestUnknown = (db.prepare(`SELECT MIN(updated_at) AS t FROM memory_sync_receipts WHERE status = 'unknown'`).get() as { t: string | null }).t;
  } catch { rows = null; }
  const by_target = rows === null ? null : Object.fromEntries((Object.keys(DELIVERY_TARGETS) as DeliveryTarget[]).map((target) => {
    const of = (status: DeliveryStatus) => rows!.find((r) => r.target === target && r.status === status);
    return [target, {
      idempotent: DELIVERY_TARGETS[target].idempotent,
      delivered: of('delivered')?.n ?? 0, failed: of('failed')?.n ?? 0, unknown: of('unknown')?.n ?? 0,
      exhausted: DELIVERY_TARGETS[target].idempotent ? (of('failed')?.exhausted ?? 0) : null,
    }];
  })) as Record<DeliveryTarget, { idempotent: boolean; delivered: number; failed: number; unknown: number; exhausted: number | null }>;
  return {
    mode, by_target, oldest_unknown: oldestUnknown, max_attempts: MAX_DELIVERY_ATTEMPTS,
    note: 'Receipts per memory-sync leg (CODE-004). on: failed idempotent legs (qdrant, okf) are retried and unknown ones read back, '
      + `≤ ${RECONCILE_BATCH} per pass, ≤ ${MAX_DELIVERY_ATTEMPTS} sends; UAMS (non-idempotent, no read-back) is never resent — its unknown/failed stay reported. `
      + 'by_target null = no receipts table (off).',
  };
}
