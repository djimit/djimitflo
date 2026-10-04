import { AlertTriangle } from 'lucide-react';

/** Records a failed optional section instead of swallowing it (W1: pages rendered empty on API errors). */
export function softFail<T>(failed: string[], section: string, fallback: T) {
  return (err: unknown): T => {
    failed.push(`${section}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  };
}

export function LoadErrorNotice({ failed }: { failed: string[] }) {
  if (!failed.length) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">Could not load {failed.length === 1 ? 'one section' : `${failed.length} sections`}; what is shown may be incomplete.</p>
        <ul className="mt-1 list-disc pl-5 text-xs">{failed.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>
    </div>
  );
}
