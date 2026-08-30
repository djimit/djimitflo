import { useEffect, useState } from 'react';
import { ShieldCheck, Filter, Activity } from 'lucide-react';
import { api } from '../lib/api';

interface AuthorityEvent {
  event_id: string;
  correlation_id: string;
  sequence: number;
  occurred_at: string;
  previous_state: string | null;
  requested_state: string;
  policy_decision: 'ALLOW' | 'DENY' | 'HOLD';
  actor_subject: string;
  actor_type: string;
  source_system: string;
}

interface AuthorityStats {
  total: number;
  note?: string;
  by_decision?: Array<{ policy_decision: string; n: number }>;
  by_requested_state?: Array<{ requested_state: string; n: number }>;
  by_source_system?: Array<{ source_system: string; n: number }>;
  recent_denials_and_holds?: Array<{
    event_id: string; occurred_at: string; requested_state: string;
    policy_decision: string; actor_subject: string; source_system: string;
  }>;
}

export function AuthorityTracePage() {
  const [stats, setStats] = useState<AuthorityStats | null>(null);
  const [events, setEvents] = useState<AuthorityEvent[]>([]);
  const [decision, setDecision] = useState<string>('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, [decision]);

  const load = async () => {
    setLoading(true);
    try {
      const s = await api.getAuthorityStats() as unknown as AuthorityStats;
      const e = await api.getAuthorityEvents(decision === 'ALL' ? undefined : decision);
      setStats(s);
      setEvents(e.events as unknown as AuthorityEvent[]);
    } finally {
      setLoading(false);
    }
  };

  const total = stats?.total ?? 0;
  const decisionColor = (d: string) =>
    d === 'ALLOW' ? 'text-green-500' : d === 'DENY' ? 'text-red-500' : 'text-amber-500';

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-8 h-8" /> Authority Ledger
        </h1>
        <p className="text-foreground-secondary mt-2">
          Append-only LifecycleEvents (djimit.io/v1alpha1) over de beslissingsketen:
          editoriaal, runtime, approvals en evidence.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-background-secondary border border-border rounded-xl p-4">
          <div className="text-sm text-foreground-secondary">Totaal events</div>
          <div className="text-2xl font-bold text-foreground">{stats?.note ? '—' : total}</div>
        </div>
        {(stats?.by_decision ?? []).map((d) => (
          <div key={d.policy_decision} className="bg-background-secondary border border-border rounded-xl p-4">
            <div className="text-sm text-foreground-secondary">{d.policy_decision}</div>
            <div className={`text-2xl font-bold ${decisionColor(d.policy_decision)}`}>{d.n}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-foreground-secondary" />
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="bg-background-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
        >
          <option value="ALL">Alle beslissingen</option>
          <option value="ALLOW">ALLOW</option>
          <option value="DENY">DENY</option>
          <option value="HOLD">HOLD</option>
        </select>
      </div>

      <div className="bg-background-secondary border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-foreground-secondary border-b border-border">
            <tr>
              <th className="text-left p-3">Tijd</th>
              <th className="text-left p-3">Seq</th>
              <th className="text-left p-3">Vorige, Aangevraagd</th>
              <th className="text-left p-3">Beslissing</th>
              <th className="text-left p-3">Actor</th>
              <th className="text-left p-3">Bron</th>
            </tr>
          </thead>
          <tbody>
            {(loading ? [] : events).map((ev) => (
              <tr key={ev.event_id} className="border-b border-border/50 last:border-0">
                <td className="p-3 text-foreground-secondary">{new Date(ev.occurred_at).toLocaleString()}</td>
                <td className="p-3 text-foreground-secondary">{ev.sequence}</td>
                <td className="p-3 font-mono text-xs">
                  {ev.previous_state ?? '—'} → {ev.requested_state}
                </td>
                <td className={`p-3 font-semibold ${decisionColor(ev.policy_decision)}`}>{ev.policy_decision}</td>
                <td className="p-3 text-xs">{ev.actor_subject} ({ev.actor_type})</td>
                <td className="p-3 text-xs text-foreground-secondary">{ev.source_system}</td>
              </tr>
            ))}
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-foreground-secondary text-sm">
                  Nog geen events. De emitter draait in de EVE-V assurance-gate en djimitflo_authority_emit.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-foreground-secondary flex items-center gap-2">
        <Activity className="w-3 h-3" /> Recent DENY/HOLD: {(stats?.recent_denials_and_holds ?? []).length}
      </div>
    </div>
  );
}