import { useState } from 'react';
import type { ApprovalRequest } from '@djimitflo/shared';
import { ApprovalStatus } from '@djimitflo/shared';
import { CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

interface ApprovalCardProps {
  approval: ApprovalRequest;
  onUpdated?: (approval: ApprovalRequest) => void;
}

export function ApprovalCard({ approval, onUpdated }: ApprovalCardProps) {
  const [status, setStatus] = useState(approval.status);
  const [processing, setProcessing] = useState(false);

  const handleApprove = async () => {
    setProcessing(true);
    try {
      const updated = await api.approveRequestExplicit(approval.id);
      setStatus(ApprovalStatus.APPROVED);
      onUpdated?.(updated);
    } catch (error) {
      console.error('Failed to approve:', error);
      alert('Failed to approve request');
    } finally {
      setProcessing(false);
    }
  };

  const handleDeny = async () => {
    const reason = prompt('Reason for denial:');
    if (!reason) return;

    setProcessing(true);
    try {
      const updated = await api.denyRequestExplicit(approval.id, reason);
      setStatus(ApprovalStatus.DENIED);
      onUpdated?.(updated);
    } catch (error) {
      console.error('Failed to deny:', error);
      alert('Failed to deny request');
    } finally {
      setProcessing(false);
    }
  };

  const riskConfig = getRiskConfig(approval.risk_level);
  const typeConfig = getTypeConfig(approval.request_type);

  return (
    <div className={`border rounded-lg p-4 ${
      status === 'pending'
        ? 'bg-status-paused/5 border-status-paused/20'
        : status === 'approved'
        ? 'bg-status-completed/5 border-status-completed/20'
        : 'bg-status-error/5 border-status-error/20'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {typeConfig.icon}
          <div>
            <div className="text-sm font-semibold text-foreground">
              {formatRequestType(approval.request_type)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className={`px-2 py-0.5 text-xs font-medium rounded border ${riskConfig.color}`}>
                {approval.risk_level} risk
              </span>
              <span className={`px-2 py-0.5 text-xs font-medium rounded border ${getStatusColor(status)}`}>
                {status}
              </span>
            </div>
          </div>
        </div>
        {status === 'pending' && approval.expires_at && (
          <div className="flex items-center gap-1 text-xs text-foreground-muted">
            <Clock className="w-3 h-3" />
            <span>Expires {formatExpiry(approval.expires_at)}</span>
          </div>
        )}
      </div>

      {/* Message */}
      <p className="text-sm text-foreground-secondary mb-3">
        {approval.request_message}
      </p>

      {/* Request Data */}
      {Object.keys(approval.request_data).length > 0 && (
        <details className="mb-3">
          <summary className="text-xs text-foreground-tertiary cursor-pointer hover:text-foreground">
            View Details
          </summary>
          <pre className="mt-2 p-2 bg-background rounded text-xs text-foreground-secondary overflow-x-auto">
            {JSON.stringify(approval.request_data, null, 2)}
          </pre>
        </details>
      )}

      {/* Action Buttons (only for pending) */}
      {status === 'pending' && (
        <div className="flex gap-2 pt-3 border-t border-border">
          <button
            onClick={handleApprove}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-status-completed/10 text-status-completed border border-status-completed/20 rounded-lg hover:bg-status-completed/20 transition-colors disabled:opacity-50"
          >
            <CheckCircle className="w-4 h-4" />
            Approve
          </button>
          <button
            onClick={handleDeny}
            disabled={processing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-status-error/10 text-status-error border border-status-error/20 rounded-lg hover:bg-status-error/20 transition-colors disabled:opacity-50"
          >
            <XCircle className="w-4 h-4" />
            Deny
          </button>
        </div>
      )}

      {/* Approved/Denied Info */}
      {status === 'approved' && approval.approved_by && (
        <div className="pt-3 border-t border-border text-xs text-foreground-tertiary">
          Approved by {approval.approved_by} at {new Date(approval.approved_at!).toLocaleString()}
        </div>
      )}
      {status === 'denied' && approval.denial_reason && (
        <div className="pt-3 border-t border-border">
          <div className="text-xs text-status-error font-medium mb-1">Denial Reason:</div>
          <div className="text-xs text-foreground-secondary">{approval.denial_reason}</div>
          {approval.approved_by && (
            <div className="text-xs text-foreground-tertiary mt-1">
              Denied by {approval.approved_by} at {new Date(approval.denied_at!).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getRiskConfig(riskLevel: string) {
  const configs: Record<string, { color: string }> = {
    low: { color: 'bg-risk-low/10 text-risk-low border-risk-low/20' },
    medium: { color: 'bg-risk-medium/10 text-risk-medium border-risk-medium/20' },
    high: { color: 'bg-risk-high/10 text-risk-high border-risk-high/20' },
    critical: { color: 'bg-risk-critical/10 text-risk-critical border-risk-critical/20' },
  };
  return configs[riskLevel] || configs.medium;
}

function getTypeConfig(_requestType: string) {
  const icon = <AlertTriangle className="w-5 h-5 text-status-paused" />;
  return { icon };
}

function getStatusColor(status: string): string {
  if (status === 'approved') return 'bg-status-completed/10 text-status-completed border-status-completed/20';
  if (status === 'denied') return 'bg-status-error/10 text-status-error border-status-error/20';
  if (status === 'expired') return 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20';
  return 'bg-status-paused/10 text-status-paused border-status-paused/20';
}

function formatRequestType(requestType: string): string {
  return requestType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatExpiry(expiresAt: string): string {
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 0) return 'expired';
  if (diffMins < 60) return `in ${diffMins}m`;
  if (diffMins < 1440) return `in ${Math.floor(diffMins / 60)}h`;
  return `in ${Math.floor(diffMins / 1440)}d`;
}
