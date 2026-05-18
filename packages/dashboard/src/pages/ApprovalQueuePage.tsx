import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ApprovalRequest } from '@djimitflo/shared';
import { WebSocketEventType } from '@djimitflo/shared';
import { ApprovalCard } from '../components/ApprovalCard';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

export function ApprovalQueuePage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    const load = async () => {
      const result = await api.getAllApprovals('pending');
      setApprovals(result.approvals);
      setLoading(false);
    };
    load().catch((error) => {
      console.error('Failed to load approvals:', error);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const refresh = async () => {
      const result = await api.getAllApprovals('pending');
      setApprovals(result.approvals);
    };
    const unsubRequested = subscribe(WebSocketEventType.APPROVAL_REQUESTED, () => {
      void refresh();
    });
    const unsubApproved = subscribe(WebSocketEventType.APPROVAL_GRANTED, () => {
      void refresh();
    });
    const unsubDenied = subscribe(WebSocketEventType.APPROVAL_DENIED, () => {
      void refresh();
    });
    return () => {
      unsubRequested();
      unsubApproved();
      unsubDenied();
    };
  }, [subscribe]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Approval Queue</h1>
        <p className="text-foreground-secondary mt-2">Review pending high-risk execution requests before they continue.</p>
      </div>

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading approvals...</div>
      ) : approvals.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <AlertTriangle className="w-12 h-12 text-status-completed mx-auto mb-4" />
          <p className="text-foreground-secondary">No pending approvals. Execution is currently unblocked.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onUpdated={() => {
                setApprovals((current) => current.filter((item) => item.id !== approval.id));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
