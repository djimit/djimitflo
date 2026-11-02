import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import {
  FACTORY_OWNER,
  CapabilityRequestError,
  capabilityFactoryMode,
  keywords,
  searchRegistry,
} from '../services/capability-factory';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('capabilityFactoryMode', () => {
  it('is off by default and only on when CAPABILITY_FACTORY_MODE=on', () => {
    expect(capabilityFactoryMode({})).toBe('off');
    expect(capabilityFactoryMode({ CAPABILITY_FACTORY_MODE: 'off' })).toBe('off');
    expect(capabilityFactoryMode({ CAPABILITY_FACTORY_MODE: 'on' })).toBe('on');
    expect(capabilityFactoryMode({ CAPABILITY_FACTORY_MODE: 'yes' })).toBe('off');
  });
});

describe('FACTORY_OWNER', () => {
  it('is the capability-factory owner string used by the store', () => {
    expect(FACTORY_OWNER).toBe('capability-factory');
  });
});

describe('CapabilityRequestError', () => {
  it('carries its code alongside the message', () => {
    const err = new CapabilityRequestError('REPO_NOT_REGISTERED', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REPO_NOT_REGISTERED');
    expect(err.message).toBe('nope');
  });
});

describe('keywords', () => {
  it('lowercases, splits on non-alphanumerics, drops words shorter than 4 and stop words', () => {
    const kw = keywords('Slugify titles for URLs with hyphens!');
    expect(kw.has('slugify')).toBe(true);
    expect(kw.has('titles')).toBe(true);
    expect(kw.has('urls')).toBe(true);
    expect(kw.has('hyphens')).toBe(true);
    expect(kw.has('for')).toBe(false); // too short
    expect(kw.has('with')).toBe(false); // stop word
  });

  it('returns an empty set for noise-only text', () => {
    expect(keywords('the a an of to be is')).toEqual(new Set<string>());
    expect(keywords('')).toEqual(new Set<string>());
  });
});

function seedValidated(id: string, owner: string, metadata: Record<string, unknown>) {
  const intel = new SwarmIntelligenceService(db);
  intel.registerCapability({
    id,
    kind: 'deterministic_harness',
    owner,
    version: '1',
    status: 'validated',
    risk_ceiling: 'low',
    input_schema_ref: 'file',
    output_schema_ref: 'test',
    allowed_actions: ['reuse_in_assignment'],
    forbidden_actions: ['deploy'],
    required_evidence: ['proof:test'],
    eval_score: 1,
    removal_strategy: 'deprecate',
    metadata,
  });
}

describe('searchRegistry', () => {
  it('returns only factory-owned validated capabilities when no query is given', () => {
    seedValidated('cap-fac', FACTORY_OWNER, { title: 'URL slug helper', files: ['packages/server/src/services/slug.ts'], test: 'packages/server/src/__tests__/slug.test.ts' });
    seedValidated('cap-other', 'genome-registry', { title: 'Other capability', files: ['packages/server/src/services/other.ts'] });
    const res = searchRegistry(db, '');
    expect(res.map((c) => c.id)).toEqual(['cap-fac']);
    expect(res[0]).toMatchObject({ id: 'cap-fac', status: 'validated', factory: true, title: 'URL slug helper' });
  });

  it('matches a capability whose file equals the query exactly', () => {
    const FILE = 'packages/server/src/services/slug.ts';
    seedValidated('cap-fac', FACTORY_OWNER, { title: 'URL slug helper', files: [FILE], test: 'packages/server/src/__tests__/slug.test.ts' });
    seedValidated('cap-unrelated', FACTORY_OWNER, { title: 'Duration parser', files: ['packages/server/src/services/duration.ts'] });
    const res = searchRegistry(db, FILE);
    expect(res.map((c) => c.id)).toEqual(['cap-fac']);
  });

  it('matches a capability whose title/description contains every keyword of the query', () => {
    seedValidated('cap-fac', FACTORY_OWNER, { title: 'Slugify arbitrary titles into URL slugs', description: 'lowercase hyphens', files: ['packages/server/src/services/other.ts'] });
    const res = searchRegistry(db, 'slugify titles');
    expect(res.map((c) => c.id)).toEqual(['cap-fac']);
    // a partial keyword overlap (only one of two) does not match
    expect(searchRegistry(db, 'slugify durations').map((c) => c.id)).toEqual([]);
  });

  it('ignores capabilities that are not validated', () => {
    seedValidated('cap-fac', FACTORY_OWNER, { title: 'URL slug helper', files: ['packages/server/src/services/slug.ts'] });
    db.prepare("UPDATE swarm_capabilities SET status = 'candidate' WHERE id = 'cap-fac'").run();
    expect(searchRegistry(db, '')).toEqual([]);
    expect(searchRegistry(db, 'slug helper')).toEqual([]);
  });

  it('honours the limit argument', () => {
    for (let i = 0; i < 5; i++) seedValidated(`cap-${i}`, FACTORY_OWNER, { title: `URL slug helper ${i}`, files: [`packages/server/src/services/slug-${i}.ts`] });
    expect(searchRegistry(db, '', 2)).toHaveLength(2);
    expect(searchRegistry(db, 'slug helper', 3)).toHaveLength(3);
  });

  it('returns an empty array when the store is empty or unreadable', () => {
    expect(searchRegistry(db, '')).toEqual([]);
    expect(searchRegistry(db, 'anything')).toEqual([]);
  });

  it('exposes the canonical fields (id, status, title, files, test, repo, factory) on each hit', () => {
    seedValidated('cap-fac', FACTORY_OWNER, { title: 'URL slug helper', files: ['packages/server/src/services/slug.ts'], test: 'packages/server/src/__tests__/slug.test.ts', repo: 'djimitflo' });
    const [hit] = searchRegistry(db, 'slug helper');
    expect(hit).toMatchObject({
      id: 'cap-fac',
      status: 'validated',
      title: 'URL slug helper',
      files: ['packages/server/src/services/slug.ts'],
      test: 'packages/server/src/__tests__/slug.test.ts',
      repo: 'djimitflo',
      factory: true,
    });
  });
});