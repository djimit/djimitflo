import { api, type RuntimeHealthRow } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { LoadErrorNotice } from '../components/LoadErrorNotice';
import { fmt, since } from '../lib/format';

/**
 * UX-16: runtime health — admission + legacy expiry countdown, admitted vs observed version, last contract probe, 30-day
 * leases and the gym circuit breaker per runtime. Read-only; readiness mirrors reports/runtime-admission-readiness.md.
 * Rendered as a section on Fleet hosts (the top-level menu is capped at 20).
 */
const READINESS: Record<RuntimeHealthRow['readiness'], string> = {
  ok: 'ok', reassess: 'needs re-assessment', retire_unused: 'retire (unused)', keep_test_only: 'keep (test only)',
  hold: 'on hold', rejected: 'rejected', unknown_runtime: 'unknown runtime (no admission record)',
};
const fetchRuntimes = () => api.getRuntimeHealth();

export function RuntimeHealthSection() {
  const res = useResource(fetchRuntimes, { pollMs: 60_000 });
  const rows = res.data?.runtimes ?? [];
  return (
    <section aria-labelledby="runtime-health" className="space-y-2">
      <h2 id="runtime-health" className="text-lg font-semibold">Runtime health</h2>
      <p className="text-sm text-foreground-secondary">Admission, versions, probes and 30-day leases per runtime. Read-only: nothing here changes an admission.</p>
      {res.error && <LoadErrorNotice failed={['runtime health']} />}
      {!res.loading && !res.error && rows.length === 0 && <p className="text-sm text-foreground-secondary">No runtime is registered or has run.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Runtime health per runtime</caption>
            <thead><tr className="text-left text-foreground-tertiary">
              <th scope="col">Runtime</th><th scope="col">Admission</th><th scope="col">Expires</th><th scope="col">Version (admitted / observed)</th>
              <th scope="col">Probe</th><th scope="col">Leases 30 d (n)</th><th scope="col">Success</th><th scope="col">Last success</th><th scope="col">Gym</th><th scope="col">Readiness</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.runtime} className="border-t border-border">
                <td>{r.runtime}</td>
                <td>{r.admission.decision}{r.admission.allowed_now ? '' : ' (denied now)'}</td>
                <td>{r.admission.days_to_expiry === null ? '—' : r.admission.days_to_expiry < 0 ? 'expired' : `in ${r.admission.days_to_expiry} d`}</td>
                <td>{r.version.admitted ?? 'unpinned'} / {r.version.observed ?? 'not observed'}{r.version.drift ? ' — drift' : ''}</td>
                <td>{r.probe.status === 'no probe' ? 'no probe' : `${r.probe.status} (${since(r.probe.probed_at)})`}</td>
                <td>{fmt(r.leases_30d.n)} ({fmt(r.leases_30d.completed)} done / {fmt(r.leases_30d.failed)} failed / {fmt(r.leases_30d.cancelled)} cancelled)</td>
                <td>{r.leases_30d.success_rate === null ? '— (n=0)' : `${Math.round(r.leases_30d.success_rate * 100)}% (n=${r.leases_30d.completed + r.leases_30d.failed})`}</td>
                <td>{r.last_success_at ? since(r.last_success_at) : 'never'}</td>
                <td>{r.gym.species.length === 0 ? '—' : r.gym.benched ? 'benched (circuit breaker)' : 'active'}</td>
                <td>{READINESS[r.readiness]}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
