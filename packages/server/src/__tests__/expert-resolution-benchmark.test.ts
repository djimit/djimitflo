import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { BENCHMARK_QUERIES, runBenchmark, type BenchmarkReport } from '../services/expert-resolution-benchmark';

describe('expert resolution benchmark (§43 §44 §45)', () => {
  let db: Database.Database;
  let report: BenchmarkReport;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    report = runBenchmark(db, { k: 3 });
  });

  afterEach(() => db.close());

  it('covers the twelve §43 families with at least 25 in-domain queries expecting capability families, not people', () => {
    const inDomain = BENCHMARK_QUERIES.filter((query) => query.kind !== 'out_of_domain');
    expect(inDomain.length).toBeGreaterThanOrEqual(25);
    expect(new Set(inDomain.map((query) => query.family)).size).toBeGreaterThanOrEqual(12);
    expect(inDomain.every((query) => query.expected.length > 0 && query.expected.every((capability) => /^[a-z_]+$/.test(capability)))).toBe(true);
  });

  it('passes every §44 hard gate on the frontier run', () => {
    expect(report.gates).toMatchObject({ unsupported_attribution_rate: 0, impersonation_violations: 0, signature_only_promotions: 0, critical_prompt_injection_escape: 0, self_approval_violations: 0, missing_provenance_for_active_expert: 0, passed: true });
    expect(report.frontier.false_expert_rate).toBe(0);
    expect(report.frontier.identity_resolution_error).toBe(0);
    expect(report.frontier.evidence_coverage).toBe(1);
  });

  it('beats the naive keyword+fame baseline on relevance, evidence and safety metrics without regressing abstention', () => {
    const { frontier, baseline } = report;
    expect(frontier.precision_at_k).toBeGreaterThan(baseline.precision_at_k);
    expect(frontier.recall_at_k).toBeGreaterThanOrEqual(baseline.recall_at_k);
    expect(frontier.ndcg_at_k).toBeGreaterThan(baseline.ndcg_at_k);
    expect(frontier.primary_evidence_ratio).toBeGreaterThan(baseline.primary_evidence_ratio);
    expect(frontier.unsupported_attribution_rate).toBe(0);
    expect(baseline.unsupported_attribution_rate).toBeGreaterThan(0);
    expect(baseline.false_expert_rate).toBeGreaterThan(0);
    expect(frontier.abstention_quality).toBe(1);
    expect(frontier.false_abstention_rate).toBe(0);
    expect(frontier.contradiction_detection).toBe(1);
    expect(baseline.contradiction_detection).toBe(0);
  });
});
