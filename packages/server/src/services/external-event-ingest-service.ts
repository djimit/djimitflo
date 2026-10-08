import { SkillEvolutionEngine } from './skill-evolution-engine';
import { WorkItemService } from './work-item-service';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { OutcomeLearningService } from './outcome-learning-service';
import { ExpertSourceUnitsService, sourceUnitsEnabled } from './expert-source-units-service';
import { checkContentSafety, contentSafetyApplies } from './content-safety';

const nonBlank = z.string().trim().min(1);
const decodeField = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
/** The Redis bus delivers list fields as JSON strings ('["a.ts"]'); accept both, never throw. */
export const listField = (value: unknown): string[] => {
  let v = value;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map(String) : [];
};
const SIGNAL_PREFIXES = ['paperclip.', 'outcome.', 'roborev.', 'discovery.', 'wiki.', 'agent.', 'eve-v.', 'work.', 'content.', 'authority.'];

/**
 * Plan N2: one light outcome contract for every agent in the fleet (Hermes, Eve-V, maintainer, DeerFlow, Scallop, workers).
 * Stored as a skill outcome `agent:<agent>:<task_kind>` so the same fitness/bandit machinery ranks agents and models
 * across the fleet. Emit with scripts/emit-agent-outcome.py.
 */
const agentOutcomeSchema = z.object({
  agent: z.string().regex(/^[\w.-]{1,64}$/),
  task_kind: z.string().regex(/^[\w.:-]{1,64}$/),
  // the Redis-backed bus hands every field back as a string (prod 2026-09-28: success "true" matched no event)
  success: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
  model: z.string().max(120).optional(),
  tokens: z.coerce.number().int().nonnegative().optional(),
  duration_ms: z.coerce.number().int().nonnegative().optional(),
  ref: z.string().max(300).optional(),
});

/** N2: score every stored agent.outcome that has no fleet skill outcome yet (idempotent; also catches up earlier events). */
export function scoreAgentOutcomes(db: Database): number {
  const engine = new SkillEvolutionEngine(db); let n = 0;
  let rows: Array<{ id: string; payload: string }> = [];
  try {
    rows = db.prepare(`SELECT e.id, e.payload FROM external_events e WHERE e.event_type = 'agent.outcome'
      AND NOT EXISTS (SELECT 1 FROM skill_outcomes s WHERE s.domain = 'fleet' AND s.task_id = e.id) LIMIT 500`).all() as typeof rows;
  } catch { return 0; } // skill_outcomes not created yet
  for (const row of rows) {
    const o = agentOutcomeSchema.safeParse(JSON.parse(row.payload));
    if (!o.success) continue;
    engine.recordOutcome(`agent:${o.data.agent}:${o.data.task_kind}`, {
      success: o.data.success, tokensUsed: o.data.tokens ?? 0, durationMs: o.data.duration_ms ?? 0, domain: 'fleet',
      agentId: o.data.agent, taskId: row.id, ...(o.data.model ? { model: o.data.model } : {}), ...(o.data.ref ? { evidenceRefs: [o.data.ref] } : {}),
    }); n += 1;
  }
  return n;
}

const outcomeObservedSchema = z.object({
  outcome_id: nonBlank,
  subject_type: nonBlank,
  subject_id: nonBlank,
  task_id: nonBlank,
  candidate_id: nonBlank,
  capability_id: nonBlank,
  model_id: nonBlank,
  skill_hash: nonBlank,
  runtime_identity: nonBlank,
  metric: nonBlank,
  value: z.union([nonBlank, z.number(), z.boolean()]),
  baseline: z.union([nonBlank, z.number(), z.boolean()]),
  observation_window: nonBlank,
  evidence_refs: z.array(nonBlank).min(1),
  confidence: z.number().min(0).max(1),
  causal_status: nonBlank,
  direction: z.enum(['increase', 'decrease', 'maintain']).optional(),
  minimum_effect: z.number().nonnegative().optional(),
  experiment_id: nonBlank.optional(),
  trajectory_id: nonBlank.optional(),
  finding_id: nonBlank.optional(),
  condition: nonBlank.optional(),
  replication_id: nonBlank.optional(),
  risk_class: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  exploratory: z.boolean().optional(),
  observed_at: z.string().datetime({ offset: true }),
  dedupe_key: nonBlank,
});

