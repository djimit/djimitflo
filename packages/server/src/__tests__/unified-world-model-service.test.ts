import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { UnifiedWorldModelService } from '../services/unified-world-model-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let worldModel: UnifiedWorldModelService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  worldModel = new UnifiedWorldModelService(db);
});

afterEach(() => {
  db?.close();
});

describe('G77: Unified World Model', () => {
  it('learns domain relation', () => {
    worldModel.learnDomainRelation('code', 'infrastructure', 'deploys_to', 0.8);
    const relations = worldModel.getDomainRelations('code');
    expect(relations.length).toBe(1);
  });

  it('cross domain query', () => {
    worldModel.learnDomainRelation('code', 'infrastructure', 'deploys_to', 0.8);
    const query = worldModel.crossDomainQuery('code', 'infrastructure', { action: 'deploy' });
    expect(query.confidence).toBeGreaterThan(0);
  });

  it('gets all domains', () => {
    worldModel.learnDomainRelation('code', 'data', 'feeds', 0.6);
    worldModel.learnDomainRelation('infra', 'data', 'hosts', 0.7);
    const domains = worldModel.getAllDomains();
    expect(domains.length).toBeGreaterThanOrEqual(3);
  });

  it('updates existing relation', () => {
    worldModel.learnDomainRelation('code', 'infra', 'deploys', 0.5);
    worldModel.learnDomainRelation('code', 'infra', 'deploys', 0.9);
    const relations = worldModel.getDomainRelations('code');
    expect(relations[0].strength).toBe(0.9);
  });

  it('bidirectional relations', () => {
    worldModel.learnDomainRelation('A', 'B', 'relates', 0.7);
    const aRels = worldModel.getDomainRelations('A');
    const bRels = worldModel.getDomainRelations('B');
    expect(aRels.length).toBe(1);
    expect(bRels.length).toBe(1);
  });
});
