import fs from 'fs';

/**
 * S3 (fleet ≠ main): the fleet services whose deployed sources differ from main at the running commit, from the
 * fleet-drift.json that scripts/auto-deploy.sh (host, root) writes into the data mount. Read-only.
 * null = no readable file: the fleet was not checked, which is unknown — never reported as "no drift".
 */
export function fleetDrift(file = process.env.FLEET_DRIFT_PATH || '/data/fleet-drift.json'): string[] | null {
  try {
    const services = (JSON.parse(fs.readFileSync(file, 'utf8')) as { services?: unknown }).services;
    if (!services || typeof services !== 'object' || Array.isArray(services)) return null;
    return Object.entries(services as Record<string, { match?: unknown }>)
      .filter(([, service]) => service?.match !== true).map(([name]) => name).sort();
  } catch {
    return null;
  }
}
