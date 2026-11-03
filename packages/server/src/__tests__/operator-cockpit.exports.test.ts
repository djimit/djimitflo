import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worstState, recentDeploys } from '../services/operator-cockpit';
import type { HealthState } from '../services/operator-cockpit';

describe('worstState', () => {
  it('returns NOT_APPLICABLE for an empty list (the reduce seed)', () => {
    expect(worstState([])).toBe('NOT_APPLICABLE');
  });

  it('returns the single state when only one is given', () => {
    expect(worstState(['HEALTHY'])).toBe('HEALTHY');
    expect(worstState(['BREACHED'])).toBe('BREACHED');
  });

  it('picks BREACHED over every other state (most severe)', () => {
    const all: HealthState[] = ['BREACHED', 'UNKNOWN', 'STALE', 'DEGRADED', 'HEALTHY', 'NOT_APPLICABLE'];
    expect(worstState(all)).toBe('BREACHED');
    // order independence
    expect(worstState([...all].reverse())).toBe('BREACHED');
  });

  it('ranks UNKNOWN worse than STALE, DEGRADED, HEALTHY, NOT_APPLICABLE', () => {
    expect(worstState(['HEALTHY', 'UNKNOWN', 'STALE'])).toBe('UNKNOWN');
  });

  it('ranks STALE worse than DEGRADED, HEALTHY, NOT_APPLICABLE', () => {
    expect(worstState(['HEALTHY', 'DEGRADED', 'STALE'])).toBe('STALE');
  });

  it('ranks DEGRADED worse than HEALTHY and NOT_APPLICABLE', () => {
    expect(worstState(['HEALTHY', 'NOT_APPLICABLE', 'DEGRADED'])).toBe('DEGRADED');
  });

  it('ranks HEALTHY worse than NOT_APPLICABLE', () => {
    expect(worstState(['NOT_APPLICABLE', 'HEALTHY'])).toBe('HEALTHY');
  });

  it('keeps the worst state when the worst appears multiple times', () => {
    expect(worstState(['HEALTHY', 'BREACHED', 'HEALTHY', 'BREACHED'])).toBe('BREACHED');
  });
});

describe('recentDeploys', () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-deploys-'));
    logFile = path.join(dir, 'deploy-log.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the log file is missing', () => {
    expect(recentDeploys(path.join(dir, 'no-such.jsonl'))).toEqual([]);
  });

  it('parses valid JSONL deploy entries newest first', () => {
    const entries = [
      { at: '2026-10-13T00:00:00.000Z', event: 'deploy', sha: 'aaa', detail: 'first' },
      { at: '2026-10-13T01:00:00.000Z', event: 'deploy', sha: 'bbb', detail: 'second' },
      { at: '2026-10-13T02:00:00.000Z', event: 'rollback', sha: 'bbb', detail: 'rolled back' },
    ];
    fs.writeFileSync(logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const got = recentDeploys(logFile);
    expect(got).toHaveLength(3);
    // newest first (slice(-limit).reverse())
    expect(got[0].sha).toBe('bbb');
    expect(got[1].sha).toBe('bbb');
    expect(got[2].sha).toBe('aaa');
    expect(got.map((d) => d.event)).toEqual(['rollback', 'deploy', 'deploy']);
  });

  it('skips lines that are not valid JSON or lack an event field', () => {
    fs.writeFileSync(
      logFile,
      [
        JSON.stringify({ at: '2026-10-13T00:00:00.000Z', event: 'deploy', sha: 'a', detail: '' }),
        'not json',
        JSON.stringify({ at: '2026-10-13T00:00:00.000Z', sha: 'no-event' }),
        JSON.stringify({ at: '2026-10-13T01:00:00.000Z', event: 'deploy', sha: 'b', detail: '' }),
      ].join('\n') + '\n',
    );

    const got = recentDeploys(logFile);
    expect(got).toHaveLength(2);
    expect(got.map((d) => d.sha)).toEqual(['b', 'a']);
  });

  it('honors the limit argument (last N entries, reversed)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ at: `2026-10-13T0${i}:00:00.000Z`, event: 'deploy', sha: `s${i}`, detail: '' }));
    }
    fs.writeFileSync(logFile, lines.join('\n') + '\n');

    const got = recentDeploys(logFile, 2);
    expect(got).toHaveLength(2);
    // last 2 entries (s3, s4) reversed => s4, s3
    expect(got.map((d) => d.sha)).toEqual(['s4', 's3']);
  });

  it('returns an empty array for an empty file', () => {
    fs.writeFileSync(logFile, '');
    expect(recentDeploys(logFile)).toEqual([]);
  });
});