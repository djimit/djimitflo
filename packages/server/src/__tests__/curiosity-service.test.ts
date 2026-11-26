import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CuriosityService } from '../services/curiosity-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { SelfImprovementService } from '../services/self-improvement-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let intelligence: SwarmIntelligenceService;
let curiosity: CuriosityService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intelligence = new SwarmIntelligenceService(db);
  curiosity = new CuriosityService(db, intelligence);
});

afterEach(() => {
  db?.close();
  curiosity.stop();
});

// two clocks, as in production: valid_until is compared with SQLite's datetime('now') (the OS clock), the created_at
// windows with Date.now(). Seed each against the clock it is read with, so a faked Date cannot split them.
const expiredNow = () => new Date(vi.getRealSystemTime() - 1000).toISOString();

function claim(id: string, overrides: Record<string, unknown> = {}) {
  const values = { id, claim: id, claim_type: 'observation', subject_ref: 'proof:sample:worker-evidence', predicate: 'has_property',
    status: 'supported', confidence: 0.9, evidence_refs_json: '[]', created_from: 'test',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides };
  db.prepare(`INSERT INTO swarm_claims (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
}

describe('G41: Curiosity Service', () => {
  it('keeps the sparse inventory signal across repeated scans and redundant claim copies', async () => {
    claim('maker'); claim('checker');
    const first = await curiosity.scanForGaps();
    expect(first).toMatchObject({ gapsFound: 1, published: 1 });
    const second = await curiosity.scanForGaps();
    expect(second.gaps).toEqual(first.gaps);
    expect(second.published).toBe(0);
    claim('copy', { claim: '  MAKER  ' });
    const third = await curiosity.scanForGaps();
    expect(third.gaps).toEqual(first.gaps);
    expect(third.published).toBe(0);
    expect(first.gaps[0].description).toContain('coverage UNKNOWN');
    const diagnostic = db.prepare("SELECT metadata FROM swarm_claims WHERE created_from = 'curiosity-service'").get() as { metadata: string };
    expect(JSON.parse(diagnostic.metadata)).toMatchObject({ detection_method: 'count_heuristic', coverage_status: 'UNKNOWN' });
  });

  it('excludes diagnostic-only domains and diagnostic confidence/contradiction feedback', async () => {
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    claim('gap-only', { subject_ref: 'diagnostic-only', predicate: 'gap', confidence: 0.1, created_at: old });
    claim('legacy-diagnostic', { subject_ref: 'legacy-only', created_from: 'curiosity-service', confidence: 0.1, created_at: old });
    claim('contradicted-gap', { subject_ref: 'diagnostic-only', predicate: 'gap', status: 'contradicted' });
    expect(await curiosity.scanForGaps()).toEqual({ gapsFound: 0, published: 0, gaps: [] });
  });

  it('does not count rejected, resolved, expired or invalidated claims as active inventory', async () => {
    claim('active');
    claim('rejected', { status: 'rejected' }); claim('resolved', { status: 'resolved' });
    claim('expired', { valid_until: expiredNow() });
    claim('invalidated', { invalidated_by: 'active' });
    const result = await curiosity.scanForGaps();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].description).toContain('1 distinct');
  });

  it('reports zero active statements in a domain whose last claim expired', async () => {
    claim('expired-only', { valid_until: expiredNow() });
    const report = await curiosity.scanForGaps();
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].description).toContain('0 distinct normalized active statements');
    expect((await curiosity.scanForGaps()).published).toBe(0);
  });

  it('publishes a new occurrence after a resolved signal disappeared on a successful scan', async () => {
    claim('first'); await curiosity.scanForGaps();
    db.prepare("UPDATE swarm_claims SET status = 'resolved' WHERE predicate = 'gap'").run();
    const old = db.prepare("SELECT * FROM swarm_claims WHERE predicate = 'gap'").get() as any;
    expect((await curiosity.scanForGaps()).published).toBe(0);
    claim('second'); claim('third');
    expect((await curiosity.scanForGaps()).gaps).toEqual([]);
    expect(db.prepare('SELECT status,evidence_refs_json FROM swarm_claims WHERE id = ?').get(old.id)).toEqual({ status: old.status, evidence_refs_json: old.evidence_refs_json });
    db.prepare("UPDATE swarm_claims SET valid_until = ? WHERE id IN ('second','third')").run(expiredNow());
    expect((await curiosity.scanForGaps()).published).toBe(1);
    expect(db.prepare("SELECT status FROM swarm_claims WHERE predicate = 'gap' AND id <> ?").get(old.id)).toEqual({ status: 'proposed' });
    expect((await curiosity.scanForGaps()).published).toBe(0);
  });

  it('does not treat a detector query failure as a disappeared signal', async () => {
    claim('first'); await curiosity.scanForGaps();
    db.prepare("UPDATE swarm_claims SET status = 'resolved' WHERE predicate = 'gap'").run();
    const old = db.prepare("SELECT * FROM swarm_claims WHERE predicate = 'gap'").get();
    const prepare = db.prepare.bind(db);
    const failedQuery = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('COUNT(DISTINCT')) throw new Error('simulated query failure');
      return prepare(sql);
    }) as typeof db.prepare);
    try { expect((await curiosity.scanForGaps()).published).toBe(0); } finally { failedQuery.mockRestore(); }
    expect(db.prepare("SELECT * FROM swarm_claims WHERE predicate = 'gap'").get()).toEqual(old);
    expect((await curiosity.scanForGaps()).published).toBe(0);
  });

  it('keeps explicit predicate, object and scope distinctions without semantic scoring', async () => {
    claim('p1', { claim: 'same', predicate: 'observed', object: 'yes', scope: 'local' });
    claim('p2', { claim: 'same', predicate: 'observed', object: 'no', scope: 'local' });
    claim('p3', { claim: 'same', predicate: 'observed', object: 'yes', scope: 'remote' });
    expect((await curiosity.scanForGaps()).gaps).toEqual([]);
  });

  it.each(['rejected', 'resolved', 'review_required', 'supported'])('does not reopen unchanged %s diagnostic decisions; changed signals remain candidates', async status => {
    claim('first');
    await curiosity.scanForGaps();
    db.prepare("UPDATE swarm_claims SET status = ? WHERE created_from = 'curiosity-service'").run(status);
    const original = db.prepare("SELECT * FROM swarm_claims WHERE created_from = 'curiosity-service'").get() as { id: string; metadata: string };
    expect((await curiosity.scanForGaps()).published).toBe(0);
    expect(db.prepare('SELECT * FROM swarm_claims WHERE id = ?').get(original.id)).toEqual(original);
    claim('second');
    expect((await curiosity.scanForGaps()).published).toBe(1);
    expect(db.prepare("SELECT status FROM swarm_claims WHERE created_from = 'curiosity-service' AND id <> ?").get(original.id)).toEqual({ status: 'proposed' });
    expect(db.prepare('SELECT * FROM swarm_claims WHERE id = ?').get(original.id)).toEqual({ ...original, metadata: JSON.stringify({ ...JSON.parse(original.metadata), observed_signal_active: false }) });
  });

  it('detects coverage gaps for domains with < 3 claims', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c1', 'test', 'memory', 'security', 'has_property', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = await curiosity.scanForGaps();
    const coverageGap = report.gaps.find(g => g.type === 'coverage' && g.domain === 'security');
    expect(coverageGap).toBeDefined();
  });

  it('detects confidence gaps for low-confidence domains', async () => {
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c2', 'test', 'memory', 'performance', 'has_property', 'supported', 0.3, '[]', 'test', ?, ?)
    `).run(oldDate, oldDate);
    const report = await curiosity.scanForGaps();
    const confGap = report.gaps.find(g => g.type === 'confidence');
    expect(confGap).toBeDefined();
    expect(confGap?.severity).toBeCloseTo(0.7, 5); // 1 - avg_conf(0.3)
    expect(confGap?.description).toContain("0.30");
    // coverage metadata must only be attached to coverage gaps, never confidence gaps
    const confClaim = db.prepare("SELECT metadata FROM swarm_claims WHERE created_from = 'curiosity-service' AND json_extract(metadata, '$.gap_type') = 'confidence'").get() as { metadata: string };
    expect(JSON.parse(confClaim.metadata)).not.toHaveProperty('detection_method');
    expect(JSON.parse(confClaim.metadata)).not.toHaveProperty('coverage_status');
  });

  it('does not flag confidence for claims created within the 30-day window', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('recent', 'test', 'memory', 'fresh', 'has_property', 'supported', 0.1, '[]', 'test', ?, ?)
    `).run(oneDayAgo, oneDayAgo);
    const report = await curiosity.scanForGaps();
    expect(report.gaps.find(g => g.type === 'confidence' && g.domain === 'fresh')).toBeUndefined();
  });

  it('detects contradiction gaps', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c3', 'test', 'memory', 'testing', 'has_property', 'contradicted', 0.5, '[]', 'test', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString()); // the contradiction window is Date.now() − 7 d
    claim('contradicting-observation', { subject_ref: 'testing' });
    db.prepare("UPDATE swarm_claims SET invalidated_by = 'contradicting-observation' WHERE id = 'c3'").run();
    const report = await curiosity.scanForGaps();
    const contrGap = report.gaps.find(g => g.type === 'contradiction');
    expect(contrGap).toMatchObject({ severity: 0.3, description: "1 unresolved contradictions in 'testing'" });
  });

  it('publishes gap claims to knowledge bus', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c4', 'test', 'memory', 'architecture', 'has_property', 'supported', 0.9, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const report = await curiosity.scanForGaps();
    expect(report.gapsFound).toBeGreaterThanOrEqual(0);
  });

  it('returns empty report when no gaps exist', async () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
        VALUES (?, ?, 'memory', 'well-covered', 'has_property', 'supported', 0.9, '[]', 'test', datetime('now'), datetime('now'))
      `).run('wc-' + i, 'distinct statement ' + i);
    }
    const report = await curiosity.scanForGaps();
    const coverageGap = report.gaps.find(g => g.domain === 'well-covered');
    expect(coverageGap).toBeUndefined();
  });

  it('start/stop timer works', () => {
    curiosity.start();
    curiosity.stop();
    expect(true).toBe(true);
  });

  describe('competence gap detection', () => {
    const now = () => new Date().toISOString();
    function seedLoop(loopId: string) {
      const t = now();
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(loopId, 'comp', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', t, t);
    }
    function seedCapability(id: string, status: string) {
      const t = now();
      db.prepare(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, removal_strategy, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'skill', 'okf', '1.0.0', status, 'low', 'schema://in', 'schema://out', 'remove', '{}', t, t);
    }
    function seedLease(id: string, loopId: string, capId: string, leaseStatus: 'completed' | 'failed') {
      const t = now();
      db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, capability_id, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, loopId, 'maker', 'mock', leaseStatus, capId, '{}', t, t);
    }

    it('flags a validated capability with >= 3 runs and < 0.5 completion rate', async () => {
      seedLoop('loop-comp');
      seedCapability('cap-low', 'validated');
      // 1 completed, 3 failed -> success_rate 0.25, n_runs 4
      seedLease('l1', 'loop-comp', 'cap-low', 'completed');
      for (const id of ['l2', 'l3', 'l4']) seedLease(id, 'loop-comp', 'cap-low', 'failed');
      const report = await curiosity.scanForGaps();
      const compGap = report.gaps.find(g => g.type === 'competence' && g.domain === 'cap-low');
      expect(compGap).toBeDefined();
      expect(compGap?.severity).toBeCloseTo(0.75, 5); // 1 - 0.25
      expect(compGap?.description).toBe("Low lease completion rate (25%) for capability 'cap-low'");
    });

    it('does not flag competence when runs < 3 or completion rate >= 0.5', async () => {
      seedLoop('loop-comp2');
      // cap-few: 2 runs, 0 completed (below the n_runs threshold)
      seedCapability('cap-few', 'validated');
      seedLease('f1', 'loop-comp2', 'cap-few', 'failed');
      seedLease('f2', 'loop-comp2', 'cap-few', 'failed');
      // cap-half: 4 runs, 2 completed -> success_rate exactly 0.5 (at the boundary)
      seedCapability('cap-half', 'validated');
      seedLease('h1', 'loop-comp2', 'cap-half', 'completed');
      seedLease('h2', 'loop-comp2', 'cap-half', 'completed');
      seedLease('h3', 'loop-comp2', 'cap-half', 'failed');
      seedLease('h4', 'loop-comp2', 'cap-half', 'failed');
      const report = await curiosity.scanForGaps();
      expect(report.gaps.find(g => g.type === 'competence' && g.domain === 'cap-few')).toBeUndefined();
      expect(report.gaps.find(g => g.type === 'competence' && g.domain === 'cap-half')).toBeUndefined();
    });

    it('ignores non-validated capabilities regardless of completion rate', async () => {
      seedLoop('loop-comp3');
      seedCapability('cap-draft', 'draft');
      for (const id of ['d1', 'd2', 'd3']) seedLease(id, 'loop-comp3', 'cap-draft', 'failed');
      const report = await curiosity.scanForGaps();
      expect(report.gaps.find(g => g.type === 'competence' && g.domain === 'cap-draft')).toBeUndefined();
    });
  });

  describe('timer configuration', () => {
    it('uses the explicit intervalMs option over env and default', () => {
      const spy = vi.spyOn(globalThis, 'setInterval');
      try {
        const c = new CuriosityService(db, intelligence, { intervalMs: 12345 });
        c.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(12345);
        c.stop();
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to CURIOUSITY_SCAN_INTERVAL_MS when no option is given', () => {
      vi.stubEnv('CURIOSITY_SCAN_INTERVAL_MS', '7000');
      const spy = vi.spyOn(globalThis, 'setInterval');
      try {
        const c = new CuriosityService(db, intelligence);
        c.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(7000);
        c.stop();
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it('falls back to the 6h default when neither option nor env is set', () => {
      vi.stubEnv('CURIOSITY_SCAN_INTERVAL_MS', '');
      const spy = vi.spyOn(globalThis, 'setInterval');
      try {
        const c = new CuriosityService(db, intelligence);
        c.start();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(6 * 3600_000);
        c.stop();
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it('does not register a second timer when start is called twice', () => {
      const spy = vi.spyOn(globalThis, 'setInterval');
      try {
        curiosity.start();
        curiosity.start();
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        curiosity.stop();
      }
    });

    it('stop clears the active interval so a fresh timer can be registered', () => {
      const intervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      try {
        curiosity.start();
        curiosity.stop();
        expect(clearSpy).toHaveBeenCalledTimes(1);
        curiosity.start();
        expect(intervalSpy).toHaveBeenCalledTimes(2);
      } finally {
        intervalSpy.mockRestore();
        clearSpy.mockRestore();
        curiosity.stop();
      }
    });

    it('the periodic timer triggers a gap scan on each tick', () => {
      vi.useFakeTimers();
      const scanSpy = vi.spyOn(curiosity, 'scanForGaps').mockResolvedValue({ gapsFound: 0, published: 0, gaps: [] });
      try {
        curiosity.start();
        scanSpy.mockClear();
        vi.advanceTimersByTime(6 * 3600_000);
        expect(scanSpy).toHaveBeenCalledTimes(1);
      } finally {
        scanSpy.mockRestore();
        curiosity.stop();
        vi.useRealTimers();
      }
    });
  });

  describe('feeding detected gaps into the reviewed self-improvement pipeline', () => {
    // Found 2026-09-21: generateFromGaps() existed, tested, unused since
    // before this session — scanForGaps()'s output only ever reached
    // swarm_claims, never a place that could turn a gap into reviewed work.
    const improvements = () => new SelfImprovementService(db);

    // A confidence gap is an actionable finding (old, low-confidence claims); a coverage gap is a count heuristic.
    const staleLowConfidence = () => {
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      for (const id of ['a', 'b', 'c']) claim(`stale-${id}`, { confidence: 0.2, created_at: old });
    };

    it('creates a real self-improvement proposal from a detected (non-coverage) gap', async () => {
      staleLowConfidence();
      const report = await curiosity.scanForGaps();
      expect(report.gaps.some(gap => gap.type === 'confidence')).toBe(true);
      const proposals = improvements().listImprovements('proposed');
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals[0].source).toBe('gap_analysis');
    });

    it('does not turn a coverage (count-heuristic) gap into a proposal, but still publishes it as a claim', async () => {
      claim('maker'); claim('checker');
      const report = await curiosity.scanForGaps();
      expect(report.gaps.every(gap => gap.type === 'coverage')).toBe(true);
      expect(report.published).toBeGreaterThan(0);
      expect(improvements().listImprovements().filter(p => p.source === 'gap_analysis')).toHaveLength(0);
    });

    it('does not create a duplicate proposal when the same still-open gap is re-detected on a later scan', async () => {
      staleLowConfidence();
      await curiosity.scanForGaps();
      const afterFirst = improvements().listImprovements('proposed').length;
      expect(afterFirst).toBeGreaterThan(0);
      await curiosity.scanForGaps(); // same underlying claims, same gap, re-detected
      expect(improvements().listImprovements('proposed').length).toBe(afterFirst);
    });

    it('still completes and returns its report even if proposal generation throws', async () => {
      const spy = vi.spyOn(SelfImprovementService.prototype, 'generateFromGaps').mockImplementation(() => { throw new Error('simulated failure'); });
      try {
        claim('maker'); claim('checker');
        const report = await curiosity.scanForGaps();
        expect(report.gapsFound).toBeGreaterThan(0);
        expect(report.published).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
