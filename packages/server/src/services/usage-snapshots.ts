import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { redactSecrets } from './secret-patterns';
import type { AccountId, LimitView } from './usage-accounts';

/**
 * Operator usage snapshots (table account_usage_snapshots, append-only). claude_max and chatgpt_pro have no account-wide
 * source Djimitflo can read, so the operator copies the figures from the vendor's own usage page. Every field is optional:
 * what was not reported stays absent (unknown), never 0. Shown as operator-reported with its age; stale after 24 h.
 */
const pct = z.number().finite().min(0).max(100);
const iso = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);
const money = z.number().finite().min(0).max(1_000_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD');
const pctWindow = z.strictObject({ used_pct: pct.optional(), resets_at: iso.optional() });

export const SnapshotPayloadSchema = z.strictObject({
  plan: text(80).optional(),
  session: pctWindow.optional(),
  weekly: pctWindow.optional(),
  model_weekly: z.array(z.strictObject({ model: text(80), used_pct: pct.optional(), resets_at: iso.optional(), cap_note: text(200).optional() })).max(20).optional(),
  credits: z.array(z.strictObject({ label: text(80), remaining: money.optional(), total: money.optional(), currency: currency.optional(), expires_at: iso.optional() }))
    .max(20).optional(),
  spend_limit: z.strictObject({ spent: money.optional(), limit: money.optional(), currency: currency.optional(), period: z.enum(['daily', 'weekly', 'monthly']).optional(),
    auto_reload: z.boolean().optional() }).optional(),
  by_product: z.array(z.strictObject({ product: text(80), share_pct: pct })).max(20).optional(),
  note: z.string().max(500).optional(),
}).refine((p) => Object.keys(p).length > 0, 'at least one field is required');
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

/** Every string value (and object key) with its path, for the secret check; depth-capped, the schema is two levels deep. */
function strings(v: unknown, path: string, depth = 0): Array<[string, string]> {
  if (typeof v === 'string') return [[path || '(body)', v]];
  if (depth > 4) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`, depth + 1));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => [[`${path || '(body)'} key`, k] as [string, string], ...strings(x, path ? `${path}.${k}` : k, depth + 1)]);
  }
  return [];
}

/** Validates a snapshot body. A value that looks like a key or token is refused (named by field, never echoed). */
export function parseSnapshotPayload(raw: unknown): { ok: true; payload: SnapshotPayload } | { ok: false; error: string } {
  // before the schema: an unknown key's name is echoed in the schema error, so a key that looks like a secret is refused first
  const leaked = [...new Set(strings(raw, '').filter(([, s]) => redactSecrets(s).count > 0).map(([p]) => p))];
  if (leaked.length) return { ok: false, error: `${leaked.slice(0, 5).join(', ')}: looks like a secret (key or token); snapshots hold usage figures only` };
  const r = SnapshotPayloadSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') };
  }
  return { ok: true, payload: r.data };
}

export function recordSnapshot(db: Database, account: AccountId, reportedBy: string, payload: SnapshotPayload, reportedAt = new Date().toISOString()) {
  const id = randomUUID();
  db.prepare(`INSERT INTO account_usage_snapshots (id, account, reported_at, reported_by, source, payload_json) VALUES (?, ?, ?, ?, 'operator_snapshot', ?)`)
    .run(id, account, reportedAt, reportedBy, JSON.stringify(payload));
  return { id, account, reported_at: reportedAt, source: 'operator_snapshot' as const, payload };
}

export interface LatestSnapshot { reported_at: string; stale: boolean; age_hours: number; payload: SnapshotPayload }
export const SNAPSHOT_STALE_HOURS = 24;

/** The latest snapshot per account (fail-soft: no table or an unreadable row = no snapshot). */
export function latestSnapshots(db: Database, now: number): Map<string, LatestSnapshot> {
  const out = new Map<string, LatestSnapshot>();
  let rows: Array<{ account: string; reported_at: string; payload_json: string }> = [];
  try {
    rows = db.prepare(`SELECT account, reported_at, payload_json FROM (SELECT account, reported_at, payload_json,
        ROW_NUMBER() OVER (PARTITION BY account ORDER BY reported_at DESC, rowid DESC) AS rn FROM account_usage_snapshots) WHERE rn = 1`).all() as typeof rows;
  } catch { return out; }
  for (const r of rows) {
    const parsed = (() => { try { return SnapshotPayloadSchema.safeParse(JSON.parse(r.payload_json)); } catch { return null; } })();
    if (!parsed?.success) continue;
    const ageH = (now - Date.parse(r.reported_at)) / 3_600_000;
    out.set(r.account, { reported_at: r.reported_at, age_hours: Math.round(ageH * 10) / 10, stale: ageH > SNAPSHOT_STALE_HOURS, payload: parsed.data });
  }
  return out;
}

/** The snapshot's window for a plan-limit row (Claude / Codex publish a 5 h session and a weekly limit); null when it has reset since. */
function snapshotWindow(window: LimitView['window'], snap: Pick<LatestSnapshot, 'payload'>, now: number) {
  const w = window === '5h' || window === 'session' ? snap.payload.session : window === 'weekly' ? snap.payload.weekly : undefined;
  if (w?.used_pct === undefined) return null;
  if (w.resets_at && Date.parse(w.resets_at) <= now) return null; // the figure describes a window that is over
  return w as { used_pct: number; resets_at?: string };
}

/** Fills session / weekly from the snapshot where no API figure exists; an API-sourced figure always wins. */
export function withSnapshotPct(v: LimitView, snap: Pick<LatestSnapshot, 'reported_at' | 'stale' | 'payload'> | null | undefined, now: number): LimitView {
  if (!snap || v.pct_source || v.active === false) return v;
  const w = snapshotWindow(v.window, snap, now);
  if (!w) return v;
  return { ...v, comparable: true, used_pct: w.used_pct, pct_source: 'operator_snapshot', reported_at: snap.reported_at, resets_at: w.resets_at ?? null,
    unit_note: `percent of the account limit as reported by the operator from the vendor's usage page${snap.stale ? ' (stale: older than 24 h)' : ''}; the calls / tokens above are Djimitflo's share only` };
}

/** A snapshot window at >= 100 % that is fresh and has not reset; windows the account API reports are skipped (the API wins). */
export function snapshotLimitReached(snap: LatestSnapshot | undefined, now: number, apiWindows: { session?: unknown; weekly?: unknown } = {}) {
  if (!snap || snap.stale) return null;
  const full = (['session', 'weekly'] as const).filter((w) => !apiWindows[w] && (snapshotWindow(w, snap, now)?.used_pct ?? 0) >= 100);
  if (!full.length) return null;
  const resets = full.map((w) => snap.payload[w]?.resets_at).filter((r): r is string => Boolean(r)).sort();
  return { state: 'limit_reached' as const, since: snap.reported_at, until: resets.at(-1) ?? null,
    reason: `operator snapshot (reported ${snap.reported_at}): ${full.map((w) => `${w} ${snap.payload[w]!.used_pct} % used`).join(', ')}` };
}
