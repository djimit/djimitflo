import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { ROLE_PERMISSIONS, type UserRole } from '@djimitflo/shared';

/**
 * D3 (operator 2026-09-28): who is behind a Telegram message.
 * - only an explicit row in telegram_identities (telegram user id -> Djimitflo user) identifies anyone;
 *   the chat, group or bot it arrived through is never consulted
 * - the mapped user must exist and be active; their RBAC role is the only source of permissions
 * - unknown or inactive ids are denied, and every decision is audited as a `telegram_access` judgment
 * - approving via Telegram requires the same permission as in the web UI (`approve:task`)
 * The table ships empty; the operator adds the ids.
 */
export interface TelegramActor { telegramUserId: string; userId: string; role: UserRole }

function audit(db: Database, telegramUserId: string, action: string, allowed: boolean, reason: string): void {
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES (?, 'telegram_access', 'telegram_user', ?, ?, 'enforce', ?, ?, ?)`)
      .run(randomUUID(), telegramUserId, action.slice(0, 16), allowed ? 'yes' : 'no', `${action}: ${reason}`, new Date().toISOString());
  } catch { /* auditing must not turn a deny into an allow or crash the gateway */ }
}

export function resolveTelegramActor(db: Database, telegramUserId: string | number, action = 'resolve'): TelegramActor | null {
  const id = String(telegramUserId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) { audit(db, id || '(missing)', action, false, 'invalid telegram user id'); return null; }
  const row = db.prepare(`SELECT t.user_id, u.role, u.is_active FROM telegram_identities t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.telegram_user_id = ?`).get(id) as { user_id: string; role: UserRole | null; is_active: number | null } | undefined;
  if (!row) { audit(db, id, action, false, 'not in the allowlist'); return null; }
  if (!row.role || row.is_active !== 1) { audit(db, id, action, false, `mapped user ${row.user_id} missing or inactive`); return null; }
  return { telegramUserId: id, userId: row.user_id, role: row.role };
}

/** True only for an allowlisted, active user whose role may approve in the web UI. Audited either way. */
export function mayApproveViaTelegram(db: Database, telegramUserId: string | number): TelegramActor | null {
  const actor = resolveTelegramActor(db, telegramUserId, 'approve');
  if (!actor) return null;
  const allowed = (ROLE_PERMISSIONS[actor.role] ?? []).includes('approve:task');
  audit(db, actor.telegramUserId, 'approve', allowed, allowed ? `user ${actor.userId} (${actor.role})` : `role ${actor.role} lacks approve:task`);
  return allowed ? actor : null;
}
