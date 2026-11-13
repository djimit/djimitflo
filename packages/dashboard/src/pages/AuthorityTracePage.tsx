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
  /** the task or goal the correlation id names (server lookup); null when it names neither */
  subject?: { kind: 'task' | 'goal'; id: string; title: string } | null;
}

/**
 * Truth audit 2026-11-12: 194 events (2026-09-25..10-09) from `autonomy:*` actors were stored as actor_type 'human'.
 * The ledger is append-only, so history is not rewritten; the actor prefix decides how it is rendered.
 */
const actorKind = (ev: Pick<AuthorityEvent, 'actor_subject' | 'actor_type'>) =>
  ev.actor_subject.startsWith('autonomy:') ? 'automated' : ev.actor_type;

interface AuthorityStats {
  total: number;
  /** HOLDs with no later ALLOW/DENY on the same correlation id */
  open_holds?: number;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [decision]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.getAuthorityStats() as unknown as AuthorityStats;
      const e = await api.getAuthorityEvents(decision === 'ALL' ? undefined : decision);
      setStats(s);
      setEvents(e.events as unknown as AuthorityEvent[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authority ledger unavailable');
    } finally {
      setLoading(false);
    }
  };

  if (error) return (
    <div className="p-8 space-y-4">
      <h1 className="text-3xl font-bold text-foreground">Authority Ledger</h1>
      <p role="alert" className="text-status-error">{error}</p>
      <button onClick={() => void load()} className="rounded border border-border px-3 py-2 text-foreground">Retry</button>
    </div>
  );

  const total = stats?.total ?? 0;
  const decisionColor = (d: string) =>
    d === 'ALLOW' ? 'text-green-500' : d === 'DENY' ? 'text-red-500' : 'text-amber-500';
  // previous_state is not recorded by any emitter yet: hide the column instead of a page of dashes
  const showPrevious = events.some((ev) => ev.previous_state);
  const openHolds = stats?.open_holds;

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-8 h-8" /> Authority Ledger
        </h1>
        <p className="text-foreground-secondary mt-2">
          Append-only LifecycleEvents (djimit.io/v1alpha1) over the decision chain:
          editorial, runtime, approvals and evidence.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-background-secondary border border-border rounded-xl p-4">
          <div className="text-sm text-foreground-secondary">Total events</div>
          <div className="text-2xl font-bold text-foreground">{stats?.note ? '—' : total}</div>
        </div>
        {openHolds !== undefined && (
          <div data-testid="open-holds" className="bg-background-secondary border border-border rounded-xl p-4">
            <div className="text-sm text-foreground-secondary">Open holds</div>
            <div className={`text-2xl font-bold ${openHolds > 0 ? 'text-amber-500' : 'text-foreground'}`}>{openHolds}</div>
            <div className="text-xs text-foreground-muted">HOLD without a later ALLOW/DENY</div>
          </div>
        )}
        {(stats?.by_decision ?? []).map((d) => (
          <div key={d.policy_decision} data-testid={`decision-${d.policy_decision}`} className="bg-background-secondary border border-border rounded-xl p-4">
            <div className="text-sm text-foreground-secondary">{d.policy_decision}{d.policy_decision === 'HOLD' ? ' (total, incl. resolved)' : ''}</div>
            {/* a HOLD total is history, not a backlog: only open holds are an alarm */}
            <div className={`text-2xl font-bold ${d.policy_decision === 'HOLD' ? 'text-foreground' : decisionColor(d.policy_decision)}`}>{d.n}</div>
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
          <option value="ALL">All decisions</option>
          <option value="ALLOW">ALLOW</option>
          <option value="DENY">DENY</option>
          <option value="HOLD">HOLD</option>
        </select>
      </div>

      <div className="bg-background-secondary border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-foreground-secondary border-b border-border">
            <tr>
              <th className="text-left p-3">Time</th>
              <th className="text-left p-3">Seq</th>
              <th className="text-left p-3">{showPrevious ? 'Previous → requested' : 'Requested state'}</th>
              <th className="text-left p-3">Decision</th>
              <th className="text-left p-3">Subject</th>
              <th className="text-left p-3">Actor</th>
              <th className="text-left p-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {(loading ? [] : events).map((ev) => (
              <tr key={ev.event_id} className="border-b border-border/50 last:border-0">
                <td className="p-3 text-foreground-secondary">{new Date(ev.occurred_at).toLocaleString()}</td>
                <td className="p-3 text-foreground-secondary">{ev.sequence}</td>
                <td className="p-3 font-mono text-xs">
                  {showPrevious ? `${ev.previous_state ?? '—'} → ${ev.requested_state}` : ev.requested_state}
                </td>
                <td className={`p-3 font-semibold ${decisionColor(ev.policy_decision)}`}>{ev.policy_decision}</td>
                <td className="p-3 text-xs">
                  {ev.subject?.kind === 'task'
                    ? <a href={`/tasks/${encodeURIComponent(ev.subject.id)}`} className="underline">{ev.subject.title}</a>
                    : ev.subject?.kind === 'goal'
                      ? <span title={`goal ${ev.subject.id}`}><span className="text-foreground-muted">goal: </span>{ev.subject.title}</span>
                      : <span className="text-foreground-muted">—</span>}
                </td>
                <td className="p-3 text-xs" title={actorKind(ev) !== ev.actor_type ? `stored as actor_type '${ev.actor_type}'` : undefined}>
                  {ev.actor_subject} ({actorKind(ev)})
                </td>
                <td className="p-3 text-xs text-foreground-secondary">{ev.source_system}</td>
              </tr>
            ))}
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-foreground-secondary text-sm">
                  No events yet. The emitter runs in the EVE-V assurance gate and djimitflo_authority_emit.
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
