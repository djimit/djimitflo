import type { Database } from 'better-sqlite3';
import { createHash } from 'crypto';

export type BoardEpistemicRole = 'claim' | 'question' | 'objection' | 'proposal' | 'outcome';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function boardMessageFingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function boardProtocolError(role: unknown, evidence: unknown, thread?: unknown, replyTo?: unknown): string | null {
  const validRoles = new Set<BoardEpistemicRole>(['claim', 'question', 'objection', 'proposal', 'outcome']);
  if (role !== undefined && role !== null && (typeof role !== 'string' || !validRoles.has(role as BoardEpistemicRole))) {
    return 'BOARD_EPISTEMIC_ROLE_INVALID';
  }
  if (role === 'claim' || role === 'proposal' || role === 'outcome') {
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return role === 'claim' ? 'BOARD_CLAIM_EVIDENCE_REQUIRED' : 'BOARD_ACTION_EVIDENCE_REQUIRED';
    }
    if (evidence.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      return role === 'claim' ? 'BOARD_CLAIM_EVIDENCE_REQUIRED' : 'BOARD_ACTION_EVIDENCE_REQUIRED';
    }
  }
  if (replyTo !== undefined && replyTo !== null && (typeof replyTo !== 'string' || replyTo.trim().length === 0)) {
    return 'BOARD_REPLY_TO_INVALID';
  }
  if (typeof replyTo === 'string' && replyTo.trim().length > 0
    && (typeof thread !== 'string' || thread.trim().length === 0)) {
    return 'BOARD_REPLY_THREAD_REQUIRED';
  }
  if (role !== undefined && role !== null && (typeof thread !== 'string' || thread.trim().length === 0)) {
    return 'BOARD_THREAD_REQUIRED';
  }
  return null;
}

export function boardReplyTargetError(db: Database, replyTo: unknown, thread: unknown, sender?: unknown, recipient?: unknown): string | null {
  if (typeof replyTo !== 'string' || !replyTo.trim()) return null;
  let target: { payload_json?: string; from_agent?: string; to_agent?: string; from_agent_id?: string; to_agent_id?: string } | undefined;
  let targetStore: 'agent_messages' | 'messages' | undefined;
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (hasTable('agent_messages')) {
    target = db.prepare('SELECT payload_json, from_agent, to_agent FROM agent_messages WHERE id = ?').get(replyTo.trim()) as typeof target;
    if (target) targetStore = 'agent_messages';
  }
  if (!target && hasTable('messages')) {
    target = db.prepare('SELECT payload AS payload_json, from_agent_id, to_agent_id FROM messages WHERE id = ?').get(replyTo.trim()) as typeof target;
    if (target) targetStore = 'messages';
  }
  if (!target) return 'BOARD_REPLY_TARGET_NOT_FOUND';
  let targetPayload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(target.payload_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) targetPayload = parsed;
  } catch {
    return 'BOARD_REPLY_TARGET_INVALID';
  }
  const targetThread = targetPayload.thread_id ?? targetPayload.threadId;
  if (!(typeof thread === 'string' && typeof targetThread === 'string' && thread.trim() === targetThread.trim())) {
    return 'BOARD_REPLY_THREAD_MISMATCH';
  }
  if (sender !== undefined || recipient !== undefined) {
    const targetFrom = target.from_agent ?? target.from_agent_id;
    const targetTo = target.to_agent ?? target.to_agent_id;
    const senderValue = typeof sender === 'string' ? sender.trim() : '';
    const recipientValue = typeof recipient === 'string' ? recipient.trim() : '';
    const participantsMatch = recipientValue === 'broadcast'
      ? targetTo === 'broadcast'
        && (targetStore !== 'agent_messages'
          || Boolean(db.prepare('SELECT 1 FROM agent_message_deliveries WHERE message_id = ? AND agent_id = ?').get(replyTo.trim(), senderValue)))
      : targetTo !== 'broadcast'
        && new Set([targetFrom, targetTo]).has(senderValue)
        && new Set([targetFrom, targetTo]).has(recipientValue);
    if (!participantsMatch) return 'BOARD_REPLY_PARTICIPANT_MISMATCH';
  }
  return null;
}
