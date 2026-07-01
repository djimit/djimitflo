import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SkillMarketplaceService } from '../services/skill-marketplace-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let marketplace: SkillMarketplaceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  marketplace = new SkillMarketplaceService(db);
});

afterEach(() => {
  db?.close();
});

describe('G57: Skill Marketplace', () => {
  it('publishes a skill', () => {
    const skill = marketplace.publishSkill('ts-fix', 'TypeScript Fixer', '1.0', { step: 1 });
    expect(skill.id).toBeDefined();
    expect(skill.name).toBe('TypeScript Fixer');
    expect(skill.rating).toBe(0);
  });

  it('searches skills by name', () => {
    marketplace.publishSkill('ts-fix', 'TypeScript Fixer', '1.0', {});
    marketplace.publishSkill('py-fix', 'Python Fixer', '1.0', {});
    const results = marketplace.searchSkills('TypeScript');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('TypeScript Fixer');
  });

  it('installSkill increments count', () => {
    const skill = marketplace.publishSkill('test', 'Test', '1.0', {});
    marketplace.installSkill(skill.id);
    const shared = marketplace.getSharedSkill(skill.id);
    expect(shared!.installCount).toBe(1);
  });

  it('rateSkill updates average', () => {
    const skill = marketplace.publishSkill('rate-me', 'Rate Me', '1.0', {});
    marketplace.rateSkill(skill.id, 5);
    marketplace.rateSkill(skill.id, 3);
    const shared = marketplace.getSharedSkill(skill.id);
    expect(shared!.rating).toBe(4);
    expect(shared!.ratingCount).toBe(2);
  });

  it('rateSkill clamps to 0-5', () => {
    const skill = marketplace.publishSkill('clamp', 'Clamp', '1.0', {});
    marketplace.rateSkill(skill.id, 10);
    marketplace.rateSkill(skill.id, -5);
    const shared = marketplace.getSharedSkill(skill.id);
    expect(shared!.rating).toBeLessThanOrEqual(5);
    expect(shared!.rating).toBeGreaterThanOrEqual(0);
  });

  it('getTrendingSkills sorts by installs', () => {
    const s1 = marketplace.publishSkill('popular', 'Popular', '1.0', {});
    const s2 = marketplace.publishSkill('unpopular', 'Unpopular', '1.0', {});
    for (let i = 0; i < 5; i++) marketplace.installSkill(s1.id);
    marketplace.installSkill(s2.id);
    const trending = marketplace.getTrendingSkills(2);
    expect(trending[0].id).toBe(s1.id);
  });

  it('unpublishSkill removes from marketplace', () => {
    const skill = marketplace.publishSkill('temp', 'Temp', '1.0', {});
    marketplace.unpublishSkill(skill.id);
    expect(marketplace.getSharedSkill(skill.id)).toBeNull();
  });

  it('getAllShared returns all skills', () => {
    marketplace.publishSkill('s1', 'S1', '1.0', {});
    marketplace.publishSkill('s2', 'S2', '1.0', {});
    const all = marketplace.getAllShared();
    expect(all.length).toBe(2);
  });
});
