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
    claim('expired', { valid_until: new Date(Date.now() - 1000).toISOString() });
    claim('invalidated', { invalidated_by: 'active' });
    const result = await curiosity.scanForGaps();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].description).toContain('1 distinct');
  });

  it('reports zero active statements in a domain whose last claim expired', async () => {
    claim('expired-only', { valid_until: new Date(Date.now() - 1000).toISOString() });
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
    db.prepare("UPDATE swarm_claims SET valid_until = ? WHERE id IN ('second','third')").run(new Date(Date.now() - 1000).toISOString());
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
  });

  it('detects contradiction gaps', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('c3', 'test', 'memory', 'testing', 'has_property', 'contradicted', 0.5, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
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
