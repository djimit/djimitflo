import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlLiteratureScanBridge } from '../services/segml-literature-scan-bridge';

describe('SegmlLiteratureScanBridge', () => {
  let db: Database.Database;
  let bridge: SegmlLiteratureScanBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlLiteratureScanBridge(db);
  });

  it('seeds literature sources', () => {
    const status = bridge.getStatus();
    expect(status.totalSources).toBe(3);
  });

  it('scans for new categories', async () => {
    const result = await bridge.scanForNewCategories();
    expect(result.sourcesScanned).toBe(3);
    expect(result.newCategoriesFound).toBeGreaterThan(0);
    expect(result.categories.length).toBeGreaterThan(0);
  });

  it('proposes categories with confidence', async () => {
    const result = await bridge.scanForNewCategories();
    for (const cat of result.categories) {
      expect(cat.confidence).toBeGreaterThan(0);
      expect(cat.confidence).toBeLessThanOrEqual(1);
      expect(cat.status).toBe('proposed');
      expect(cat.keywords.length).toBeGreaterThan(0);
    }
  });

  it('does not duplicate known categories', async () => {
    await bridge.scanForNewCategories();
    const result2 = await bridge.scanForNewCategories();
    expect(result2.newCategoriesFound).toBe(0);
  });

  it('approves proposed categories', async () => {
    const result = await bridge.scanForNewCategories();
    if (result.categories.length > 0) {
      const approved = bridge.approveCategory(result.categories[0].id);
      expect(approved).toBe(true);
      const proposed = bridge.getProposedCategories('approved');
      expect(proposed.length).toBe(1);
    }
  });

  it('filters by status', async () => {
    await bridge.scanForNewCategories();
    const proposed = bridge.getProposedCategories('proposed');
    expect(proposed.length).toBeGreaterThan(0);
    const approved = bridge.getProposedCategories('approved');
    expect(approved.length).toBe(0);
  });

  it('reports scan status', async () => {
    await bridge.scanForNewCategories();
    const status = bridge.getStatus();
    expect(status.totalProposed).toBeGreaterThan(0);
    expect(status.pendingReview).toBeGreaterThan(0);
  });
});
