import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let svc: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  svc = new SwarmIntelligenceService(db);
});

afterEach(() => { db?.close(); });

describe('G15.5 permission-scoped graph traversal', () => {
  it('filters forward traversal to permitted refs only', () => {
    svc.createEvidenceEdge('mission:1', 'goal:1', 'decomposes_to');
    svc.createEvidenceEdge('mission:1', 'restricted:classified', 'references');

    const permitted = new Set(['goal:1', 'mission:1']);
    const scoped = svc.lineageForwardScoped('mission:1', permitted);
    expect(scoped.edges.map((e) => e.to)).toContain('goal:1');
    expect(scoped.edges.map((e) => e.to)).not.toContain('restricted:classified');
  });

  it('allows all refs when wildcard is in permitted set', () => {
    svc.createEvidenceEdge('mission:1', 'goal:1', 'decomposes_to');
    svc.createEvidenceEdge('mission:1', 'restricted:classified', 'references');

    const permitted = new Set(['*']);
    const scoped = svc.lineageForwardScoped('mission:1', permitted);
    expect(scoped.edges.length).toBe(2);
  });

  it('filters reverse traversal to permitted refs only', () => {
    svc.createEvidenceEdge('panel:1', 'mission:1', 'informs');
    svc.createEvidenceEdge('restricted:classified', 'mission:1', 'references');

    const permitted = new Set(['panel:1', 'mission:1']);
    const scoped = svc.lineageReverseScoped('mission:1', permitted);
    expect(scoped.edges.map((e) => e.from)).toContain('panel:1');
    expect(scoped.edges.map((e) => e.from)).not.toContain('restricted:classified');
  });
});

describe('G15.7 process-aware stop/kill adapters', () => {
  it('reports stop/kill support for codex', () => {
    const info = svc.getProcessAdapterInfo('codex');
    expect(info.supports_stop).toBe(true);
    expect(info.supports_kill).toBe(true);
    expect(info.stop_signal).toBe('SIGTERM');
    expect(info.kill_signal).toBe('SIGKILL');
  });

  it('reports stop/kill support for opencode', () => {
    const info = svc.getProcessAdapterInfo('opencode');
    expect(info.supports_stop).toBe(true);
    expect(info.supports_kill).toBe(true);
  });

  it('reports no stop/kill for mock runtime', () => {
    const info = svc.getProcessAdapterInfo('mock');
    expect(info.supports_stop).toBe(false);
    expect(info.supports_kill).toBe(false);
  });

  it('reports no stop/kill for unknown runtime', () => {
    const info = svc.getProcessAdapterInfo('unknown_runtime');
    expect(info.supports_stop).toBe(false);
    expect(info.supports_kill).toBe(false);
  });
});