export class ExternalEventIngestService {
  readonly serviceName = 'ExternalEventIngest';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly busUrl = process.env.DJIMIT_EVENT_BUS_URL || '',
    private readonly stream = process.env.DJIMIT_EVENT_STREAM || 'djimit.events',
    private readonly pollMs = Number(process.env.DJIMIT_EVENT_POLL_MS) || 60_000,
  ) {}

  start(): void {
    if (!this.busUrl || this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Native work intake for roborev review findings (they used to be shipped to Paperclip as issues).
   * Idempotent on the event's dedupe_key; a malformed finding is skipped, never thrown.
   */
  private materializeRoborevFinding(event: Record<string, unknown>): void {
    try {
      const title = typeof event.task_title === 'string' ? event.task_title.trim() : '';
      const dedupeKey = typeof event.dedupe_key === 'string' ? event.dedupe_key.trim() : '';
      if (!title || !dedupeKey) return;
      const severity = String(event.severity || 'medium');
      new WorkItemService(this.db).upsertBySourceRef({
        title: title.slice(0, 200),
        description: typeof event.context === 'string' && event.context.trim() ? event.context : title,
        source: 'roborev', source_ref: dedupeKey,
        risk_class: severity === 'critical' ? 'critical' : severity === 'high' ? 'high' : severity === 'low' ? 'low' : 'medium',
        status: 'candidate',
        recommended_loop: event.task_type === 'review_fix' ? 'repo-maintenance-loop' : 'research-loop',
        metadata: { repo: event.repo ?? null, sha: event.sha ?? null, finding_class: event.finding_class ?? null, affected_files: listField(event.affected_files), labels: listField(event.labels), blocked_by: listField(event.blocked_by), task_type: event.task_type ?? null },
      });
    } catch { /* never let one finding break event ingestion */ }
  }

  async pollOnce(): Promise<number> {
    const cursorKey = `external_event_ingest_cursor:${this.stream}`;
    const cursor = (this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(cursorKey) as { value?: string } | undefined)?.value;
    let count = 5000;
    let events: Array<Record<string, unknown> | null> = [];
    let newestCursor: string | undefined;
    while (true) {
      const url = `${this.busUrl.replace(/\/$/, '')}/events/${encodeURIComponent(this.stream)}?count=${count}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`event bus returned ${response.status}`);
      const body = await response.json() as { events?: unknown };
      if (!Array.isArray(body.events)) throw new Error('event bus returned an invalid events contract');
      events = body.events as Array<Record<string, unknown> | null>;
      newestCursor ??= events.map(event => event && typeof event === 'object' && !Array.isArray(event) ? event._id : null)
        .find(value => typeof value === 'string' && value.trim()) as string | undefined;
      const cursorIndex = cursor
        ? events.findIndex(event => event && typeof event === 'object' && !Array.isArray(event) && event._id === cursor)
        : -1;
      if (cursorIndex >= 0) {
        events = events.slice(0, cursorIndex);
        break;
      }
      if (events.length < count) break;
      count += 5000;
    }
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO external_events
        (id, event_type, source, correlation_id, causation_id, aggregate_id,
         aggregate_version, dedupe_key, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        const id = [event.event_id, event._id]
          .map(value => typeof value === 'string' ? value.trim() : '')
          .find(Boolean) || '';
        const eventType = String(event.event_type || '');
        // Every agent *work or learning* signal is recorded (observe-only unless routed below). An exact allow-list silently
        // dropped whole agent signals (prod 2026-09-27: Eve-V's work.action.required / content.revenue.candidate never
        // arrived). Status churn (fleet.status.changed — the registry's job) and Djimitflo's own djimitflo.* echo stay out.
        if (!id || !SIGNAL_PREFIXES.some((prefix) => eventType.startsWith(prefix))) continue;
        let normalizedEvent = event;
        if (eventType === 'outcome.observed') {
          const candidate = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, decodeField(value)]));
          const parsed = outcomeObservedSchema.safeParse(candidate);
          if (!parsed.success) continue;
          normalizedEvent = { ...event, ...parsed.data };
        }
        const aggregateVersion = Number(normalizedEvent.aggregate_version);
        if (eventType === 'roborev.finding') this.materializeRoborevFinding(normalizedEvent);
        // K1 (shadow): untrusted text from fleet agents is checked before it can reach any prompt
        if (eventType.startsWith('discovery.') && contentSafetyApplies('external_event')) {
          void checkContentSafety(this.db, { type: 'external_event', id }, [normalizedEvent.title, normalizedEvent.note].filter((v) => typeof v === 'string').join('\n')).catch(() => undefined);
        }
        if (eventType.startsWith('discovery.') && sourceUnitsEnabled()) {
          try { new ExpertSourceUnitsService(this.db).ingestDiscovery(normalizedEvent); } catch { /* never let one discovery break ingestion */ }
        }
        const added = insert.run(
          id,
          eventType,
          String(normalizedEvent.source || (eventType.startsWith('paperclip.') ? 'paperclip' : 'external')),
          normalizedEvent.correlation_id ? String(normalizedEvent.correlation_id) : null,
          normalizedEvent.causation_id ? String(normalizedEvent.causation_id) : null,
          normalizedEvent.aggregate_id ? String(normalizedEvent.aggregate_id) : null,
          Number.isSafeInteger(aggregateVersion) && aggregateVersion > 0 ? aggregateVersion : null,
          normalizedEvent.dedupe_key ? String(normalizedEvent.dedupe_key) : null,
          eventType === 'outcome.observed'
            ? new Date(String(normalizedEvent.observed_at)).toISOString()
            : String(normalizedEvent.occurred_at || normalizedEvent.timestamp || new Date().toISOString()),
          JSON.stringify(normalizedEvent),
        ).changes;
        inserted += added;

      }
      scoreAgentOutcomes(this.db);
      // Close the existing ingestion seam before advancing its cursor. Replay
      // also materializes historical observations left by older deployments.
      // ponytail: full-history derivation; add a projection cursor if measured
      // event volume makes this bounded polling transaction too expensive.
      if (this.db.prepare("SELECT 1 FROM external_events WHERE event_type='outcome.observed' LIMIT 1").get()) {
        new OutcomeLearningService(this.db).process();
      }
      if (newestCursor) {
        this.db.prepare(`
          INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(cursorKey, newestCursor);
      }
    });
    transaction();
    return inserted;
  }

  private async poll(): Promise<void> {
    try {
      const inserted = await this.pollOnce();
      if (inserted) console.log(`[ExternalEventIngest] imported ${inserted} external event(s)`);
    } catch (error) {
      console.warn('[ExternalEventIngest] poll failed:', error instanceof Error ? error.message : String(error));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }
}
