import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlRedTeamBridge } from '../services/segml-red-team-bridge';

describe('SegmlRedTeamBridge', () => {
  let db: Database.Database;
  let bridge: SegmlRedTeamBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlRedTeamBridge(db);
  });

  it('converts missed red team findings to seed cases', () => {
    const findings = [
      { vectorId: 'v1', category: 'injection', payload: 'test', expectedDefense: 'block', blocked: false, severity: 'critical' as const, recommendation: 'fix' },
      { vectorId: 'v2', category: 'scope_escape', payload: 'test2', expectedDefense: 'block', blocked: true, severity: 'high' as const, recommendation: 'ok' },
    ];
    const generated = bridge.convertRedTeamFindings(findings);
    expect(generated.length).toBe(1); // Only missed attacks
    expect(generated[0].category).toBe('injection');
    expect(generated[0].generation_method).toBe('adversarial');
  });

  it('gets unconverted seeds', () => {
    const findings = [
      { vectorId: 'v1', category: 'injection', payload: 'test', expectedDefense: 'block', blocked: false, severity: 'critical' as const, recommendation: 'fix' },
    ];
    bridge.convertRedTeamFindings(findings);
    const seeds = bridge.getUnconvertedSeeds(10);
    expect(seeds.length).toBe(1);
  });

  it('marks seeds as converted', () => {
    const findings = [
      { vectorId: 'v1', category: 'injection', payload: 'test', expectedDefense: 'block', blocked: false, severity: 'critical' as const, recommendation: 'fix' },
    ];
    bridge.convertRedTeamFindings(findings);
    const seeds = bridge.getUnconvertedSeeds(10);
    bridge.markConverted([seeds[0].id]);
    const remaining = bridge.getUnconvertedSeeds(10);
    expect(remaining.length).toBe(0);
  });

  it('gets pending campaigns', () => {
    const campaigns = bridge.getPendingCampaigns(10);
    expect(campaigns.length).toBe(0);
  });
});
