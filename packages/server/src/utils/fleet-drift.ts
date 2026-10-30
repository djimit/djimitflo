import fs from 'fs';

/**
 * S3 (fleet ≠ main): the fleet services whose deployed sources differ from main at the running commit, from the
 * fleet-drift.json that scripts/auto-deploy.sh (host, root) writes into the data mount every run. Read-only.
 * null = unknown, never "no drift": no readable file, a record that is not a completed check (status unknown), a record for
 * another commit than the running one (or the running commit is not known), or one older than twice the auto-deploy interval.
 */
export function fleetDrift(
  file = process.env.FLEET_DRIFT_PATH || '/data/fleet-drift.json',
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string[] | null {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { status?: unknown; commit?: unknown; checked_at?: unknown; services?: unknown };
    if (record.status !== 'checked') return null;
    if (!env.DJIMITFLO_COMMIT_SHA || record.commit !== env.DJIMITFLO_COMMIT_SHA) return null;
    const checkedAt = typeof record.checked_at === 'string' ? Date.parse(record.checked_at) : NaN;
    const maxAgeMin = Number(env.FLEET_DRIFT_MAX_AGE_MIN) || 20; // the timer runs every 10 minutes
    if (!Number.isFinite(checkedAt) || now - checkedAt > maxAgeMin * 60_000) return null;
    const services = record.services;
    if (!services || typeof services !== 'object' || Array.isArray(services)) return null;
    return Object.entries(services as Record<string, { match?: unknown }>)
      .filter(([, service]) => service?.match !== true).map(([name]) => name).sort();
  } catch {
    return null;
  }
}
