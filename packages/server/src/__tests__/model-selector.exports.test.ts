import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getLlmLedger, setLlmLedger } from '../services/model-selector';

describe('model-selector exports — getLlmLedger', () => {
  afterEach(() => {
    setLlmLedger(null);
  });

  it('returns null when no ledger has been registered', () => {
    setLlmLedger(null);
    expect(getLlmLedger()).toBeNull();
  });

  it('returns the database handle registered via setLlmLedger', () => {
    const db = new Database(':memory:');
    try {
      setLlmLedger(db);
      expect(getLlmLedger()).toBe(db);
    } finally {
      db.close();
    }
  });

  it('returns null again after resetting with setLlmLedger(null)', () => {
    const db = new Database(':memory:');
    try {
      setLlmLedger(db);
      expect(getLlmLedger()).toBe(db);
      setLlmLedger(null);
      expect(getLlmLedger()).toBeNull();
    } finally {
      db.close();
    }
  });
});
