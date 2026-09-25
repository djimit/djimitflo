import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { minutesUntil, type PendingApprovals } from '../hooks/usePendingApprovals';

export function PendingApprovalsBanner({ count, soonestExpiresAt }: PendingApprovals) {
  if (count === 0) return null;
  const minutes = minutesUntil(soonestExpiresAt);
  const urgent = minutes !== null && minutes <= 15;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm ${urgent ? 'border-status-error/30 bg-status-error/10 text-status-error' : 'border-status-paused/30 bg-status-paused/10 text-foreground'}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        {count === 1 ? '1 approval is waiting' : `${count} approvals are waiting`}
        {minutes !== null && ` — the first expires in ${minutes} min`}
      </span>
      <Link to="/approvals" className="ml-auto font-medium underline">Review approvals</Link>
    </div>
  );
}
