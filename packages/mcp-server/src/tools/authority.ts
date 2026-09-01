/**
 * Authority Ledger MCP tools (2026-08-30).
 *
 * Exposes: djimitflo_authority_trace, djimitflo_authority_emit,
 * djimitflo_authority_stats.
 *
 * Contract: djimit-evidence-native-sdlc event-envelope.schema.json v1alpha1.
 * Emitter op EVE-V: authority_ledger.py (JSONL source of truth, live sinds
 * 2026-08-30). De tabel authority_events ontstaat via migrate.ts
 * (createAuthorityLedgerTables).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

const DECISIONS = ['ALLOW', 'DENY', 'HOLD'] as const;
const ACTOR_TYPES = ['human', 'agent', 'service', 'ci'] as const;

function rows(dbHandle: DbHandle, sql: string, ...params: unknown[]) {
  return dbHandle.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function tableExists(dbHandle: DbHandle, name: string): boolean {
  return rows(
    dbHandle,
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    name,
  ).length > 0;
}

export function registerAuthorityTools(server: McpServer, dbHandle: DbHandle) {
  // ─── authority_trace ─────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_authority_trace',
    {
      description:
        'Reconstruct the full authority chain for a correlation_id: lifecycle events joined with loop runs, approvals, capability tokens, policy violations and execution evidence. One ID, complete provenance.',
      inputSchema: {
        correlationId: z.string().min(1).describe('correlation_id (uuid)'),
        includePayload: z.boolean().default(false).optional(),
      },
    },
    async ({ correlationId, includePayload = false }) => {
      if (!tableExists(dbHandle, 'authority_events')) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'authority_events_table_missing',
              hint: 'run migrations first (npm run migrate in packages/server)',
            }, null, 2),
          }],
        };
      }

      const events = rows(
        dbHandle,
        `SELECT event_id, sequence, occurred_at, previous_state, requested_state,
                policy_decision, actor_subject, actor_type, actor_issuer,
                source_system${includePayload ? ', payload_json' : ''}
         FROM authority_events WHERE correlation_id=?
         ORDER BY sequence ASC`,
        correlationId,
      );

      const loopRuns = rows(
        dbHandle,
        `SELECT id, loop_name, mode, status, created_at, updated_at, completed_at
         FROM loop_runs
         WHERE id = ? OR metadata LIKE ?
         ORDER BY created_at DESC LIMIT 20`,
        correlationId, `%${correlationId}%`,
      );

      const approvals = rows(
        dbHandle,
        `SELECT id, task_id, status, risk_level, request_type, created_at
         FROM approvals
         WHERE task_id = ? OR request_data LIKE ?
         ORDER BY created_at DESC LIMIT 20`,
        correlationId, `%${correlationId}%`,
      );

      const capabilityTokens = tableExists(dbHandle, 'capability_tokens')
        ? rows(
            dbHandle,
            `SELECT token_ref, risk_class, status, approved_by, expires_at
             FROM capability_tokens
             WHERE metadata LIKE ? OR approved_by = ?
             ORDER BY updated_at DESC LIMIT 20`,
            `%${correlationId}%`, correlationId,
          )
        : [];

      const violations = tableExists(dbHandle, 'policy_violations')
        ? rows(
            dbHandle,
            `SELECT action_type, description, risk_level, status, created_at
             FROM policy_violations
             WHERE metadata LIKE ? OR task_id = ? OR task_id IS NULL
             ORDER BY created_at DESC LIMIT 20`,
            `%${correlationId}%`, correlationId,
          )
        : [];

      const evidence = tableExists(dbHandle, 'execution_evidence')
        ? rows(
            dbHandle,
            `SELECT id, task_id, evidence_type, severity, title, captured_at
             FROM execution_evidence
             WHERE metadata LIKE ? OR task_id = ?
             ORDER BY captured_at DESC LIMIT 20`,
            `%${correlationId}%`, correlationId,
          )
        : [];

      const trace = {
        correlation_id: correlationId,
        generated_at: new Date().toISOString(),
        ledger_events: events.length,
        events,
        loop_runs: loopRuns,
        approvals,
        capability_tokens: capabilityTokens,
        policy_violations: violations,
        execution_evidence: evidence,
        summary: {
          event_count: events.length,
          last_decision:
            events.length > 0 ? events[events.length - 1].policy_decision : null,
          last_state:
            events.length > 0 ? events[events.length - 1].requested_state : null,
          open_violations: violations.filter(
            (v) => String(v.status) !== 'resolved',
          ).length,
          pending_approvals: approvals.filter(
            (a) => String(a.status) === 'pending',
          ).length,
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(trace, null, 2) }],
      };
    },
  );

  // ─── authority_emit ──────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_authority_emit',
    {
      description:
        'Append a LifecycleEvent to the Authority Ledger (djimit.io/v1alpha1). Sequence is strictly increasing per correlation_id (fail-closed on conflict).',
      inputSchema: {
        correlationId: z.string().min(1),
        previousState: z.string().optional(),
        requestedState: z.string().min(1),
        policyDecision: z.enum(DECISIONS),
        actorSubject: z.string().min(1),
        actorType: z.enum(ACTOR_TYPES).default('agent'),
        actorIssuer: z.string().default('djimitflo'),
        artifactId: z.string().min(1),
        evidenceRefs: z.array(z.string()).default([]),
        payload: z.record(z.string(), z.unknown()).default({}),
        sourceSystem: z.string().default('djimitflo'),
      },
    },
    async ({
      correlationId, previousState, requestedState, policyDecision,
      actorSubject, actorType, actorIssuer, artifactId,
      evidenceRefs = [],
      sourceSystem = 'djimitflo',
      payload,
    }) => {
      const { createHash, randomUUID } = await import('node:crypto');
      const payloadJson = JSON.stringify(payload ?? {});
      const payloadDigest =
        'sha256:' + createHash('sha256').update(payloadJson).digest('hex');

      const last = rows(
        dbHandle,
        'SELECT sequence FROM authority_events WHERE correlation_id=? ORDER BY sequence DESC LIMIT 1',
        correlationId,
      );
      const sequence = (last.length > 0 ? Number(last[0].sequence) : 0) + 1;
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();

      try {
        dbHandle.db.prepare(
          `INSERT INTO authority_events
           (id, event_id, correlation_id, causation_id, sequence, occurred_at,
            actor_subject, actor_type, actor_issuer, artifact_id,
            artifact_version, artifact_digest, previous_state, requested_state,
            policy_decision, payload_digest, payload_json, evidence_refs_json,
            source_system)
           VALUES
           (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          eventId,
          correlationId,
          sequence,
          occurredAt,
          actorSubject,
          actorType || 'agent',
          actorIssuer || 'djimitflo',
          artifactId,
          previousState ?? null,
          requestedState,
          policyDecision,
          payloadDigest,
          payloadJson,
          JSON.stringify(evidenceRefs ?? []),
          sourceSystem,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'emit_failed', detail }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            emitted: true,
            event_id: eventId,
            correlation_id: correlationId,
            sequence,
            policy_decision: policyDecision,
            payload_digest: payloadDigest,
          }, null, 2),
        }],
      };
    },
  );

  // ─── authority_stats ─────────────────────────────────────────────────
  server.registerTool(
    'djimitflo_authority_stats',
    {
      description:
        'Authority Ledger aggregates: totals per decision, per requested state, per source system; recent DENY/HOLD events.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional(),
      },
    },
    async ({ limit = 20 }) => {
      if (!tableExists(dbHandle, 'authority_events')) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ total: 0, note: 'authority_events nog niet gemigreerd' }, null, 2),
          }],
        };
      }
      const total = rows(dbHandle, 'SELECT COUNT(*) AS n FROM authority_events');
      const byDecision = rows(
        dbHandle,
        'SELECT policy_decision, COUNT(*) AS n FROM authority_events GROUP BY policy_decision',
      );
      const byState = rows(
        dbHandle,
        'SELECT requested_state, COUNT(*) AS n FROM authority_events GROUP BY requested_state',
      );
      const bySource = rows(
        dbHandle,
        'SELECT source_system, COUNT(*) AS n FROM authority_events GROUP BY source_system',
      );
      const recent = rows(
        dbHandle,
        `SELECT event_id, correlation_id, sequence, occurred_at, requested_state,
                policy_decision, actor_subject, source_system
         FROM authority_events
         WHERE policy_decision != 'ALLOW'
         ORDER BY occurred_at DESC LIMIT ?`,
        limit,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total: total[0]?.n ?? 0,
            by_decision: byDecision,
            by_requested_state: byState,
            by_source_system: bySource,
            recent_denials_and_holds: recent,
          }, null, 2),
        }],
      };
    },
  );
}