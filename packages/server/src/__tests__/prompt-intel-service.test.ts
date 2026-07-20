import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PromptIntelService } from '../services/prompt-intel-service';

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('PromptIntelService', () => {
  it('initializes on an empty SQLite database', () => {
    db = new Database(':memory:');

    const service = new PromptIntelService(db);

    expect(service.getImportStats()).toEqual({ total: 0, byCategory: {} });
  });
});
