import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AutobiographicalMemoryService } from '../services/autobiographical-memory-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let memory: AutobiographicalMemoryService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  memory = new AutobiographicalMemoryService(db);
});

afterEach(() => {
  db?.close();
});

describe('G65: Autobiographical Memory', () => {
  it('records an event', () => {
    const event = memory.recordEvent({ type: 'learning', title: 'Learned X', description: 'Details', significance: 0.8, context: {} });
    expect(event.id).toBeDefined();
    expect(event.type).toBe('learning');
  });

  it('gets events by type', () => {
    memory.recordEvent({ type: 'learning', title: 'L1', description: 'D1', significance: 0.5, context: {} });
    memory.recordEvent({ type: 'failure', title: 'F1', description: 'D2', significance: 0.5, context: {} });
    const learnings = memory.getEvents('learning');
    expect(learnings.length).toBe(1);
  });

  it('gets significant events', () => {
    memory.recordEvent({ type: 'achievement', title: 'Big win', description: 'D', significance: 0.9, context: {} });
    memory.recordEvent({ type: 'learning', title: 'Small thing', description: 'D', significance: 0.3, context: {} });
    const sig = memory.getSignificantEvents(0.7);
    expect(sig.length).toBe(1);
  });

  it('generates narrative', () => {
    memory.recordEvent({ type: 'achievement', title: 'Success', description: 'D', significance: 0.9, context: {} });
    const narrative = memory.generateNarrative();
    expect(narrative).toContain('1 experiences');
  });

  it('narrative is empty when no events', () => {
    expect(memory.generateNarrative()).toBe('No experiences recorded yet.');
  });

  it('gets timeline in order', () => {
    memory.recordEvent({ type: 'learning', title: 'First', description: 'D', significance: 0.5, context: {} });
    memory.recordEvent({ type: 'learning', title: 'Second', description: 'D', significance: 0.5, context: {} });
    const timeline = memory.getTimeline();
    expect(timeline.length).toBe(2);
  });

  it('searches events', () => {
    memory.recordEvent({ type: 'discovery', title: 'Found X', description: 'Interesting', significance: 0.7, context: {} });
    const results = memory.searchEvents('Found');
    expect(results.length).toBe(1);
  });

  it('getEventCount returns count', () => {
    memory.recordEvent({ type: 'learning', title: 'A', description: 'D', significance: 0.5, context: {} });
    memory.recordEvent({ type: 'learning', title: 'B', description: 'D', significance: 0.5, context: {} });
    expect(memory.getEventCount()).toBe(2);
  });
});
