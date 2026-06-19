import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock } from 'lucide-react';
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

function statusIcon(status: string) {
  if (status === 'approved') return <CheckCircle className="w-4 h-4 text-green-400" />;
  if (status === 'denied') return <AlertTriangle className="w-4 h-4 text-red-400" />;
  return <Clock className="w-4 h-4 text-yellow-400" />;
}

export function ApprovalQueuePage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StatusFilter>('pending');
  const { subscribe } = useWebSocket(true);

  const load = async (status: StatusFilter) => {
    const result = await api.getAllApprovals(status === 'all' ? undefined : status);
    setApprovals(result.approvals);
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    load(tab).catch((error) => {
      console.error('Failed to load approvals:', error);
      setLoading(false);
    });
  }, [tab]);

  useEffect(() => {
    const refresh = () => {
      void load(tab);
    };
    const unsubs = [
      subscribe(WebSocketEventType.APPROVAL_REQUESTED, refresh),
      subscribe(WebSocketEventType.APPROVAL_GRANTED, refresh),
      subscribe(WebSocketEventType.APPROVAL_DENIED, refresh),
    ];
    return () => unsubs.forEach(u => u());
  }, [subscribe, tab]);

  const isPendingTab = tab === 'pending';

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Approval Queue</h1>
        <p className="text-foreground-secondary mt-2">
          Review high-risk execution requests.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
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
      ) : approvals.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <AlertTriangle className="w-12 h-12 text-status-completed mx-auto mb-4" />
          <p className="text-foreground-secondary">
            {isPendingTab
              ? 'No pending approvals. Execution is currently unblocked.'
              : `No ${tab === 'all' ? '' : tab} approvals found.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((approval) => (
            isPendingTab ? (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onUpdated={() => {
                  setApprovals((current) => current.filter((item) => item.id !== approval.id));
                }}
              />
            ) : (
              <div key={approval.id} className="bg-background-secondary border border-border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {statusIcon(approval.status)}
                    <span className="text-sm font-medium text-foreground">
                      {(approval as any).task_title || (approval as any).action_type || approval.id}
                    </span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                    approval.status === 'approved' ? 'bg-green-500/10 text-green-400' :
                    approval.status === 'denied' ? 'bg-red-500/10 text-red-400' :
                    'bg-yellow-500/10 text-yellow-400'
                  }`}>
                    {approval.status}
                  </span>
                </div>
                {(approval as any).risk_level && (
                  <div className="mt-2 text-xs text-foreground-secondary">
                    Risk: {(approval as any).risk_level}
                  </div>
                )}
                <div className="mt-1 text-xs text-foreground-tertiary">
                  {new Date((approval as any).created_at || '').toLocaleString()}
                </div>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}
