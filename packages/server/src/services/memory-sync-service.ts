import type { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import { pointIdForTask as qdrantPointIdForTask } from '../utils/qdrant-point-id';
import { yamlScalar } from '../utils/yaml-scalar';
import { ensureCollection, memoryEmbedModel, SWARM_MEMORY_COLLECTION } from './memory-embedding-contract';
import {
  claimInitial, claimRetry, ensureReceiptsTable, okfIntent, okfIntentHash, qdrantIntentHash, reconcileCandidates, recordOutcome, receiptMode, settleReadBack,
  touchReceipt, unreconcilableUnknown, MAX_DELIVERY_ATTEMPTS, type DeliveryTarget, type LegOutcome, type ReceiptMode, type ReceiptRow,
} from './memory-delivery-receipts';
import { guardTick, markRun } from './scheduler-registry';

// Resolved per call so operators/tests can override without a rebuild.
const DEFAULT_UAMS_URL = 'http://192.168.1.28:8000';
const DEFAULT_QDRANT_URL = 'http://192.168.1.28:6333';
const uamsUrl = (): string => process.env.UAMS_URL || DEFAULT_UAMS_URL;
const qdrantUrl = (): string => process.env.QDRANT_URL || DEFAULT_QDRANT_URL;

// Writes may target a different Qdrant than reads (e.g. the read-only credential
// is intentional, while writes go to the service store). Falls back to the read pair.
const qdrantWriteUrl = (): string => process.env.QDRANT_WRITE_URL || qdrantUrl();
const qdrantWriteApiKey = (): string | undefined => process.env.QDRANT_WRITE_API_KEY || process.env.QDRANT_API_KEY;

function authHeaders(apiKey: string | undefined, scheme: 'bearer' | 'api-key'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers[scheme === 'bearer' ? 'Authorization' : 'api-key'] = scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey;
  return headers;
}

const EMBED_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS) || 10_000;
// CODE-004: every leg has a per-request deadline, so the whole fan-out is bounded in elapsed time, not just in attempts.
const WRITE_TIMEOUT_MS = 10_000;
const isTimeout = (e: unknown): boolean => (e as { name?: string })?.name === 'TimeoutError' || (e as { name?: string })?.name === 'AbortError';
/**
 * A transport error that proves the request never reached the server (no connection was made). Anything else — a reset,
 * a socket hang-up — may have happened after the server committed the write.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const provenNotSent = (e: unknown): boolean => {
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }> } })?.cause;
  if (cause?.code && NOT_SENT_CODES.has(cause.code)) return true;
  return !!cause?.errors?.length && cause.errors.every((x) => !!x?.code && NOT_SENT_CODES.has(x.code));
};
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const delivered = (detail: string): LegOutcome => ({ status: 'delivered', detail });
const failed = (detail: string): LegOutcome => ({ status: 'failed', detail });
const unknown = (detail: string): LegOutcome => ({ status: 'unknown', detail });

/** MEMORY_DELIVERY_RECEIPTS=on: reconciliation tick (also once at boot). */
export const MEMORY_DELIVERY_RECONCILE_MS = 10 * 60_000;

export interface ReconcileReport {
  mode: ReceiptMode;
  /** idempotent legs resent */
  retried: number;
  /** of which now delivered */
  delivered: number;
  /** unknown legs settled as delivered by a read-back, without a resend */
  read_back_delivered: number;
  /** unknown legs whose read-back was inconclusive (left unknown) */
  read_back_inconclusive: number;
  /** unknown Qdrant legs whose point is an older version (other intent hash or embed model): not delivered, resent */
  read_back_stale: number;
  /** unknown legs on a non-idempotent target without a read-back (UAMS): never resent, reported */
  unknown_unreconcilable: number;
}
type TaskContext = { task: any; content: string; machineId: string; agentType: string };

/**
 * Task ids are not valid Qdrant point ids: they are UUIDs or composite strings
 * like `loop-worker-<uuid>-<hex>`. Derived id is stable => upserts are idempotent.
 */
const pointIdForTask = qdrantPointIdForTask;

/**
 * Embed via Ollama using the same endpoint fallback as OllamaEmbeddingProvider.
 * Returns null (never throws) so a missing embedding model degrades the Qdrant
 * leg only; UAMS/OKF are unaffected.
 */
