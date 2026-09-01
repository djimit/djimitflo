/**
 * Authority gate (G3.4, 2026-08-31) — fail-closed capability check voor
 * de LoopDaemon.
 *
 * Elke goal-start zonder een ALLOW-approval-record in authority_events
 * wordt geweigerd in `enforce`-mode, of alleen gesignaleerd (DENY-event
 * geëmit) in `on`-mode (observe). Flag `off` (default) = gedrag onveranderd.
 *
 * Dit sluit de laatste CaMeL-schakel: ook de always-on daemon faalt dicht.
 */

import type { Database } from 'better-sqlite3';

export interface AuthorityGateResult {
  allowed: boolean;
  reason: string;
  mode: 'off' | 'on' | 'enforce';
  denyEmitted?: string;
}

const GATE_FLAG = String(process.env.AUTHORITY_GATE ?? 'off').toLowerCase();

export function authorityGateForGoal(
  db: Database,
  goal: { id: string; objective: string },
): AuthorityGateResult {
  if (GATE_FLAG !== 'on' && GATE_FLAG !== 'enforce') {
    return { allowed: true, reason: 'authority flag off', mode: 'off' };
  }

  const emitDeny = (detail: string): string => {
    try {
      const crypto = require('node:crypto') as typeof import('node:crypto');
      const seqRow = db.prepare(
        'SELECT sequence FROM authority_events WHERE correlation_id=? '
        + 'ORDER BY sequence DESC LIMIT 1',
      ).get(goal.id) as { sequence: number } | undefined;
      const seq = (seqRow?.sequence ?? 0) + 1;
      const eid = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const payload = JSON.stringify({
        goal_id: goal.id,
        objective: String(goal.objective ?? '').slice(0, 200),
        detail,
      });
      const digest = 'sha256:' + crypto.createHash('sha256')
        .update(payload).digest('hex');
      db.prepare(
        `INSERT INTO authority_events
        (id, event_id, correlation_id, sequence, occurred_at,
         actor_subject, actor_type, actor_issuer, artifact_id,
         requested_state, policy_decision, payload_digest, payload_json,
         evidence_refs_json, source_system)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECT', 'DENY', ?, ?, '[]', 'loop-daemon')`,
      ).run(eid, eid, goal.id, seq, nowIso,
            'loop-daemon', 'agent', 'djimitflo', goal.id,
            digest, payload);
      return eid;
    } catch (emitErr) {
      console.error('[authority-gate] DENY-emit failed:',
        emitErr instanceof Error ? emitErr.message : String(emitErr));
      return '';
    }
  };

  try {
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='authority_events'",
    ).get() as { name: string } | undefined;
    if (!tableExists) {
      if (GATE_FLAG === 'enforce') {
        return { allowed: false, mode: 'enforce',
                 reason: 'authority_events table missing (fail-closed)' };
      }
      emitDeny('table missing');
      return { allowed: true, mode: 'on', reason: 'table missing (observed)' };
    }

    const allowRows = db.prepare(
      `SELECT event_id FROM authority_events
      WHERE policy_decision = 'ALLOW'
        AND requested_state IN ('PLAN_APPROVED', 'DEPLOYED')
        AND artifact_id = ?
      ORDER BY sequence DESC LIMIT 1`,
    ).get(goal.id) as { event_id: string } | undefined;

    if (allowRows) {
      return {
        allowed: true,
        reason: `allow event ${allowRows.event_id.slice(0, 8)}`,
        mode: GATE_FLAG === 'enforce' ? 'enforce' : 'on',
      };
    }

    const denyId = emitDeny('no ALLOW-approval for goal');
    if (GATE_FLAG === 'enforce') {
      return {
        allowed: false,
        mode: 'enforce',
        reason: `goal ${goal.id.slice(0, 8)} heeft geen ALLOW-approval `
              + `(DENY ${denyId ? denyId.slice(0, 8) : 'emit-failed'})`,
      };
    }
    return {
      allowed: true,
      mode: 'on',
      reason: 'observed deny (no ALLOW-approval)',
      denyEmitted: denyId,
    };
  } catch (err) {
    if (GATE_FLAG === 'enforce') {
      return {
        allowed: false,
        mode: 'enforce',
        reason: `gate error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    console.error('[authority-gate] error:', err);
    return { allowed: true, mode: 'on', reason: 'gate error (observed)' };
  }
}