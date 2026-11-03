import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export const APPROVALS_CHANGED = 'djimitflo:approvals-changed';

export interface PendingApprovals { count: number; soonestExpiresAt: string | null }

/**
 * Open approvals for the whole app shell (menu badge, banner, tab title). A worker-execution approval expires
 * after an hour and, with nothing announcing it, the first one lapsed unseen (2026-09-21). Polls every 30 s and
 * refreshes at once when a card decides something.
 */
export function usePendingApprovals(intervalMs = 30_000): PendingApprovals {
  const [state, setState] = useState<PendingApprovals>({ count: 0, soonestExpiresAt: null });
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api.getAllApprovals('pending');
        if (!active) return;
        const now = Date.now();
        const open = result.approvals.filter((approval) => !approval.expires_at || Date.parse(approval.expires_at) > now);
        const soonest = open.map((approval) => approval.expires_at).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
        setState({ count: open.length, soonestExpiresAt: soonest });
      } catch { /* the shell must render without approvals (logged out, offline) */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    window.addEventListener(APPROVALS_CHANGED, load);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(APPROVALS_CHANGED, load); };
  }, [intervalMs]);
  return state;
}

export function minutesUntil(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
}
