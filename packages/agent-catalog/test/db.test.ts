import { describe, it, expect } from 'vitest';
import { CatalogDB, type Profile, type Evaluation } from '../src/db';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'eng-secure-coder',
    name: 'Secure Coder',
    division: 'engineering',
    source_repo: 'r',
    source_path: 'engineering/secure-coder.md',
    version_hash: 'aaaaaaaaaaaaaaaa',
    persona: 'careful engineer',
    mission: 'ship secure code',
    rules: ['no secrets'],
    workflows: ['review PRs'],
    deliverables: ['patch'],
    success_metrics: ['zero vulns'],
    memory_policy: 'ephemeral',
    tools_required: ['git'],
    runtime_targets: ['opencode'],
    risk_profile: { level: 'low', injection_score: 0, overlap_score: 0, flags: [] },
    evaluation_status: 'pending',
    activation_status: 'draft',
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    profile_id: 'eng-secure-coder',
    schema_valid: true,
    schema_errors: [],
    injection_score: 0,
    injection_flags: [],
    overlap_score: 0,
    overlap_with: null,
    overlaps: [],
    risk_level: 'low',
    flags: [],
    status: 'pending',
    ...overrides,
  };
}

describe('CatalogDB', () => {
  describe('profiles', () => {
    it('upserts and retrieves a profile', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      expect(db.getProfile(p.id)).toEqual(p);
      db.close();
    });

    it('returns null for unknown profile id', () => {
      const db = new CatalogDB();
      expect(db.getProfile('nope')).toBeNull();
      db.close();
    });

    it('overwrites fields on re-upsert with same id', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      db.upsertProfile({ ...p, name: 'Secure Coder v2', version_hash: 'bbbbbbbbbbbbbbbb' });
      const got = db.getProfile(p.id);
      expect(got?.name).toBe('Secure Coder v2');
      expect(got?.version_hash).toBe('bbbbbbbbbbbbbbbb');
      db.close();
    });

    it('lists profiles ordered by name', () => {
      const db = new CatalogDB();
      db.upsertProfile(makeProfile({ id: 'b', name: 'Bravo' }));
      db.upsertProfile(makeProfile({ id: 'a', name: 'Alpha' }));
      const list = db.listProfiles();
      expect(list.map(x => x.name)).toEqual(['Alpha', 'Bravo']);
      db.close();
    });
  });

  describe('evaluation version change invalidates activation', () => {
    it('deactivates active activation when version_hash changes', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      db.setActivation(p.id, 'active', 'target', 'artifact');
      expect(db.getActivation(p.id).status).toBe('active');
      db.upsertProfile({ ...p, version_hash: 'cccccccccccccccc' });
      const act = db.getActivation(p.id);
      expect(act.status).toBe('deactivated');
      expect(act.deactivated_at).toBeTruthy();
      db.close();
    });
  });

  describe('evaluations', () => {
    it('stores and retrieves an evaluation', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      const ev = makeEvaluation({ status: 'passed', score: 0.9 });
      db.setEvaluation(ev, p.version_hash);
      const got = db.getEvaluation(p.id);
      expect(got.status).toBe('passed');
      expect(got.schema_valid).toBe(true);
      expect(got.score).toBe(0.9);
      expect(got.flags).toEqual([]);
      db.close();
    });

    it('returns null when no evaluation exists', () => {
      const db = new CatalogDB();
      expect(db.getEvaluation('none')).toBeNull();
      db.close();
    });

    it('upserts evaluation (second write wins)', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      db.setEvaluation(makeEvaluation({ status: 'pending' }), p.version_hash);
      db.setEvaluation(makeEvaluation({ status: 'passed', score: 0.5 }), p.version_hash);
      const got = db.getEvaluation(p.id);
      expect(got.status).toBe('passed');
      expect(got.score).toBe(0.5);
      db.close();
    });

    it('non-passed evaluation for current version invalidates active activation', () => {
      const db = new CatalogDB();
      const p = makeProfile();
      db.upsertProfile(p);
      db.setActivation(p.id, 'active', 't', 'a');
      db.setEvaluation(makeEvaluation({ status: 'rejected' }), p.version_hash);
      expect(db.getActivation(p.id).status).toBe('deactivated');
      db.close();
    });
  });

  describe('activations', () => {
    it('sets active activation with target and artifact', () => {
      const db = new CatalogDB();
      db.upsertProfile(makeProfile());
      db.setActivation('eng-secure-coder', 'active', 'prod', 'artifact');
      const act = db.getActivation('eng-secure-coder');
      expect(act.status).toBe('active');
      expect(act.target).toBe('prod');
      expect(act.compiled_artifact).toBe('artifact');
      expect(act.activated_at).toBeTruthy();
      expect(act.deactivated_at).toBeNull();
      db.close();
    });

    it('transitions active to rejected setting deactivated_at', () => {
      const db = new CatalogDB();
      db.upsertProfile(makeProfile());
      db.setActivation('eng-secure-coder', 'active', 'prod', 'a');
      db.setActivation('eng-secure-coder', 'rejected', null, null);
      const act = db.getActivation('eng-secure-coder');
      expect(act.status).toBe('rejected');
      expect(act.deactivated_at).toBeTruthy();
      db.close();
    });

    it('returns null for unknown activation', () => {
      const db = new CatalogDB();
      expect(db.getActivation('nope')).toBeNull();
      db.close();
    });
  });

  describe('audit ledger', () => {
    it('records audit entries', () => {
      const db = new CatalogDB();
      db.audit('p1', 'created', '{"x":1}');
      const row = (db as any).db.prepare('SELECT * FROM audit_ledger WHERE profile_id=?').get('p1');
      expect(row.action).toBe('created');
      expect(row.detail).toBe('{"x":1}');
      expect(row.at).toBeTruthy();
      db.close();
    });
  });

  describe('overlaps', () => {
    it('stores overlap with ordered pair', () => {
      const db = new CatalogDB();
      db.upsertProfile(makeProfile({ id: 'a' }));
      db.upsertProfile(makeProfile({ id: 'b' }));
      db.setOverlap('b', 'a', 0.9);
      const row = (db as any).db.prepare('SELECT * FROM overlaps').get();
      expect(row.a).toBe('a');
      expect(row.b).toBe('b');
      expect(row.score).toBe(0.9);
      db.close();
    });

    it('replaceOverlaps removes prior and inserts new', () => {
      const db = new CatalogDB();
      db.upsertProfile(makeProfile({ id: 'a' }));
      db.upsertProfile(makeProfile({ id: 'b' }));
      db.upsertProfile(makeProfile({ id: 'c' }));
      db.setOverlap('a', 'b', 0.9);
      db.replaceOverlaps('a', [{ id: 'c', score: 0.5 }]);
      const rows = (db as any).db.prepare('SELECT * FROM overlaps').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(0.5);
      db.close();
    });
  });

  describe('counts', () => {
    it('reports zeros on empty db', () => {
      const db = new CatalogDB();
      expect(db.counts()).toEqual({
        total: 0, evaluated: 0, passed: 0, active: 0, duplicate: 0, rejected: 0,
      });
      db.close();
    });

    it('reports counts after inserts', () => {
      const db = new CatalogDB();
      const p1 = makeProfile({ id: 'p1' });
      const p2 = makeProfile({ id: 'p2', version_hash: 'bbbbbbbbbbbbbbbb' });
      db.upsertProfile(p1);
      db.upsertProfile(p2);
      db.setEvaluation(makeEvaluation({ profile_id: 'p1', status: 'passed' }), p1.version_hash);
      db.setEvaluation(makeEvaluation({ profile_id: 'p2', status: 'rejected' }), p2.version_hash);
      db.setActivation('p1', 'active', 't', 'a');
      db.setOverlap('p1', 'p2', 0.9);
      const c = db.counts();
      expect(c.total).toBe(2);
      expect(c.evaluated).toBe(2);
      expect(c.passed).toBe(1);
      expect(c.rejected).toBe(1);
      expect(c.active).toBe(1);
      expect(c.duplicate).toBe(1);
      db.close();
    });
  });

  describe('close', () => {
    it('closes without error', () => {
      const db = new CatalogDB();
      expect(() => db.close()).not.toThrow();
    });
  });
});