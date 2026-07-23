/**
 * LoopEventService — manages loop event recording and querying.
 *
 * Handles:
 * - Event recording with automatic metadata compression
 * - Event listing with pagination and filtering
 * - Event aggregation for dashboards
 *
 * Extracted from LoopService to isolate event persistence logic
 * and enable independent testing.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { LoopEventRecord } from './loop-types';

export interface EventFilter {
  loop_run_id?: string;
  event_type?: string;
  level?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EventAggregation {
  event_type: string;
  count: number;
  last_occurred: string;
}

export class LoopEventService {
  constructor(private db: Database) {}

  /**
   * Record a loop event. Large metadata objects (>500 chars) are automatically
   * compressed using ContextCompressionService when beneficial.
   */
  recordEvent(
    loopRunId: string,
    eventType: string,
    level: 'debug' | 'info' | 'warning' | 'error' | 'critical',
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    let metadataStr = JSON.stringify(metadata);
    if (metadataStr.length > 500) {
      try {
        const { ContextCompressionService } = require('./context-compression-service');
        const compressor = new ContextCompressionService(this.db);
        const result = compressor.compress(metadataStr, 'json');
        if (result.ratio < 0.9) {
          metadataStr = JSON.stringify({ _compressed: true, _hash: result.hash, data: result.compressed });
        }
      } catch { /* fallback to uncompressed */ }
    }
    this.db.prepare(`
      INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), loopRunId, eventType, level, message, metadataStr, new Date().toISOString());
  }

  /**
   * List events for a loop run, ordered by creation time.
   */
  listEvents(loopRunId: string): LoopEventRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM loop_events WHERE loop_run_id = ? ORDER BY created_at ASC'
    ).all(loopRunId) as any[];
    return rows.map(row => this.parseEvent(row));
  }

  /**
   * Query events with filters.
   */
  queryEvents(filter: EventFilter): LoopEventRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.loop_run_id) {
      conditions.push('loop_run_id = ?');
      params.push(filter.loop_run_id);
    }
    if (filter.event_type) {
      conditions.push('event_type = ?');
      params.push(filter.event_type);
    }
    if (filter.level) {
      conditions.push('level = ?');
      params.push(filter.level);
    }
    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM loop_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return rows.map(row => this.parseEvent(row));
  }

  /**
   * Aggregate events by type for a loop run.
   */
  aggregateEvents(loopRunId: string): EventAggregation[] {
    const rows = this.db.prepare(`
      SELECT event_type, COUNT(*) as count, MAX(created_at) as last_occurred
      FROM loop_events
      WHERE loop_run_id = ?
      GROUP BY event_type
      ORDER BY count DESC
    `).all(loopRunId) as any[];

    return rows.map(row => ({
      event_type: row.event_type,
      count: row.count,
      last_occurred: row.last_occurred,
    }));
  }

  /**
   * Get the latest event for a loop run.
   */
  getLatestEvent(loopRunId: string): LoopEventRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM loop_events WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(loopRunId) as any | undefined;

    return row ? this.parseEvent(row) : null;
  }

  /**
   * Count events for a loop run.
   */
  countEvents(loopRunId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as c FROM loop_events WHERE loop_run_id = ?'
    ).get(loopRunId) as { c: number };
    return row.c;
  }

  /**
   * Delete all events for a loop run.
   */
  deleteEvents(loopRunId: string): number {
    const result = this.db.prepare(
      'DELETE FROM loop_events WHERE loop_run_id = ?'
    ).run(loopRunId);
    return result.changes;
  }

  private parseEvent(row: any): LoopEventRecord {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      event_type: row.event_type,
      level: row.level,
      message: row.message,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
    };
  }
}
