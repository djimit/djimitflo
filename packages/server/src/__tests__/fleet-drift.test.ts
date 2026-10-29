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
// from the fleet-drift.json scripts/auto-deploy.sh writes into the data mount. No (readable) file is unknown: null, not [].
const original = process.env.FLEET_DRIFT_PATH;
afterEach(() => { if (original === undefined) delete process.env.FLEET_DRIFT_PATH; else process.env.FLEET_DRIFT_PATH = original; });

const fixture = (content: string) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drift-')), 'fleet-drift.json');
  fs.writeFileSync(file, content);
  return file;
};
const drifted = JSON.stringify({ checked_at: '2026-10-29T20:00:00Z', commit: 'c'.repeat(40), services: {
  'event-bus': { deployed: 'a'.repeat(64), main: 'b'.repeat(64), match: false },
  'agent-registry': { deployed: 'd'.repeat(64), main: 'd'.repeat(64), match: true },
} });

describe('fleet drift', () => {
  it('lists the drifting services; an absent or unreadable file is null (unknown is not ok)', () => {
    expect(fleetDrift(fixture(drifted))).toEqual(['event-bus']);
    expect(fleetDrift(fixture(JSON.stringify({ services: { 'event-bus': { match: true } } })))).toEqual([]);
    expect(fleetDrift(path.join(os.tmpdir(), 'no-such-dir', 'fleet-drift.json'))).toBeNull();
    expect(fleetDrift(fixture('{not json'))).toBeNull();
    expect(fleetDrift(fixture('{}'))).toBeNull();
  });

  it('public /api/health reports fleet_drift from FLEET_DRIFT_PATH', async () => {
    const db = createTestDb();
    const server = express().use('/api/health', createHealthRoutes(db)).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
    try {
      process.env.FLEET_DRIFT_PATH = fixture(drifted);
      expect(((await (await fetch(url)).json()) as { fleet_drift: unknown }).fleet_drift).toEqual(['event-bus']);
      process.env.FLEET_DRIFT_PATH = path.join(os.tmpdir(), 'no-such-dir', 'fleet-drift.json');
      const absent = (await (await fetch(url)).json()) as Record<string, unknown>;
      expect(absent).toHaveProperty('fleet_drift', null);
    } finally {
      server.close(); db.close();
    }
  });
});