async function embedText(text: string, model: string): Promise<number[] | null> {
  const base = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const call = async (path: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  try {
    let res = await call('/api/embed', { model, input: text });
    if (res.status === 404) res = await call('/api/embeddings', { model, prompt: text });
    if (!res.ok) return null;
    const payload = (await res.json()) as { embedding?: number[]; embeddings?: number[][] };
    const vector = payload.embedding || payload.embeddings?.[0];
    return vector?.length && vector.every((v) => Number.isFinite(v)) ? vector : null;
  } catch {
    return null;
  }
}

export class MemorySyncService {
  private db: Database;
  private okfTasksDir: string;

  private receiptsTableReady = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<ReconcileReport> | null = null;
  /** Receipts written before this instant were written by an earlier process: none of their legs is still in flight. */
  private readonly bootIso = new Date().toISOString();

  constructor(db: Database) {
    this.db = db;
    this.okfTasksDir = path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'tasks');
  }

  private loadTask(taskId: string): TaskContext | null {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) return null;

    const agent = task.agent_id
      ? (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(task.agent_id) as any)
      : null;

    return { task, content: task.description || task.title || '', machineId: task.created_by || 'unknown', agentType: agent?.agent_type || 'unknown' };
  }

  async onTaskCompleted(taskId: string): Promise<void> {
    const ctx = this.loadTask(taskId);
    if (!ctx) return;
    const { task, content, machineId, agentType } = ctx;

    const mode = receiptMode();
    if (mode === 'off') {
      // CODE-004: with MEMORY_DELIVERY_RECEIPTS off the legs run untracked, exactly as before (pinned: memory-sync-off-pinned.test.ts).
      await Promise.allSettled([
        this.syncToUAMS(taskId, content, machineId, agentType, false),
        this.syncToQdrant(taskId, content, machineId, agentType),
        Promise.resolve(this.writeOKFConcept(task, machineId, agentType)),
      ]);
      return;
    }
    // rendered before (and independent of) any receipt work, so no path can publish an unrendered file
    const okfText = this.renderOKFConcept(task, machineId, agentType);
    await Promise.allSettled([
      // nothing to deliver → no receipt (the leg logs the skip)
      content.trim()
        ? this.tracked(mode, taskId, 'uams', () => claimInitial(this.db, taskId, 'uams'), () => this.syncToUAMS(taskId, content, machineId, agentType, true))
        : this.syncToUAMS(taskId, content, machineId, agentType, true),
      this.tracked(mode, taskId, 'qdrant', () => claimInitial(this.db, taskId, 'qdrant'), () => this.syncToQdrant(taskId, content, machineId, agentType, true)),
      this.tracked(mode, taskId, 'okf', () => claimInitial(this.db, taskId, 'okf', okfIntent(sha256(okfText))),
        async () => this.writeOKFConcept(task, machineId, agentType, okfText)),
    ]);
  }

  /** Receipt reads/writes after a claim never break a sync: a failing store is logged (the receipt stays `unknown`). */
  private receipt(fn: () => void): void {
    try {
      this.ensureTable();
      fn();
    } catch (e) {
      console.warn('Memory delivery receipt write failed:', errText(e));
    }
  }

  private ensureTable(): void {
    if (!this.receiptsTableReady) { ensureReceiptsTable(this.db); this.receiptsTableReady = true; }
  }

  /**
   * One tracked leg: claim the durable intent atomically, then send, then record the outcome.
   * - claim lost (a receipt exists: repeated or concurrent completion, or another pass): nothing is sent.
   * - claim store fails: `on` sends nothing (no send without a durable intent); `shadow` sends untracked.
   */
  private async tracked(mode: ReceiptMode, taskId: string, target: DeliveryTarget, claim: () => boolean, run: () => Promise<LegOutcome | null>): Promise<LegOutcome | null> {
    let won: boolean;
    try {
      this.ensureTable();
      won = claim();
    } catch (e) {
      if (mode === 'on') {
        console.warn(`Memory sync ${target} for task ${taskId} not sent: no durable intent (${errText(e)})`);
        return null;
      }
      console.warn(`Memory delivery receipt for ${target} task ${taskId} failed (shadow, sending untracked):`, errText(e));
      return run();
    }
    if (!won) {
      console.log(`Memory sync ${target} for task ${taskId} skipped: a delivery receipt already exists`);
      return null;
    }
    let outcome: LegOutcome | null;
    try { outcome = await run(); } catch (e) { outcome = failed(errText(e)); }
    const settled = outcome ?? unknown('no outcome');
    this.receipt(() => recordOutcome(this.db, taskId, target, settled));
    return outcome;
  }

  /**
   * MEMORY_DELIVERY_RECEIPTS=on: runs the reconciliation pass now (boot) and every MEMORY_DELIVERY_RECONCILE_MS.
   * Returns whether it armed (off/shadow: false, nothing scheduled).
   */
  start(): boolean {
    if (receiptMode() !== 'on') return false;
    if (this.reconcileTimer) return true;
    const tick = guardTick('memory_delivery_reconcile', async () => {
      const r = await this.reconcile();
      markRun('memory_delivery_reconcile');
      if (r.retried || r.read_back_delivered || r.read_back_inconclusive || r.read_back_stale || r.unknown_unreconcilable) {
        console.log(`Memory delivery reconcile: ${r.retried} retried (${r.delivered} delivered), ${r.read_back_delivered} read back, `
          + `${r.read_back_inconclusive} inconclusive, ${r.read_back_stale} stale, ${r.unknown_unreconcilable} UAMS unknown (not resent)`);
      }
    });
    tick();
    this.reconcileTimer = setInterval(tick, MEMORY_DELIVERY_RECONCILE_MS);
    this.reconcileTimer.unref?.();
    return true;
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /**
   * One bounded pass (MEMORY_DELIVERY_RECEIPTS=on; off/shadow do nothing). Only idempotent targets are touched:
   * an `unknown` leg is first read back (present → delivered without a resend; absent or a stale Qdrant point → resent); a `failed` leg with
   * attempts left is resent once per pass. UAMS legs are never resent: its `unknown` legs are counted and reported.
   */
  reconcile(now = Date.now()): Promise<ReconcileReport> {
    if (!this.reconciling) this.reconciling = this.reconcilePass(now).finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async reconcilePass(now: number): Promise<ReconcileReport> {
    const mode = receiptMode();
    const report: ReconcileReport = { mode, retried: 0, delivered: 0, read_back_delivered: 0, read_back_inconclusive: 0, read_back_stale: 0, unknown_unreconcilable: 0 };
    if (mode !== 'on') return report;
    let rows: ReturnType<typeof reconcileCandidates> = [];
    this.receipt(() => {
      rows = reconcileCandidates(this.db, now, this.bootIso);
      report.unknown_unreconcilable = unreconcilableUnknown(this.db);
    });
    for (const row of rows) {
      let staleOrAbsent: 'stale' | 'absent' = 'absent';
      if (row.status === 'unknown') {
        const seen = await this.readBack(row);
        if (seen === 'present') {
          let won = false;
          this.receipt(() => { won = settleReadBack(this.db, row); });
          if (won) report.read_back_delivered++;
          continue;
        }
        if (seen === 'inconclusive') {
          this.receipt(() => touchReceipt(this.db, row.task_id, row.target, 'read_back_inconclusive'));
          report.read_back_inconclusive++;
          continue;
        }
        // absent, or stale (an older point at the same id; the upsert is idempotent and overwrites it): not delivered →
        // resend below (the claim moves it from this exact unknown state)
        if (seen === 'stale') report.read_back_stale++;
        staleOrAbsent = seen;
      }
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        if (row.status === 'unknown') this.receipt(() => recordOutcome(this.db, row.task_id, row.target, failed(`read_back: ${staleOrAbsent}`)));
        continue;
      }
      const ctx = this.loadTask(row.task_id);
      const okfText = row.target === 'okf' && ctx ? this.renderOKFConcept(ctx.task, ctx.machineId, ctx.agentType) : '';
      const outcome = await this.tracked('on', row.task_id, row.target, () => claimRetry(this.db, row, okfText ? okfIntent(sha256(okfText)) : 'in_flight'), async () => {
        if (!ctx) return failed('task missing');
        return row.target === 'qdrant'
          ? this.syncToQdrant(row.task_id, ctx.content, ctx.machineId, ctx.agentType, true)
          : this.writeOKFConcept(ctx.task, ctx.machineId, ctx.agentType, okfText);
      });
      if (outcome) report.retried++;
      if (outcome?.status === 'delivered') report.delivered++;
    }
    return report;
  }

  /**
   * Is the leg's effect visible at the target? Qdrant: the point by its stable id, present only when its payload carries the
   * intent hash of the delivery a resend would make now and that embed model (STATE-02: an older point at the same id —
   * other content or model, or no hash — is stale, never delivered; its task row missing is inconclusive). OKF: the file's sha256 equals the intent hash
   * recorded before the write (a torn or stale file is absent). UAMS has no read-back.
   */
  private async readBack(row: ReceiptRow): Promise<'present' | 'absent' | 'stale' | 'inconclusive'> {
    const { task_id: taskId, target } = row;
    if (target === 'okf') {
      const want = okfIntentHash(row.detail);
      try { return want && sha256(fs.readFileSync(path.join(this.okfTasksDir, `${taskId}.md`))) === want ? 'present' : 'absent'; } catch { return 'absent'; }
    }
    if (target !== 'qdrant') return 'inconclusive';
    try {
      const res = await fetch(`${qdrantWriteUrl()}/collections/${SWARM_MEMORY_COLLECTION}/points/${pointIdForTask(taskId)}`, {
        headers: authHeaders(qdrantWriteApiKey(), 'api-key'),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      if (res.status === 404) return 'absent';
      if (!res.ok) return 'inconclusive';
      const body = (await res.json()) as { result?: { payload?: { intent_sha256?: unknown; embedding_model?: unknown } | null } | null };
      if (!body.result) return 'absent';
      const ctx = this.loadTask(taskId);
      if (!ctx) return 'inconclusive';
      const model = memoryEmbedModel();
      const got = body.result.payload;
      return got?.embedding_model === model && got.intent_sha256 === qdrantIntentHash(taskId, ctx.content, ctx.machineId, ctx.agentType, model)
        ? 'present' : 'stale';
    } catch {
      return 'inconclusive';
    }
  }

  /**
   * tracked (receipts shadow/on): a write whose delivery is ambiguous — 5xx, timeout, a transport error after the request
   * may have reached the server — is `unknown` and never re-sent (/memory/entry is not proven idempotent). Only proven
   * non-delivery (no connection made) is retried. Untracked (off): the pre-receipts behaviour, unchanged.
   */
  private async syncToUAMS(taskId: string, content: string, machineId: string, agentType: string, tracked: boolean): Promise<LegOutcome | null> {
    if (!content.trim()) {
      console.warn(`UAMS sync skipped for task ${taskId}: empty content`);
      return null;
    }
    const apiKey = process.env.UAMS_API_KEY;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${uamsUrl()}/memory/entry`, {
          method: 'POST',
          headers: authHeaders(apiKey, 'bearer'),
          body: JSON.stringify({
            memory_type: 'active',
            scope: 'system',
            agent_id: machineId,
            topic: `task:${taskId}`,
            content: content.slice(0, 2000),
            metadata: { task_id: taskId, machine_id: machineId, agent_type: agentType },
          }),
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
          // tracked: never follow a redirect — the origin received the request, so a later transport error proves nothing
          ...(tracked ? { redirect: 'manual' as const } : {}),
        });
        if (res.ok) {
          console.log(`Memory synced: task ${taskId} → UAMS`);
          return delivered(`${res.status}`);
        }
        if (res.status === 401 || res.status === 403) {
          console.warn(`UAMS sync rejected for task ${taskId}: ${res.status} (check UAMS_API_KEY)`);
          return failed(`rejected ${res.status}`);
        }
        if (tracked && (res.status >= 500 || (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect')) {
          console.warn(`UAMS sync for task ${taskId}: ${res.status}; outcome unknown, not retried`);
          return unknown(`status ${res.status}`);
        }
        if (res.status >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        console.warn(`UAMS sync failed for task ${taskId}: ${res.status}`);
        return failed(`status ${res.status}`);
      } catch (e) {
        // A timed-out POST may have been applied: the outcome is unknown and /memory/entry is not known to be
        // idempotent, so it is not re-sent. Only a failure before a response (e.g. connection refused) is retried.
        if (isTimeout(e)) {
          console.warn(`UAMS sync for task ${taskId} timed out after ${WRITE_TIMEOUT_MS}ms; outcome unknown, not retried`);
          return unknown(`timeout ${WRITE_TIMEOUT_MS}ms`);
        }
        if (tracked && !provenNotSent(e)) {
          console.warn(`UAMS sync for task ${taskId}: ${errText(e)}; may have been applied, outcome unknown, not retried`);
          return unknown(errText(e));
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        console.warn(`UAMS sync error for task ${taskId}:`, e);
        return failed(errText(e));
      }
    }
    return failed('no attempt');
  }

  /** tracked (receipts shadow/on): the payload also carries the intent hash a read-back compares. Untracked (off): unchanged. */
  private async syncToQdrant(taskId: string, content: string, machineId: string, agentType: string, tracked = false): Promise<LegOutcome> {
    const excerpt = content.slice(0, 500);

    const apiKey = qdrantWriteApiKey();
    const headers = authHeaders(apiKey, 'api-key');
    const base = qdrantWriteUrl();
    const collection = SWARM_MEMORY_COLLECTION;
    const model = memoryEmbedModel();

    try {
      const vector = await embedText(`${taskId} ${content}`, model);
      if (!vector) {
        console.warn(`Qdrant sync skipped for task ${taskId}: embedding unavailable (set DJIMITFLO_EMBED_MODEL to a served model)`);
        return failed('embedding unavailable');
      }

      // CODE-001: never DELETE/recreate an existing collection from the task path; only a 404 is created.
      const state = await ensureCollection(base, collection, headers, vector.length, model);
      if (state.status !== 'ready') {
        console.warn(`Qdrant sync skipped for task ${taskId}: unavailable, ${state.reason}`);
        return failed(`collection unavailable: ${state.reason}`);
      }

      const payload = {
        points: [
          {
            id: pointIdForTask(taskId),
            vector,
            payload: {
              task_id: taskId, machine_id: machineId, agent_type: agentType, timestamp: new Date().toISOString(), content_excerpt: excerpt, embedding_model: model, embedding_dim: vector.length,
              ...(tracked ? { intent_sha256: qdrantIntentHash(taskId, content, machineId, agentType, model) } : {}),
            },
          },
        ],
      };
      const upsertRes = await fetch(`${base}/collections/${collection}/points`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      if (!upsertRes.ok) {
        console.warn(`Qdrant sync failed for task ${taskId}: upsert ${upsertRes.status}`);
        return failed(`upsert ${upsertRes.status}`);
      }
      console.log(`Memory synced: task ${taskId} → Qdrant`);
      return delivered('upsert');
    } catch (e) {
      console.warn(`Qdrant sync error for task ${taskId}:`, e);
      // a timed-out upsert may have landed (unknown, settled by a read-back); any other throw is a definite failure
      return isTimeout(e) ? unknown(`timeout ${WRITE_TIMEOUT_MS}ms`) : failed(errText(e));
    }
  }

  private renderOKFConcept(task: any, machineId: string, agentType: string): string {
    const description = (task.description || task.title || '').slice(0, 200);
    const frontmatter = [
      '---',
      `type: CompletedTask`,
      `title: ${yamlScalar(task.title || '')}`,
      `description: ${yamlScalar(description)}`,
      `resource: http://192.168.1.28:3001/api/tasks/${task.id}`,
      `tags: [${machineId}, ${agentType}, ${task.status}]`,
      `timestamp: ${new Date().toISOString()}`,
      `trust_level: agent_generated`,
      '---',
    ].join('\n');

    const body = [
      `# ${task.title || task.id}`,
      '',
      `**Status**: ${task.status}`,
      `**Machine**: ${machineId}`,
      `**Agent type**: ${agentType}`,
      `**Created**: ${task.created_at}`,
      `**Completed**: ${task.completed_at || 'N/A'}`,
      '',
      '## Description',
      '',
      task.description || '_No description_',
      '',
    ].join('\n');

    return `${frontmatter}\n\n${body}\n`;
  }

  /**
   * `rendered` (tracked modes): the exact bytes whose hash the intent recorded, published crash-safely (temp file + rename,
   * so the destination is never torn). Untracked (off): rendered and written in place, as before.
   */
  private writeOKFConcept(task: any, machineId: string, agentType: string, rendered?: string): LegOutcome {
    // OKF is a rebuildable projection: a missing/dangling knowledge base must not
    // fail the whole sync (this is synchronous, so an uncaught throw would reject
    // onTaskCompleted before Promise.allSettled can isolate it).
    try {
      fs.mkdirSync(this.okfTasksDir, { recursive: true });
      const filePath = path.join(this.okfTasksDir, `${task.id}.md`);
      if (rendered === '') return failed('empty render, not written'); // never publish an empty/unrendered file
      if (rendered === undefined) {
        fs.writeFileSync(filePath, this.renderOKFConcept(task, machineId, agentType), 'utf8');
      } else {
        const tmp = `${filePath}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmp, rendered, 'utf8');
          fs.renameSync(tmp, filePath);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
      console.log(`OKF concept written: tasks/${task.id}.md`);
      return delivered('written');
    } catch (e) {
      console.warn(`OKF concept write failed for task ${task.id}:`, e instanceof Error ? e.message : String(e));
      return failed(errText(e));
    }
  }
}
