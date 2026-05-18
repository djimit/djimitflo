import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, Clock, Shield, FileText } from 'lucide-react';
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}