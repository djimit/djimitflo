import { Workflow } from 'lucide-react';
import type { LoopRunRecord } from '../../lib/api';
import { StatusBadge } from './status';

/** UX-28: the run list of the Goals & Loops page; selection state stays in the page. */
export function LoopRunList({ runs, loading, selectedRun, actionId, setSelectedRunId }: {
  runs: LoopRunRecord[]; loading: boolean; selectedRun: LoopRunRecord | null; actionId: string | null; setSelectedRunId: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading loop runs...</div>
      ) : runs.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">No loop runs yet.</div>
      ) : (
        runs.map((run) => (
          <button
            key={run.id}
            onClick={() => setSelectedRunId(run.id)}
            disabled={actionId !== null}
            className={`w-full text-left rounded-lg border p-4 transition-colors ${selectedRun?.id === run.id ? 'border-accent/40 bg-accent/5' : 'border-border bg-background-secondary hover:border-accent/20'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Workflow className="h-4 w-4 text-accent shrink-0" />
                  <span className="font-semibold text-foreground truncate">{run.loop_name}</span>
                </div>
                <div className="text-xs text-foreground-tertiary mt-1 truncate">{run.id}</div>
              </div>
              <StatusBadge status={run.status} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <SmallStat label="Findings" value={run.findings.length} />
              <SmallStat label="Gates" value={run.gates.length} />
              <SmallStat label="Mode" value={run.mode} />
            </div>
            {run.next_actions.length > 0 && (
              <div className="mt-3 text-xs text-foreground-secondary truncate">{run.next_actions[0]}</div>
            )}
          </button>
        ))
      )}
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border bg-background px-2 py-1">
      <div className="text-foreground-tertiary">{label}</div>
      <div className="text-foreground font-medium truncate">{value}</div>
    </div>
  );
}
