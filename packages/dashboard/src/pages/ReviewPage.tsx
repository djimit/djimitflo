import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, Clock, Shield, FileText, GitBranch } from 'lucide-react';
import { useParams, Link } from 'react-router-dom';
import type { Task, ExecutionSummary, ExecutionEvidence, FileChange, AuditTrailEntry } from '@djimitflo/shared';
import { api } from '../lib/api';

export function ReviewPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [summary, setSummary] = useState<ExecutionSummary | null>(null);
  const [evidence, setEvidence] = useState<ExecutionEvidence[]>([]);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taskId) return;
    api.getExecutionReview(taskId).then((data) => {
      setTask(data.task);
      setSummary(data.summary);
      setEvidence(data.evidence);
      setFileChanges(data.file_changes);
      setAuditTrail(data.audit_trail);
    }).finally(() => setLoading(false));
  }, [taskId]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-background-secondary rounded w-1/4" />
          <div className="h-64 bg-background-secondary rounded" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-2xl font-bold text-foreground">Task not found</h2>
        <Link to="/tasks" className="text-accent mt-4 inline-block">Back to Tasks</Link>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/tasks/${taskId}`} className="p-2 hover:bg-background-elevated rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5 text-foreground-secondary" />
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-foreground">Execution Review</h1>
          <p className="text-foreground-secondary mt-1">{task.title} &middot; {task.id.slice(0, 8)}</p>
        </div>
      </div>

      {summary && <SummaryCard summary={summary} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <EvidenceSection evidence={evidence} />
          <FileChangesSection changes={fileChanges} />
          <DiffSection taskId={taskId!} />
        </div>
        <AuditTrailSection trail={auditTrail} />
      </div>
    </div>
  );
}

function SummaryCard({ summary }: { summary: ExecutionSummary }) {
  const statusConfig: Record<string, { icon: React.ReactNode; color: string }> = {
    completed: { icon: <CheckCircle className="w-5 h-5" />, color: 'text-status-completed' },
    failed: { icon: <XCircle className="w-5 h-5" />, color: 'text-status-error' },
    cancelled: { icon: <AlertTriangle className="w-5 h-5" />, color: 'text-foreground-muted' },
    denied: { icon: <Shield className="w-5 h-5" />, color: 'text-status-error' },
  };
  const status = statusConfig[summary.final_status] || statusConfig.completed;

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">Execution Summary</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <div className="text-xs text-foreground-tertiary">Status</div>
          <div className={`flex items-center gap-1 font-medium ${status.color}`}>{status.icon}{summary.final_status}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Risk Level</div>
          <div className="font-medium text-foreground">{summary.risk_level}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Policy Decision</div>
          <div className="font-medium text-foreground">{summary.policy_decision}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Duration</div>
          <div className="font-medium text-foreground">{summary.duration_ms ? `${Math.round(summary.duration_ms / 1000)}s` : 'N/A'}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Events</div>
          <div className="font-medium text-foreground">{summary.event_count}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Errors</div>
          <div className={`font-medium ${summary.error_count > 0 ? 'text-status-error' : 'text-foreground'}`}>{summary.error_count}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Tool Calls</div>
          <div className="font-medium text-foreground">{summary.tool_call_count}</div>
        </div>
        <div>
          <div className="text-xs text-foreground-tertiary">Approval</div>
          <div className="font-medium text-foreground">
            {summary.approval_required ? (summary.approval_granted ? 'Granted' : 'Denied/Pending') : 'Not required'}
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceSection({ evidence }: { evidence: ExecutionEvidence[] }) {
  if (evidence.length === 0) {
    return (
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
          <FileText className="w-5 h-5" /> Evidence
        </h2>
        <p className="text-foreground-secondary text-sm">No evidence collected for this execution.</p>
      </div>
    );
  }

  const severityColors: Record<string, string> = {
    info: 'border-blue-500/30 bg-blue-500/5',
    warning: 'border-status-paused/30 bg-status-paused/5',
    error: 'border-status-error/30 bg-status-error/5',
    critical: 'border-risk-critical/30 bg-risk-critical/5',
  };

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
        <FileText className="w-5 h-5" /> Evidence ({evidence.length})
      </h2>
      <div className="space-y-3">
        {evidence.map((e) => (
          <div key={e.id} className={`border rounded-lg p-3 ${severityColors[e.severity] || ''}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-background-elevated">{e.evidence_type.replace(/_/g, ' ')}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${e.severity === 'critical' || e.severity === 'error' ? 'bg-status-error/10 text-status-error' : e.severity === 'warning' ? 'bg-status-paused/10 text-status-paused' : 'bg-blue-500/10 text-blue-400'}`}>{e.severity}</span>
              <span className="text-xs text-foreground-tertiary">{e.source}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{e.title}</p>
            <p className="text-xs text-foreground-secondary mt-0.5">{e.summary}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileChangesSection({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) return null;

  const typeIcons: Record<string, string> = {
    created: '+',
    modified: '~',
    deleted: '-',
  };

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">File Changes ({changes.length})</h2>
      <div className="space-y-2">
        {changes.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-sm">
            <span className={`font-mono font-bold ${c.change_type === 'created' ? 'text-status-completed' : c.change_type === 'deleted' ? 'text-status-error' : 'text-status-paused'}`}>{typeIcons[c.change_type]}</span>
            <span className="text-foreground font-mono">{c.file_path}</span>
            {c.after_size != null && <span className="text-foreground-tertiary text-xs">{formatBytes(c.after_size)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditTrailSection({ trail }: { trail: AuditTrailEntry[] }) {
  if (trail.length === 0) {
    return (
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
          <Clock className="w-5 h-5" /> Audit Trail
        </h2>
        <p className="text-foreground-secondary text-sm">No audit events recorded.</p>
      </div>
    );
  }

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
        <Clock className="w-5 h-5" /> Audit Trail ({trail.length})
      </h2>
      <div className="space-y-3">
        {trail.map((entry, i) => (
          <div key={i} className="border-l-2 border-border pl-3">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-medium text-foreground">{entry.event_type}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${
                entry.risk_level === 'critical' ? 'bg-risk-critical/10 text-risk-critical' :
                entry.risk_level === 'high' ? 'bg-risk-high/10 text-risk-high' :
                entry.risk_level === 'medium' ? 'bg-risk-medium/10 text-risk-medium' :
                'bg-risk-low/10 text-risk-low'
              }`}>{entry.risk_level}</span>
            </div>
            <p className="text-sm text-foreground">{entry.summary}</p>
            <p className="text-xs text-foreground-tertiary mt-0.5">{new Date(entry.timestamp).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffSection({ taskId }: { taskId: string }) {
  const [diffData, setDiffData] = useState<{ files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } } | null>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getTaskDiff(taskId).catch(() => ({ files: [], summary: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, truncated: false, redactedSecrets: 0 } })),
      api.getTaskSnapshots(taskId).catch(() => ({ snapshots: [] })),
    ]).then(([diff, snap]) => {
      setDiffData(diff);
      setSnapshots(snap.snapshots || []);
    }).finally(() => setLoading(false));
  }, [taskId]);

  if (loading) return <div className="bg-background-secondary border border-border rounded-lg p-6 animate-pulse"><div className="h-6 bg-background-elevated rounded w-32 mb-4" /><div className="space-y-2"><div className="h-4 bg-background-elevated rounded" /><div className="h-4 bg-background-elevated rounded w-3/4" /></div></div>;

  if (!diffData || (diffData.files.length === 0 && snapshots.length === 0)) return null;

  const typeIcons: Record<string, string> = { created: '+', modified: '~', deleted: '-', renamed: '»' };
  const riskColors: Record<string, string> = {
    critical: 'bg-risk-critical/10 text-risk-critical border-risk-critical/20',
    high: 'bg-risk-high/10 text-risk-high border-risk-high/20',
    medium: 'bg-risk-medium/10 text-risk-medium border-risk-medium/20',
    low: 'bg-risk-low/10 text-risk-low border-risk-low/20',
  };

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
        <GitBranch className="w-5 h-5" /> Git Diff & Snapshots
      </h2>

      {snapshots.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="text-sm font-medium text-foreground-tertiary">Execution Snapshots</h3>
          {snapshots.map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 text-sm border border-border rounded p-2">
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${s.snapshot_type === 'pre_execution' ? 'bg-blue-500/10 text-blue-400' : 'bg-status-completed/10 text-status-completed'}`}>
                {s.snapshot_type === 'pre_execution' ? 'PRE' : 'POST'}
              </span>
              <span className="font-mono text-foreground-tertiary text-xs">{s.branch || 'N/A'}</span>
              <span className="font-mono text-foreground-tertiary text-xs">{s.head_commit?.slice(0, 8) || 'N/A'}</span>
              <span className={s.is_clean ? 'text-status-completed' : 'text-status-paused'}>
                {s.is_clean ? 'clean' : 'dirty'}
              </span>
            </div>
          ))}
        </div>
      )}

      {diffData.summary.redactedSecrets > 0 && (
        <div className="mb-4 p-2 rounded border border-risk-critical/20 bg-risk-critical/5 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-risk-critical" />
          <span className="text-risk-critical">{diffData.summary.redactedSecrets} secret(s) redacted from diff</span>
        </div>
      )}

      {diffData.files.length > 0 ? (
        <>
          <div className="flex gap-4 mb-3 text-sm text-foreground-secondary">
            <span>{diffData.summary.totalFiles} file(s)</span>
            <span className="text-status-completed">+{diffData.summary.totalAdditions}</span>
            <span className="text-status-error">-{diffData.summary.totalDeletions}</span>
            {diffData.summary.truncated && <span className="text-status-paused">(truncated)</span>}
          </div>
          <div className="space-y-1">
            {diffData.files.map((f) => (
              <div key={f.id || f.file_path}>
                <button
                  className="w-full flex items-center gap-2 text-sm p-2 rounded hover:bg-background-elevated transition-colors"
                  onClick={() => setExpandedFile(expandedFile === f.file_path ? null : f.file_path)}
                >
                  <span className={`font-mono font-bold ${f.change_type === 'created' ? 'text-status-completed' : f.change_type === 'deleted' ? 'text-status-error' : 'text-status-paused'}`}>
                    {typeIcons[f.change_type] || '?'}
                  </span>
                  <span className="font-mono text-foreground flex-1 text-left truncate">{f.file_path}</span>
                  {(f as any).additions != null && <span className="text-status-completed text-xs">+{(f as any).additions}</span>}
                  {(f as any).deletions != null && <span className="text-status-error text-xs">-{(f as any).deletions}</span>}
                  <span className={`text-xs px-1.5 py-0.5 rounded border ${riskColors[f.risk_level] || ''}`}>{f.risk_level}</span>
                  {(f as any).diff_truncated && <span className="text-xs text-status-paused">truncated</span>}
                </button>
                {expandedFile === f.file_path && f.diff && (
                  <pre className="bg-background-elevated rounded p-3 text-xs font-mono overflow-x-auto max-h-64 mt-1 mb-2 border border-border">
                    {f.diff.length > 5000 ? f.diff.substring(0, 5000) + '\n... (diff truncated in view)' : f.diff}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-foreground-secondary text-sm">No file changes detected.</p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}