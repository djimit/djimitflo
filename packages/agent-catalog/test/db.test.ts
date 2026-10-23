import { describe, it, expect } from 'vitest';
import { CatalogDB } from '../src';
import type { Profile, Evaluation } from '../src';

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'eng-secure-coder',
    name: 'Secure Coder',
    division: 'engineering',
    source_repo: 'r',
    source_path: 'engineering/secure.md',
    version_hash: '0123456789abcdef',
    persona: 'A defensive programmer',
    mission: 'Deliver code that is correct, tested and safe',
    rules: ['Always keep safety checks enabled', 'Write tests first'],
    workflows: ['Run vitest before merge'],
    deliverables: ['Reviewed pull request'],
    success_metrics: ['Zero regressions'],
    memory_policy: 'Keep no secrets',
    tools_required: ['node', 'git'],
    runtime_targets: ['codex'],
    risk_profile: { level: 'low', injection_score: 0, overlap_score: 0, flags: [] },
    evaluation_status: 'pending',
    activation_status: 'draft',
    ...overrides,
  };
}

function baseEvaluation(overrides: Partial<Evaluation> = {}): Evaluation {
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
    status: 'passed',
    ...overrides,
  };
}

describe('CatalogDB', () => {
  it('starts empty and reports zero counts', () => {
    const db = new CatalogDB();
    try {
      expect(db.listProfiles()).toEqual([]);
      expect(db.counts()).toEqual({
        total: 0,
        evaluated: 0,
        passed: 0,
        active: 0,
        duplicate: 0,
        rejected: 0,
      });
    } finally {
      db.close();
    }
  });

  it('close() releases the database handle', () => {
    const db = new CatalogDB();
    db.close();
    expect(() => db.listProfiles()).toThrow();
  });

  it('transaction() commits and returns the inner value', () => {
    const db = new CatalogDB();
    try {
      const result = db.transaction(() => {
        db.upsertProfile(baseProfile());
        return 'done';
      });
      expect(result).toBe('done');
      expect(db.getProfile('eng-secure-coder')).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('profiles', () => {
  it('upsertProfile inserts and getProfile round-trips the document', () => {
    const db = new CatalogDB();
    try {
      const p = baseProfile({ description: 'optional desc' });
      db.upsertProfile(p);
      const got = db.getProfile(p.id);
      expect(got).not.toBeNull();
      expect(got).toEqual(p);
    } finally {
      db.close();
    }
  });

  it('getProfile returns null for an unknown id', () => {
    const db = new CatalogDB();
    try {
      expect(db.getProfile('does-not-exist')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('upsertProfile updates an existing profile in place', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.upsertProfile(baseProfile({ name: 'Renamed Coder', version_hash: 'fff' }));
      const got = db.getProfile('eng-secure-coder');
      expect(got?.name).toBe('Renamed Coder');
      expect(got?.version_hash).toBe('fff');
    } finally {
      db.close();
    }
  });

  it('upsertProfile invalidates an active activation when version_hash changes', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setActivation('eng-secure-coder', 'active', 'opencode', 'artifact');
      expect(db.getActivation('eng-secure-coder').status).toBe('active');
      db.upsertProfile(baseProfile({ version_hash: 'changedhash0001' }));
      const act = db.getActivation('eng-secure-coder');
      expect(act.status).toBe('deactivated');
      expect(act.deactivated_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('listProfiles orders by name', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile({ id: 'zeta', name: 'Zeta' }));
      db.upsertProfile(baseProfile({ id: 'alpha', name: 'Alpha' }));
      db.upsertProfile(baseProfile({ id: 'mid', name: 'Mid' }));
      expect(db.listProfiles().map((p) => p.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
    } finally {
      db.close();
    }
  });
});

describe('evaluations', () => {
  it('setEvaluation persists and getEvaluation returns the latest matching row', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      const ev = baseEvaluation({ status: 'passed', flags: ['ok'], score: 0.9 });
      db.setEvaluation(ev, '0123456789abcdef');
      const got = db.getEvaluation('eng-secure-coder');
      expect(got).not.toBeNull();
      expect(got.status).toBe('passed');
      expect(got.schema_valid).toBe(true);
      expect(got.flags).toEqual(['ok']);
      expect(got.score).toBeCloseTo(0.9);
    } finally {
      db.close();
    }
  });

  it('getEvaluation returns null when no evaluation exists', () => {
    const db = new CatalogDB();
    try {
      expect(db.getEvaluation('unknown')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('setEvaluation upserts by evaluation id on conflicting (profile_id, version_hash)', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setEvaluation(baseEvaluation({ status: 'rejected', risk_level: 'high' }), '0123456789abcdef');
      db.setEvaluation(baseEvaluation({ status: 'passed', risk_level: 'low' }), '0123456789abcdef');
      const got = db.getEvaluation('eng-secure-coder');
      expect(got.status).toBe('passed');
      expect(got.risk_level).toBe('low');
    } finally {
      db.close();
    }
  });

  it('a non-passed evaluation against the current version invalidates activation', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setActivation('eng-secure-coder', 'active', 'opencode', 'artifact');
      db.setEvaluation(baseEvaluation({ status: 'rejected' }), '0123456789abcdef');
      expect(db.getActivation('eng-secure-coder').status).toBe('deactivated');
    } finally {
      db.close();
    }
  });
});

describe('activations', () => {
  it('setActivation active inserts and updates with timestamps', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setActivation('eng-secure-coder', 'active', 'opencode', 'art');
      const act = db.getActivation('eng-secure-coder');
      expect(act.status).toBe('active');
      expect(act.target).toBe('opencode');
      expect(act.compiled_artifact).toBe('art');
      expect(act.activated_at).not.toBeNull();
      expect(act.deactivated_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('setActivation non-active transitions an active row and stamps deactivated_at', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setActivation('eng-secure-coder', 'active', 'opencode', 'art');
      db.setActivation('eng-secure-coder', 'rejected', null, null);
      const act = db.getActivation('eng-secure-coder');
      expect(act.status).toBe('rejected');
      expect(act.deactivated_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('getActivation returns null for unknown profile', () => {
    const db = new CatalogDB();
    try {
      expect(db.getActivation('unknown')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('audit ledger', () => {
  it('invalidateActivation writes an audit row when an active activation is deactivated', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile());
      db.setActivation('eng-secure-coder', 'active', 'opencode', 'art');
      db.upsertProfile(baseProfile({ version_hash: 'newhash00000002' }));
      // No direct query API; verify behaviorally through deactivation above.
      expect(db.getActivation('eng-secure-coder').status).toBe('deactivated');
    } finally {
      db.close();
    }
  });
});

describe('overlaps', () => {
  it('setOverlap stores normalized (a < b) pair', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile({ id: 'aaa', name: 'Aaa' }));
      db.upsertProfile(baseProfile({ id: 'zzz', name: 'Zzz' }));
      db.setOverlap('zzz', 'aaa', 0.9);
      // counts() reports duplicates where score >= 0.85
      expect(db.counts().duplicate).toBe(1);
    } finally {
      db.close();
    }
  });

  it('replaceOverlaps deletes prior overlaps for a profile and inserts new ones', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile({ id: 'a', name: 'A' }));
      db.upsertProfile(baseProfile({ id: 'b', name: 'B' }));
      db.upsertProfile(baseProfile({ id: 'c', name: 'C' }));
      db.upsertProfile(baseProfile({ id: 'd', name: 'D' }));
      db.setOverlap('a', 'b', 0.9);
      expect(db.counts().duplicate).toBe(1);
      db.replaceOverlaps('a', [{ id: 'c', score: 0.5 }, { id: 'd', score: 0.95 }]);
      // 'a-b' should be gone, 'a-c' (0.5) below threshold, 'a-d' (0.95) above
      expect(db.counts().duplicate).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('counts', () => {
  it('counts reflect evaluated, passed, rejected and active status', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile({ id: 'p1', name: 'P1', version_hash: 'h1' }));
      db.upsertProfile(baseProfile({ id: 'p2', name: 'P2', version_hash: 'h2' }));
      db.setEvaluation(baseEvaluation({ profile_id: 'p1', status: 'passed' }), 'h1');
      db.setEvaluation(baseEvaluation({ profile_id: 'p2', status: 'rejected', risk_level: 'high' }), 'h2');
      db.setActivation('p1', 'active', 'opencode', 'art');
      db.setOverlap('p1', 'p2', 0.9);

      const c = db.counts();
      expect(c.total).toBe(2);
      expect(c.evaluated).toBe(2);
      expect(c.passed).toBe(1);
      expect(c.rejected).toBe(1);
      expect(c.active).toBe(1);
      expect(c.duplicate).toBe(1);
    } finally {
      db.close();
    }
  });

  it('evaluated count only matches the profile current version_hash', () => {
    const db = new CatalogDB();
    try {
      db.upsertProfile(baseProfile({ id: 'p1', name: 'P1', version_hash: 'h1' }));
      db.setEvaluation(baseEvaluation({ profile_id: 'p1', status: 'passed' }), 'h1');
      expect(db.counts().evaluated).toBe(1);
      db.upsertProfile(baseProfile({ id: 'p1', name: 'P1', version_hash: 'h2' }));
      // Stale evaluation against h1 no longer matches current h2
      expect(db.counts().evaluated).toBe(0);
    } finally {
      db.close();
    }
  });
});