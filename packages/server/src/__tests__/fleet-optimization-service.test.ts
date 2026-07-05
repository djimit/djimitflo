import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FleetOptimizationService } from '../services/fleet-optimization-service';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let fleet: FleetOptimizationService;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  fleet = new FleetOptimizationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G80: Fleet Optimization', () => {
  it('analyzes fleet', () => {
    const report = fleet.analyzeFleet();
    expect(report.totalAgents).toBeGreaterThan(0);
    expect(report.activeAgents).toBeGreaterThanOrEqual(0);
    expect(report.capabilityCoverage).toBeDefined();
  });

  it('identifies capability gaps', () => {
    const report = fleet.analyzeFleet();
    expect(report.gaps.length).toBeGreaterThan(0);
  });

  it('generates recommendations', () => {
    const report = fleet.analyzeFleet();
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('persists report', () => {
    fleet.analyzeFleet();
    const latest = fleet.getLatestReport();
    expect(latest).not.toBeNull();
    expect(latest!.totalAgents).toBeGreaterThan(0);
  });

  it('gets report history', () => {
    fleet.analyzeFleet();
    fleet.analyzeFleet();
    const history = fleet.getReportHistory(10);
    expect(history.length).toBe(2);
  });

  it('computes capability coverage', () => {
    const report = fleet.analyzeFleet();
    const totalCaps = Object.values(report.capabilityCoverage).reduce((s, v) => s + v, 0);
    expect(totalCaps).toBeGreaterThan(0);
  });
});
