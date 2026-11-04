import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SkillLoaderService,
  invalidateSkillArtifactLoaders,
} from '../services/skill-loader-service';

describe('invalidateSkillArtifactLoaders', () => {
  let database: Database.Database;
  let skillsDir: string;

  function writeSkill(id: string, body: string): void {
    const directory = path.join(skillsDir, id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'SKILL.md'),
      ['---', `name: ${id}`, 'description: A bounded test fixture.', 'allowed-tools: Read', '---', body, ''].join('\n'),
      'utf8',
    );
  }

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-skills-'));
    database = new Database(':memory:');
    database.exec('CREATE TABLE agents (id TEXT PRIMARY KEY);');
  });

  afterEach(() => {
    database.close();
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  it('is a void function that does not throw', () => {
    expect(() => invalidateSkillArtifactLoaders()).not.toThrow();
    expect(invalidateSkillArtifactLoaders()).toBeUndefined();
  });

  it('forces a cached SkillLoaderService to reload skills on the next read', () => {
    writeSkill('cached-skill', 'First workflow body for the skill.');
    const service = new SkillLoaderService(database, skillsDir);

    expect(service.listSkills()).toHaveLength(1);
    const firstHash = service.getSkill('cached-skill')?.contentHash;
    expect(firstHash).toBeTruthy();

    // Mutate the SKILL.md on disk; without invalidation the loader serves the cached copy.
    writeSkill('cached-skill', 'Second workflow body for the skill, different content.');
    expect(service.getSkill('cached-skill')?.contentHash).toBe(firstHash);

    // After invalidation the next read must observe the new content hash.
    invalidateSkillArtifactLoaders();
    const reloaded = service.getSkill('cached-skill');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.contentHash).not.toBe(firstHash);
    expect(reloaded?.instructions).toContain('Second workflow body');
  });

  it('is cumulative: each call marks the cache stale again', () => {
    writeSkill('cumulative-skill', 'Initial body.');
    const service = new SkillLoaderService(database, skillsDir);
    const initial = service.getSkill('cumulative-skill')?.contentHash;

    // First invalidation + edit → reload observes the change.
    invalidateSkillArtifactLoaders();
    writeSkill('cumulative-skill', 'First revised body.');
    const afterFirst = service.getSkill('cumulative-skill')?.contentHash;
    expect(afterFirst).not.toBe(initial);

    // A second read without a new invalidation stays cached.
    expect(service.getSkill('cumulative-skill')?.contentHash).toBe(afterFirst);

    // Second invalidation + edit → reload observes the second change.
    invalidateSkillArtifactLoaders();
    writeSkill('cumulative-skill', 'Second revised body.');
    const afterSecond = service.getSkill('cumulative-skill')?.contentHash;
    expect(afterSecond).not.toBe(afterFirst);
    expect(service.getSkill('cumulative-skill')?.instructions).toContain('Second revised body');
  });

  it('does not reload a freshly constructed loader that has already loaded the current generation', () => {
    writeSkill('fresh-skill', 'Body for the fresh loader case.');
    // Bump the generation, then construct a loader so it captures the new generation.
    invalidateSkillArtifactLoaders();
    const service = new SkillLoaderService(database, skillsDir);
    const hash = service.getSkill('fresh-skill')?.contentHash;
    expect(hash).toBeTruthy();

    // A read without another invalidation must not trigger a reload (same hash).
    expect(service.getSkill('fresh-skill')?.contentHash).toBe(hash);
  });
});
