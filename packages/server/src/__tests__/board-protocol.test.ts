import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  boardMessageFingerprint,
  boardProtocolError,
  boardReplyTargetError,
} from '../services/board-protocol';

describe('boardMessageFingerprint', () => {
  it('produces a stable sha256 hex digest for identical canonical input', () => {
    const a = boardMessageFingerprint({ b: 2, a: 1, nested: { y: 'z', x: 1 } });
    const b = boardMessageFingerprint({ a: 1, b: 2, nested: { x: 1, y: 'z' } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when content differs despite same key set', () => {
    const a = boardMessageFingerprint({ a: 1 });
    const b = boardMessageFingerprint({ a: 2 });
    expect(a).not.toBe(b);
  });

  it('canonicalizes arrays order-sensitively', () => {
    expect(boardMessageFingerprint({ a: [1, 2] })).not.toBe(boardMessageFingerprint({ a: [2, 1] }));
  });
});

describe('boardProtocolError', () => {
  it('returns null when role is undefined/null with no replyTo', () => {
    expect(boardProtocolError(undefined, undefined)).toBeNull();
    expect(boardProtocolError(null, undefined)).toBeNull();
  });

  it('rejects an invalid epistemic role', () => {
    expect(boardProtocolError('garbage', undefined)).toBe('BOARD_EPISTEMIC_ROLE_INVALID');
    expect(boardProtocolError(123, undefined)).toBe('BOARD_EPISTEMIC_ROLE_INVALID');
  });

  it('requires evidence for claim role', () => {
    expect(boardProtocolError('claim', undefined, 't1')).toBe('BOARD_CLAIM_EVIDENCE_REQUIRED');
    expect(boardProtocolError('claim', [], 't1')).toBe('BOARD_CLAIM_EVIDENCE_REQUIRED');
    expect(boardProtocolError('claim', [''], 't1')).toBe('BOARD_CLAIM_EVIDENCE_REQUIRED');
    expect(boardProtocolError('claim', ['   '], 't1')).toBe('BOARD_CLAIM_EVIDENCE_REQUIRED');
    expect(boardProtocolError('claim', ['ok'], 't1')).toBeNull();
  });

  it('requires evidence for proposal and outcome roles (action evidence)', () => {
    expect(boardProtocolError('proposal', undefined, 't1')).toBe('BOARD_ACTION_EVIDENCE_REQUIRED');
    expect(boardProtocolError('outcome', [], 't1')).toBe('BOARD_ACTION_EVIDENCE_REQUIRED');
    expect(boardProtocolError('proposal', ['x'], 't1')).toBeNull();
    expect(boardProtocolError('outcome', ['x'], 't1')).toBeNull();
  });

  it('does not require evidence for question or objection roles', () => {
    expect(boardProtocolError('question', undefined, 't1')).toBeNull();
    expect(boardProtocolError('objection', undefined, 't1')).toBeNull();
  });

  it('rejects blank replyTo but accepts undefined/null', () => {
    expect(boardProtocolError(undefined, undefined, 't1', '  ')).toBe('BOARD_REPLY_TO_INVALID');
    expect(boardProtocolError(undefined, undefined, 't1', undefined)).toBeNull();
  });

  it('requires a thread when replyTo is present', () => {
    expect(boardProtocolError(undefined, undefined, undefined, 'msg-1')).toBe('BOARD_REPLY_THREAD_REQUIRED');
    expect(boardProtocolError(undefined, undefined, '  ', 'msg-1')).toBe('BOARD_REPLY_THREAD_REQUIRED');
    expect(boardProtocolError(undefined, undefined, 't1', 'msg-1')).toBeNull();
  });

  it('requires a thread when a role is set', () => {
    expect(boardProtocolError('question', undefined, undefined)).toBe('BOARD_THREAD_REQUIRED');
    expect(boardProtocolError('question', undefined, '  ')).toBe('BOARD_THREAD_REQUIRED');
  });
});

describe('boardReplyTargetError', () => {
  function makeDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_messages (id TEXT PRIMARY KEY, payload_json TEXT, from_agent TEXT, to_agent TEXT);
      CREATE TABLE agent_message_deliveries (message_id TEXT, agent_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, payload TEXT, from_agent_id TEXT, to_agent_id TEXT);
    `);
    return db;
  }

  it('returns null when replyTo is not a non-empty string', () => {
    const db = makeDb();
    expect(boardReplyTargetError(db, undefined, 't1')).toBeNull();
    expect(boardReplyTargetError(db, '   ', 't1')).toBeNull();
    db.close();
  });

  it('returns BOARD_REPLY_TARGET_NOT_FOUND when no matching message exists', () => {
    const db = makeDb();
    expect(boardReplyTargetError(db, 'missing', 't1')).toBe('BOARD_REPLY_TARGET_NOT_FOUND');
    db.close();
  });

  it('returns BOARD_REPLY_TARGET_INVALID when payload is not JSON', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', '{not json', 'a', 'b');
    expect(boardReplyTargetError(db, 'm1', 't1')).toBe('BOARD_REPLY_TARGET_INVALID');
    db.close();
  });

  it('returns BOARD_REPLY_THREAD_MISMATCH when thread does not match target payload', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', JSON.stringify({ thread_id: 'threadA' }), 'a', 'b');
    expect(boardReplyTargetError(db, 'm1', 'threadB')).toBe('BOARD_REPLY_THREAD_MISMATCH');
    expect(boardReplyTargetError(db, 'm1', 'threadA')).toBeNull();
    db.close();
  });

  it('matches thread via threadId camelCase field', () => {
    const db = makeDb();
    db.prepare('INSERT INTO messages (id, payload, from_agent_id, to_agent_id) VALUES (?, ?, ?, ?)')
      .run('m2', JSON.stringify({ threadId: 'camel' }), 'x', 'y');
    expect(boardReplyTargetError(db, 'm2', 'camel')).toBeNull();
    db.close();
  });

  it('returns BOARD_REPLY_PARTICIPANT_MISMATCH for non-broadcast mismatched sender/recipient', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', JSON.stringify({ thread_id: 't' }), 'alice', 'bob');
    expect(boardReplyTargetError(db, 'm1', 't', 'carol', 'bob')).toBe('BOARD_REPLY_PARTICIPANT_MISMATCH');
    db.close();
  });

  it('accepts participants when sender and recipient are both in the target pair', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', JSON.stringify({ thread_id: 't' }), 'alice', 'bob');
    expect(boardReplyTargetError(db, 'm1', 't', 'bob', 'alice')).toBeNull();
    db.close();
  });

  it('handles broadcast recipients with delivery verification', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', JSON.stringify({ thread_id: 't' }), 'announcer', 'broadcast');
    db.prepare('INSERT INTO agent_message_deliveries (message_id, agent_id) VALUES (?, ?)').run('m1', 'bob');
    expect(boardReplyTargetError(db, 'm1', 't', 'bob', 'broadcast')).toBeNull();
    expect(boardReplyTargetError(db, 'm1', 't', 'carol', 'broadcast')).toBe('BOARD_REPLY_PARTICIPANT_MISMATCH');
    db.close();
  });

  it('skips participant check when sender and recipient are both undefined', () => {
    const db = makeDb();
    db.prepare('INSERT INTO agent_messages (id, payload_json, from_agent, to_agent) VALUES (?, ?, ?, ?)')
      .run('m1', JSON.stringify({ thread_id: 't' }), 'a', 'b');
    expect(boardReplyTargetError(db, 'm1', 't')).toBeNull();
    db.close();
  });
});