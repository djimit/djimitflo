import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createHealthRoutes } from '../routes/health';
import { fleetDrift } from '../utils/fleet-drift';

// S3: /health.fleet_drift lists the fleet services whose deployed sources differ from main at the running commit, read
// from the fleet-drift.json scripts/auto-deploy.sh writes into the data mount. Anything but a fresh checked record for the
// running commit is unknown: null, never [].
const keys = ['FLEET_DRIFT_PATH', 'DJIMITFLO_COMMIT_SHA'] as const;
const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

const RUNNING = 'c'.repeat(40);
const NOW = Date.parse('2026-10-29T20:10:00Z');
const env = { DJIMITFLO_COMMIT_SHA: RUNNING } as NodeJS.ProcessEnv;
const fixture = (content: string | object) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drift-')), 'fleet-drift.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};
const services = {
  'event-bus': { deployed: 'a'.repeat(64), main: 'b'.repeat(64), match: false },
  'agent-registry': { deployed: 'd'.repeat(64), main: 'd'.repeat(64), match: true },
};
const record = (over: object = {}) => ({ checked_at: '2026-10-29T20:00:00Z', commit: RUNNING, status: 'checked', services, ...over });

describe('fleet drift', () => {
  it('lists the drifting services of a fresh checked record for the running commit', () => {
    expect(fleetDrift(fixture(record()), env, NOW)).toEqual(['event-bus']);
    expect(fleetDrift(fixture(record({ services: { 'event-bus': { match: true } } })), env, NOW)).toEqual([]);
  });

  it('an absent, unreadable or unchecked record is unknown (null), never "no drift"', () => {
    expect(fleetDrift(path.join(os.tmpdir(), 'no-such-dir', 'fleet-drift.json'), env, NOW)).toBeNull();
    expect(fleetDrift(fixture('{not json'), env, NOW)).toBeNull();
    expect(fleetDrift(fixture({}), env, NOW)).toBeNull();
    expect(fleetDrift(fixture({ checked_at: '2026-10-29T20:05:00Z', commit: RUNNING, status: 'unknown', reason: 'commit not readable' }), env, NOW)).toBeNull();
    // a record without a status (or with services but status unknown) is not a check
    const { status: _s, ...legacy } = record();
    expect(fleetDrift(fixture(legacy), env, NOW)).toBeNull();
    expect(fleetDrift(fixture(record({ status: 'unknown' })), env, NOW)).toBeNull();
  });

  it('a record for another commit, or older than twice the auto-deploy interval, is unknown', () => {
    expect(fleetDrift(fixture(record({ commit: 'e'.repeat(40) })), env, NOW)).toBeNull();
    expect(fleetDrift(fixture(record()), {} as NodeJS.ProcessEnv, NOW)).toBeNull(); // running commit unknown
    expect(fleetDrift(fixture(record({ checked_at: '2026-10-29T19:49:00Z' })), env, NOW)).toBeNull(); // 21 min old
    expect(fleetDrift(fixture(record({ checked_at: '2026-10-29T19:51:00Z' })), env, NOW)).toEqual(['event-bus']); // 19 min
  });

  it('public /api/health reports fleet_drift from FLEET_DRIFT_PATH', async () => {
    const db = createTestDb();
    const server = express().use('/api/health', createHealthRoutes(db)).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
    try {
      process.env.DJIMITFLO_COMMIT_SHA = RUNNING;
      process.env.FLEET_DRIFT_PATH = fixture(record({ checked_at: new Date().toISOString() }));
      expect(((await (await fetch(url)).json()) as { fleet_drift: unknown }).fleet_drift).toEqual(['event-bus']);
      process.env.FLEET_DRIFT_PATH = path.join(os.tmpdir(), 'no-such-dir', 'fleet-drift.json');
      const absent = (await (await fetch(url)).json()) as Record<string, unknown>;
      expect(absent).toHaveProperty('fleet_drift', null);
    } finally {
      server.close(); db.close();
    }
  });
});
