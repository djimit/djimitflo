import { AlertTriangle, CheckCircle2, Timer, XCircle } from 'lucide-react';

export function StatusIcon({ status }: { status: string }) {
  if (status === 'pass' || status === 'completed') return <CheckCircle2 className="h-4 w-4 text-status-completed shrink-0" />;
  if (status === 'fail' || status === 'failed' || status === 'blocked' || status === 'escalated') return <XCircle className="h-4 w-4 text-status-error shrink-0" />;
  if (status === 'skipped') return <AlertTriangle className="h-4 w-4 text-foreground-tertiary shrink-0" />;
  return <Timer className="h-4 w-4 text-status-paused shrink-0" />;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'pass' || status === 'completed'
    ? 'bg-status-completed/10 text-status-completed border-status-completed/20'
    : status === 'fail' || status === 'failed' || status === 'blocked' || status === 'escalated'
      ? 'bg-status-error/10 text-status-error border-status-error/20'
      : status === 'skipped'
        ? 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20'
        : 'bg-status-paused/10 text-status-paused border-status-paused/20';
  return <span className={`px-2 py-0.5 text-xs rounded border ${tone}`}>{status}</span>;
}
