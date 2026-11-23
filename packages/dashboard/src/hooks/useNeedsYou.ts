import { useEffect, useState } from 'react';
import { api, type NeedsYouView } from '../lib/api';

/**
 * The cockpit's needs-you (GET /api/health/needs-you) for the app shell and /decisions: one number everywhere. null until
 * loaded or when it cannot be read (logged out, no read:evidence) — callers fall back to pending approvals.
 */
// = APPROVALS_CHANGED in usePendingApprovals (a literal: tests mock that module without its constants)
const APPROVALS_CHANGED = 'djimitflo:approvals-changed';

export function useNeedsYou(intervalMs = 60_000): NeedsYouView | null {
  const [view, setView] = useState<NeedsYouView | null>(null);
  useEffect(() => {
    let active = true;
    // the shell must render without it (logged out, offline, a partial api) — any failure keeps the fallback
    const load = () => { Promise.resolve().then(() => api.getNeedsYou()).then((v) => { if (active) setView(v); }, () => undefined); };
    load();
    const timer = window.setInterval(load, intervalMs);
    window.addEventListener(APPROVALS_CHANGED, load);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(APPROVALS_CHANGED, load); };
  }, [intervalMs]);
  return view;
}
