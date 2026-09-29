import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { earnedAutonomy, type ClassRecord } from './earned-autonomy';

/**
 * S2 (operator 2026-09-28): the operator's open decisions in one place instead of in chat.
 * - requeue candidates (D2): regressed / infra_failed / no_change proposals of the last 30 days, with any existing requeue
 * - pre-screen labelling (D5): proposals whose latest proposal_prescreen verdict was 'no', with the operator's label if any;
 *   labels are stored as `operator_label` judgments so the false-rejection rate can be computed next to the verdicts
 * - Telegram allowlist (D3): the rows of telegram_identities (ids only, no tokens)
 */
export interface InboxRequeue { id: string; title: string; status: string; updated_at: string; requeued_as: string | null }
export interface InboxLabel { id: string; title: string; status: string; reason: string; verdict_at: string; label: 'ok' | 'wrong' | null }
export interface DecisionsInbox {
  requeue: InboxRequeue[];
  prescreen: { items: InboxLabel[]; labelled: number; wrong: number; false_rejection_pct: number | null; enforce_threshold: string };
  telegram: Array<{ telegram_user_id: string; user_id: string; email: string | null; role: string | null; added_by: string; created_at: string }>;
  memory: Array<{ id: string; title: string; content: string; memory_type: string; status: string; created_at: string }>;
  autonomy: ClassRecord[];
}

export function decisionsInbox(db: Database, now = Date.now()): DecisionsInbox {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  const requeue = all<InboxRequeue>(`SELECT s.id, s.title, s.status, s.updated_at,
      (SELECT c.id FROM self_improvements c WHERE c.evidence_refs_json LIKE '%"requeue-of:' || s.id || '"%' LIMIT 1) AS requeued_as
    FROM self_improvements s WHERE s.status IN ('regressed', 'infra_failed', 'no_change') AND s.updated_at >= ? ORDER BY s.updated_at DESC LIMIT 50`, d30);
  const items = all<InboxLabel>(`SELECT s.id, s.title, s.status, j.reason, j.created_at AS verdict_at,
      (SELECT CASE l.decision WHEN 'yes' THEN 'ok' WHEN 'no' THEN 'wrong' END FROM judgments l
        WHERE l.judgment = 'operator_label' AND l.subject_id = s.id ORDER BY l.created_at DESC LIMIT 1) AS label
    FROM judgments j JOIN self_improvements s ON s.id = j.subject_id
    WHERE j.judgment = 'proposal_prescreen' AND j.decision = 'no'
      AND j.created_at = (SELECT MAX(created_at) FROM judgments x WHERE x.judgment = 'proposal_prescreen' AND x.subject_id = j.subject_id)
    ORDER BY j.created_at DESC LIMIT 100`);
  const labelled = items.filter((i) => i.label).length; const wrong = items.filter((i) => i.label === 'wrong').length;
  const telegram = all<DecisionsInbox['telegram'][number]>(`SELECT t.telegram_user_id, t.user_id, u.email, u.role, t.added_by, t.created_at
    FROM telegram_identities t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at`);
  // memory review (U4): candidates waiting for a human; promote/reject via /swarms/memory/candidates/:id/{promote,reject}
  const memory = all<DecisionsInbox['memory'][number]>(`SELECT id, title, substr(content, 1, 600) AS content, memory_type, status, created_at FROM memory_candidates
    WHERE status IN ('review_required', 'candidate') ORDER BY CASE status WHEN 'review_required' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`);
  return {
    autonomy: earnedAutonomy(db, now),
    memory,
    requeue,
    prescreen: { items, labelled, wrong, false_rejection_pct: labelled ? Math.round((1000 * wrong) / labelled) / 10 : null, enforce_threshold: '>= 30 labelled and <= 5 % wrong (D5)' },
    telegram,
  };
}

/** D5: the operator's verdict on a pre-screen rejection ('ok' = rejecting was right, 'wrong' = it deserved a panel). */
export function labelPrescreen(db: Database, improvementId: string, label: 'ok' | 'wrong', actor: string): void {
  const verdict = db.prepare(`SELECT 1 FROM judgments WHERE judgment = 'proposal_prescreen' AND subject_id = ? AND decision = 'no' LIMIT 1`).get(improvementId);
  if (!verdict) throw new Error('LABEL_NO_PRESCREEN_REJECTION');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'operator_label', 'self_improvement', ?, 'proposal_prescreen', 'enforce', ?, ?, ?)`)
    .run(randomUUID(), improvementId, label === 'ok' ? 'yes' : 'no', `proposal_prescreen rejection labelled '${label}' by ${actor}`, new Date().toISOString());
}

/** D3: add or remove an allowlist row (ids only). The mapped user must exist. */
export function setTelegramIdentity(db: Database, telegramUserId: string, userId: string | null, actor: string, note?: string): void {
  const id = String(telegramUserId).trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('TELEGRAM_ID_INVALID');
  const audit = (what: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'telegram_access', 'telegram_user', ?, 'allowlist', 'enforce', 'yes', ?, ?)`).run(randomUUID(), id, `allowlist ${what} by ${actor}`, new Date().toISOString());
  if (userId === null) { db.prepare('DELETE FROM telegram_identities WHERE telegram_user_id = ?').run(id); audit('removed'); return; }
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error('TELEGRAM_USER_NOT_FOUND');
  audit(`set -> ${userId}`);
  db.prepare(`INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET user_id = excluded.user_id, added_by = excluded.added_by, note = excluded.note`)
    .run(id, userId, actor, note?.slice(0, 200) ?? null);
}
