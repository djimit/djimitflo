import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { FrontierExpertScheduler } from '../services/frontier-expert-scheduler';
import type { PacingIngestResult } from '../services/pacing-frontier-ingestion-service';
import type { EnrichmentResult } from '../services/expert-evidence-enrichment-service';

const EMPTY_INGEST: PacingIngestResult = {
  fetched: false, skipped_reason: 'rate_limited', content_hash: 'h', parsed: 0, quotes: 0,
  discovered_new: 0, already_known: 0, evidence_added: 0, affiliations_added: 0, anonymous_skipped: 0, snapshot_id: null,
};

describe('FrontierExpertScheduler', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
    for (const key of ['DJIMITFLO_FRONTIER_EXPERTS_ENABLED', 'FRONTIER_EXPERTS_SCHEDULER_ENABLED', 'FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES', 'FRONTIER_EXPERTS_RUNTIME']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    db?.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function fakeIngestion(fetched = false) {
    let calls = 0;
    return { calls: () => calls, ingest: async () => { calls += 1; return { ...EMPTY_INGEST, fetched }; } };
  }

  function fakeEnrichment(results: EnrichmentResult[] = []) {
    let calls = 0;
    return { calls: () => calls, enrichBatch: async () => { calls += 1; return results; } };
  }

  function fakeReviewer() {
    const calls: Array<{ expertId: string; reviewerId: string; actor: string }> = [];
    return { calls, reviewExpert: async (expertId: string, reviewerId: string, actor: string) => { calls.push({ expertId, reviewerId, actor }); return { audit_id: 'a' }; } };
  }

  function capabilityInferredExpert(name: string, capability: string) {
    const expert = registry.discover({ canonicalName: name, aliases: [], provenance: { source: 'pacingthefrontier.com', statement: 'signature', retrieved_at: '2026-09-13T00:00:00Z' }, actor: 'ingestion:pacing' });
    registry.resolveIdentity(expert.id, { confidence: 0.92, actor: 'resolver' });
    const paper = registry.addEvidence(expert.id, { kind: 'paper', title: `${name} paper`, sourceRef: `arxiv:${name}`, url: `https://arxiv.org/abs/${name}` });
    registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion' });
    registry.inferCapability(expert.id, { capability, confidence: 0.85, evidenceRefs: [paper], derivedBy: 'capability-deriver' });
    registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion' });
    return registry.get(expert.id)!;
  }

  it('does not arm when the base feature flag is off, even if the scheduler flag is on', () => {
    process.env.FRONTIER_EXPERTS_SCHEDULER_ENABLED = 'true';
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: fakeReviewer() });
    expect(scheduler.start()).toBe(false);
    scheduler.stop();
  });

  it('does not arm when the scheduler flag is off, even if the base feature flag is on', () => {
    process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED = 'true';
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: fakeReviewer() });
    expect(scheduler.start()).toBe(false);
    scheduler.stop();
  });

  it('arms when both flags are on', () => {
    process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED = 'true';
    process.env.FRONTIER_EXPERTS_SCHEDULER_ENABLED = 'true';
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: fakeReviewer() });
    expect(scheduler.start()).toBe(true);
    scheduler.stop();
  });

  it('calls ingest and enrichBatch on every tick', async () => {
    const ingestion = fakeIngestion(true);
    const enrichment = fakeEnrichment([{ expert_id: 'e1', canonical_name: 'E1', papers_found: 2 } as EnrichmentResult]);
    const scheduler = new FrontierExpertScheduler(db, { ingestion, enrichment, council: fakeReviewer() });
    const result = await scheduler.tick();
    expect(ingestion.calls()).toBe(1);
    expect(enrichment.calls()).toBe(1);
    expect(result.ingested).toBe(true);
    expect(result.enriched).toBe(1);
  });

  it('isolates a failing stage instead of aborting the whole tick', async () => {
    const failingIngestion = { ingest: async () => { throw new Error('network down'); } };
    const enrichment = fakeEnrichment();
    const reviewer = fakeReviewer();
    const scheduler = new FrontierExpertScheduler(db, { ingestion: failingIngestion, enrichment, council: reviewer });
    const result = await scheduler.tick();
    expect(result.failed).toEqual([{ stage: 'ingest', error: 'network down' }]);
    expect(enrichment.calls()).toBe(1);
  });

  it('peer-reviews CAPABILITY_INFERRED experts, pairing each with the peer sharing the most capabilities', async () => {
    capabilityInferredExpert('Ada', 'alignment');
    capabilityInferredExpert('Grace', 'alignment');
    const reviewer = fakeReviewer();
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: reviewer });
    const result = await scheduler.tick();
    expect(reviewer.calls).toHaveLength(2); // Ada reviewed by Grace, and Grace reviewed by Ada — mirrors scripts/review-experts.ts's own loop
    expect(result.reviewed.sort()).toEqual(reviewer.calls.map((call) => call.expertId).sort());
    expect(reviewer.calls.every((call) => call.actor === 'autopilot:frontier-experts')).toBe(true);
  });

  it('does not attempt peer review with fewer than two CAPABILITY_INFERRED experts', async () => {
    capabilityInferredExpert('Solo', 'alignment');
    const reviewer = fakeReviewer();
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: reviewer });
    await scheduler.tick();
    expect(reviewer.calls).toHaveLength(0);
  });

  it('skips a pair already reviewed at the current versions and runtime (DB-backed idempotency)', async () => {
    const ada = capabilityInferredExpert('Ada', 'alignment');
    const grace = capabilityInferredExpert('Grace', 'alignment');
    process.env.FRONTIER_EXPERTS_RUNTIME = 'test-runtime';
    db.prepare(`
      INSERT INTO audit_events (id, event_type, action, resource_type, resource_id, risk_level, metadata)
      VALUES (?, 'config_changed', 'frontier_expert_peer_review', 'expert', ?, 'medium', ?)
    `).run('audit-1', ada.id, JSON.stringify({ expert_id: ada.id, expert_version: ada.version, reviewer_id: grace.id, reviewer_version: grace.version, runtime: 'test-runtime' }));
    const reviewer = fakeReviewer();
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: reviewer });
    await scheduler.tick();
    // Ada->Grace already reviewed at this version+runtime, skipped; Grace->Ada is a distinct (reviewer_id, direction) pair, still runs.
    expect(reviewer.calls.some((call) => call.expertId === ada.id && call.reviewerId === grace.id)).toBe(false);
    expect(reviewer.calls.some((call) => call.expertId === grace.id && call.reviewerId === ada.id)).toBe(true);
  });

  it('never advances any expert past CAPABILITY_INFERRED — no transition() call anywhere in the tick', async () => {
    const ada = capabilityInferredExpert('Ada', 'alignment');
    capabilityInferredExpert('Grace', 'alignment');
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: fakeReviewer() });
    await scheduler.tick();
    expect(registry.get(ada.id)!.lifecycle_state).toBe('CAPABILITY_INFERRED');
  });

  it('E1: retries names without a match after 30 days, and says so when a tick is idle with a backlog', async () => {
    let seen: { retryBefore?: string } = {};
    const enrichment = { enrichBatch: async (input: { retryBefore?: string }) => { seen = input; return []; } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registry.discover({ canonicalName: 'Waiting Person', aliases: [], provenance: { source: 'pacingthefrontier.com' }, actor: 'ingestion:pacing' });
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(false), enrichment, council: fakeReviewer() });
    await scheduler.tick();
    const days = (Date.now() - Date.parse(seen.retryBefore!)) / 86_400_000;
    expect(days).toBeGreaterThan(29.9); expect(days).toBeLessThan(30.1);
    expect(warn.mock.calls.map((c) => String(c[0])).join()).toContain('frontier experts idle');
    expect(warn.mock.calls.map((c) => String(c[0])).join()).toContain('DISCOVERED=1');
    await scheduler.tick();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('idle'))).toHaveLength(1); // at most once a day
    warn.mockRestore();
  });

  it('falls back to a 60-minute interval for invalid configuration', () => {
    const scheduler = new FrontierExpertScheduler(db, { ingestion: fakeIngestion(), enrichment: fakeEnrichment(), council: fakeReviewer() });
    process.env.FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES = 'not-a-number';
    expect(scheduler.intervalMinutes()).toBe(60);
    process.env.FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES = '-5';
    expect(scheduler.intervalMinutes()).toBe(60);
  });
});
