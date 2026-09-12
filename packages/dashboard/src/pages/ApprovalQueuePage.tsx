import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ApprovalRequest } from '@djimitflo/shared';
import { WebSocketEventType } from '@djimitflo/shared';
import { ApprovalCard } from '../components/ApprovalCard';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

type StatusFilter = 'pending' | 'approved' | 'denied' | 'all';

const TABS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'all', label: 'All' },
];

export function ApprovalQueuePage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StatusFilter>('pending');
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const currentTab = useRef<StatusFilter>(tab);
  currentTab.current = tab;
  const { subscribe } = useWebSocket(true);

  const load = useCallback(async (status: StatusFilter) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAllApprovals(status === 'all' ? undefined : status);
      if (currentRequest === requestId.current) setApprovals(result.approvals);
    } catch (cause) {
      if (currentRequest === requestId.current) setError(cause instanceof Error ? cause.message : 'Approval queue unavailable');
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
    return () => { requestId.current += 1; };
  }, [tab, load]);

  useEffect(() => {
    const refresh = () => {
      void load(tab);
    };
    const unsubs = [
      subscribe(WebSocketEventType.APPROVAL_REQUESTED, refresh),
      subscribe(WebSocketEventType.APPROVAL_GRANTED, refresh),
      subscribe(WebSocketEventType.APPROVAL_DENIED, refresh),
      subscribe(WebSocketEventType.APPROVAL_EXPIRED, refresh),
    ];
    return () => unsubs.forEach(u => u());
  }, [subscribe, tab, load]);

  const isPendingTab = tab === 'pending';

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Approval Queue</h1>
        <p className="text-foreground-secondary mt-2">
          Review requested actions and their recorded decisions.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(t => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.value
                ? 'bg-accent/10 text-accent border border-accent/20'
                : 'text-foreground-secondary hover:bg-background-elevated border border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">
          Loading…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-border bg-background-secondary p-6">
          <p role="alert" className="text-status-error">{error}</p>
          <button onClick={() => void load(tab)} className="mt-3 text-accent">Retry</button>
        </div>
      ) : approvals.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <AlertTriangle className="w-12 h-12 text-status-completed mx-auto mb-4" />
          <p className="text-foreground-secondary">
            {isPendingTab
              ? 'No pending approvals in this queue.'
              : `No ${tab === 'all' ? '' : tab} approvals found.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onUpdated={() => {
                  void load(currentTab.current);
                }}
              />
          ))}
        </div>
      )}
    </div>
  );
}
