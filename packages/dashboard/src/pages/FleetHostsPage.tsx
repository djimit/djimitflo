import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { RuntimeHealthSection } from './RuntimeHealthPage';
import { ACTION_PERMISSIONS as P, needsText, useCan } from '../lib/permissions';

const fetchFleet = () => api.getFleetHosts();

const DIAGNOSTICS = ['ping', 'uptime', 'disk', 'failed-services', 'top'];
const button = 'rounded border border-border px-2 py-0.5 text-sm hover:bg-background-tertiary disabled:opacity-50';
const ago = (s: number) => (s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const tone: Record<string, string> = { done: 'text-status-completed', failed: 'text-status-error', denied: 'text-status-error', expired: 'text-foreground-muted', pending_approval: 'text-status-warning', running: 'text-status-active', queued: 'text-status-active' };

export function FleetHostsPage() {
  const fleet = useResource(fetchFleet, { pollMs: 15_000 });
  const hosts = fleet.data?.hosts ?? [];
  const commands = fleet.data?.commands ?? [];
  const load = fleet.refresh;
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? fleet.error;
  const [busy, setBusy] = useState<string | null>(null);
  const canRequest = useCan(P.fleetCommandRequest); const canDecide = useCan(P.fleetCommandDecide);
  const [host, setHost] = useState('');
  const [shell, setShell] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { if (!host && hosts[0]) setHost(hosts[0].host); }, [hosts, host]);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await action(); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Action failed'); } finally { setBusy(null); }
  };
  const submitShell = (e: FormEvent) => {
    e.preventDefault();
    if (!host || !shell.trim()) return;
    void act('shell', () => api.requestFleetCommand(host, shell.trim())).then(() => setShell(''));
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Server className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Fleet hosts</h1>
        <button onClick={() => void load()} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>
      <p className="text-sm text-foreground-secondary">
        Hosts pull; Djimitflo never connects to them. A host is live when its agent checked in within 2 minutes. Diagnostics run without approval;
        shell commands run as root only after a human approves exactly that text, and must be picked up within 15 minutes.
      </p>
      {error && <p role="alert" className="text-status-error">{error}</p>}

      <section aria-labelledby="hosts">
        <h2 id="hosts" className="text-lg font-semibold mb-2">Hosts</h2>
        {hosts.length === 0 ? <p className="text-sm text-foreground-secondary">No host agent has checked in yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-foreground-tertiary"><th>Host</th><th>Status</th><th>Last check-in</th><th>OS</th><th>Load</th><th>Disk /</th></tr></thead>
            <tbody>{hosts.map((h) => (
              <tr key={h.host} className="border-t border-border">
                <td>{h.host}</td><td className={h.live ? 'text-status-completed' : 'text-status-error'}>{h.live ? 'live' : 'stale'}</td><td>{ago(h.seconds_ago)}</td>
                <td>{String(h.info.os ?? '—')}</td><td>{Array.isArray(h.info.load) ? (h.info.load as number[]).join(' / ') : '—'}</td><td>{h.info.disk_root_pct !== undefined ? `${String(h.info.disk_root_pct)} %` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="components">
        <h2 id="components" className="text-lg font-semibold mb-2">Components per host</h2>
        <p className="text-xs text-foreground-tertiary mb-2">Reported by each host agent every 5 minutes: running containers and Djimit-related services (agent version 2 or later).</p>
        {hosts.length === 0 ? null : (
          <ul className="space-y-3">{hosts.map((h) => {
            const list = Array.isArray(h.info.components) ? (h.info.components as string[]) : null;
            return (
              <li key={h.host}>
                <div className="text-sm font-medium">{h.host} <span className="text-xs text-foreground-tertiary">{list ? `${list.length} components` : 'agent too old to report components'}</span></div>
                {list && <ul className="mt-1 flex flex-wrap gap-1">{list.map((c) => <li key={c} className="rounded bg-background-tertiary px-2 py-0.5 text-xs" title={c}>{c.replace(/^(docker|systemd|user|launchd):/, '')}<span className="ml-1 text-foreground-muted">{c.split(':')[0]}</span></li>)}</ul>}
              </li>
            );
          })}</ul>
        )}
      </section>

      <section aria-labelledby="run" className="space-y-2">
        <h2 id="run" className="text-lg font-semibold">Run</h2>
        <label className="text-sm">Host{' '}
          <select value={host} onChange={(e) => setHost(e.target.value)} className="rounded border border-border bg-background px-2 py-1">
            {hosts.map((h) => <option key={h.host} value={h.host}>{h.host}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {DIAGNOSTICS.map((d) => <button key={d} type="button" className={button} disabled={!host || busy !== null || !canRequest} title={canRequest ? undefined : needsText(P.fleetCommandRequest)} onClick={() => void act(d, () => api.requestFleetCommand(host, d))}>{d}</button>)}
        </div>
        <form onSubmit={submitShell} className="flex gap-2">
          <input aria-label="Shell command" value={shell} onChange={(e) => setShell(e.target.value)} placeholder="shell command (runs as root after approval)"
            className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-sm" />
          <button type="submit" className={button} disabled={!host || !shell.trim() || busy !== null || !canRequest} title={canRequest ? undefined : needsText(P.fleetCommandRequest)}>Request</button>
        </form>
      </section>

      <section aria-labelledby="commands">
        <h2 id="commands" className="text-lg font-semibold mb-2">Commands</h2>
        {commands.length === 0 ? <p className="text-sm text-foreground-secondary">No commands yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-foreground-tertiary"><th>Host</th><th>Command</th><th>Status</th><th>Requested / approved by</th><th /></tr></thead>
            <tbody>{commands.map((c) => (
              <tr key={c.id} className="border-t border-border align-top">
                <td>{c.host}</td>
                <td className="font-mono break-all">{c.command}{c.kind === 'shell' && <div className="text-xs text-foreground-muted">sha256 {c.command_sha256.slice(0, 16)}…</div>}
                  {open === c.id && c.output !== null && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background-tertiary p-2 text-xs">{c.output}</pre>}
                </td>
                <td className={tone[c.status] ?? ''}>{c.status.replace('_', ' ')}{c.exit_code !== null ? ` (${c.exit_code})` : ''}</td>
                <td>{c.requested_by}{c.approved_by ? ` / ${c.approved_by}` : ''}</td>
                <td className="whitespace-nowrap space-x-1">
                  {c.status === 'pending_approval' && <>
                    <button type="button" className={button} disabled={busy !== null || !canDecide} title={canDecide ? undefined : needsText(P.fleetCommandDecide)} onClick={() => void act(`a-${c.id}`, () => api.approveFleetCommand(c.id, c.command_sha256))}>Approve</button>
                    <button type="button" className={button} disabled={busy !== null || !canDecide} title={canDecide ? undefined : needsText(P.fleetCommandDecide)} onClick={() => void act(`d-${c.id}`, () => api.denyFleetCommand(c.id))}>Deny</button>
                  </>}
                  {c.output !== null && <button type="button" className={button} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Hide' : 'Output'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <RuntimeHealthSection />
    </div>
  );
}
