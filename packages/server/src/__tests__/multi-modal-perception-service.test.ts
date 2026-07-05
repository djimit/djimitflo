import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MultiModalPerceptionService } from '../services/multi-modal-perception-service';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let perception: MultiModalPerceptionService;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  perception = new MultiModalPerceptionService(db);
});

afterEach(() => {
  db?.close();
});

describe('G59: Multi-Modal Perception', () => {
  it('describeImage returns fallback when unavailable', async () => {
    const desc = await perception.describeImage('/nonexistent.png');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  it('processScreenshot returns result', async () => {
    const result = await perception.processScreenshot('/tmp/screenshot.png');
    expect(result.type).toBe('screenshot');
    expect(result.content).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('processDiagram returns result', async () => {
    const result = await perception.processDiagram('/tmp/diagram.png');
    expect(result.type).toBe('diagram');
    expect(result.content).toBeDefined();
  });

  it('extractTextFromImage returns message', async () => {
    const text = await perception.extractTextFromImage('/tmp/image.png');
    expect(typeof text).toBe('string');
  });

  it('getHistory returns processed results', async () => {
    await perception.processScreenshot('/tmp/test1.png');
    await perception.processScreenshot('/tmp/test2.png');
    const history = perception.getHistory(10);
    expect(history.length).toBe(2);
  });

  it('result has structured data', async () => {
    const result = await perception.processScreenshot('/tmp/data.png');
    expect(result.structuredData).toBeDefined();
  });
});
