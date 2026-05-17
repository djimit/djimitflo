import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Play, Pause, XCircle, CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import type { Task, ExecutionEvent, Approval } from '@djimitflo/shared';
import { ExecutionTimeline } from '../components/ExecutionTimeline';
import { ApprovalCard } from '../components/ApprovalCard';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const tasks = useStore((state) => state.tasks);
  const agents = useStore((state) => state.agents);
  
  const [task, setTask] = useState<Task | null>(null);
  const [executionEvents, setExecutionEvents] = useState<ExecutionEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taskId) return;

    // Try to get from store first
    const storeTask = tasks.find((t) => t.id === taskId);
    if (storeTask) {
      setTask(storeTask);
    }

    // Load full details from API
    async function loadTaskDetails() {
      try {
        const [taskData, eventsData, approvalsData] = await Promise.all([
          api.getTask(taskId!),
          api.getExecutionEvents(taskId!),
          api.getApprovals(taskId!),
        ]);
        setTask(taskData);
        setExecutionEvents(eventsData.events);
        setApprovals(approvalsData.approvals);
      } catch (error) {
        console.error('Failed to load task details:', error);
      } finally {
        setLoading(false);
      }
    }

    loadTaskDetails();
  }, [taskId, tasks]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse">
          <div className="h-8 bg-background-secondary rounded w-1/4 mb-4"></div>
          <div className="h-64 bg-background-secondary rounded"></div>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="p-8">
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <XCircle className="w-16 h-16 text-status-error mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-foreground mb-2">Task Not Found</h2>
          <p className="text-foreground-secondary mb-6">
            The task you're looking for doesn't exist or has been deleted.
          </p>
          <button
            onClick={() => navigate('/tasks')}
            className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
          >
            Back to Tasks
          </button>
        </div>
      </div>
    );
  }

  const agent = agents.find((a) => a.id === task.agent_id);
  const statusConfig = getStatusConfig(task.status);
  const priorityConfig = getPriorityConfig(task.priority);
  const riskConfig = getRiskConfig(task.risk_level);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          to="/tasks"
          className="p-2 hover:bg-background-elevated rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-foreground-secondary" />
        </Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-foreground">{task.title}</h1>
          <p className="text-foreground-secondary mt-1">Task ID: {task.id.slice(0, 8)}</p>
        </div>
      </div>

      {/* Status Bar */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {statusConfig.icon}
              <span className={`px-3 py-1 rounded-full text-sm font-medium border ${statusConfig.color}`}>
                {task.status.replace('_', ' ')}
              </span>
            </div>
            <div className={`px-3 py-1 rounded-full text-sm font-medium border ${priorityConfig.color}`}>
              {task.priority} priority
            </div>
            <div className={`px-3 py-1 rounded-full text-sm font-medium border ${riskConfig.color}`}>
              {task.risk_level} risk
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {task.status === 'running' && (
              <button className="flex items-center gap-2 px-4 py-2 bg-status-paused/10 text-status-paused border border-status-paused/20 rounded-lg hover:bg-status-paused/20 transition-colors">
                <Pause className="w-4 h-4" />
                Pause
              </button>
            )}
            {(task.status === 'pending' || task.status === 'paused') && (
              <button className="flex items-center gap-2 px-4 py-2 bg-status-running/10 text-status-running border border-status-running/20 rounded-lg hover:bg-status-running/20 transition-colors">
                <Play className="w-4 h-4" />
                Start
              </button>
            )}
            {task.status === 'running' && (
              <button className="flex items-center gap-2 px-4 py-2 bg-status-error/10 text-status-error border border-status-error/20 rounded-lg hover:bg-status-error/20 transition-colors">
                <XCircle className="w-4 h-4" />
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Details */}
        <div className="lg:col-span-1 space-y-6">
          {/* Task Info */}
          <div className="bg-background-secondary border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Details</h2>
            <div className="space-y-4">
              <div>
                <div className="text-sm text-foreground-tertiary mb-1">Description</div>
                <div className="text-sm text-foreground">{task.description}</div>
              </div>
              <div>
                <div className="text-sm text-foreground-tertiary mb-1">Agent</div>
                <div className="text-sm text-foreground font-medium">
                  {agent?.name || 'Unassigned'}
                </div>
              </div>
              <div>
                <div className="text-sm text-foreground-tertiary mb-1">Execution Mode</div>
                <div className="text-sm text-foreground capitalize">
                  {task.execution_mode.replace('_', ' ')}
                </div>
              </div>
              {task.started_at && (
                <div>
                  <div className="text-sm text-foreground-tertiary mb-1">Started At</div>
                  <div className="text-sm text-foreground">
                    {new Date(task.started_at).toLocaleString()}
                  </div>
                </div>
              )}
              {task.completed_at && (
                <div>
                  <div className="text-sm text-foreground-tertiary mb-1">Completed At</div>
                  <div className="text-sm text-foreground">
                    {new Date(task.completed_at).toLocaleString()}
                  </div>
                </div>
              )}
              {task.execution_time_ms && (
                <div>
                  <div className="text-sm text-foreground-tertiary mb-1">Execution Time</div>
                  <div className="text-sm text-foreground">
                    {formatDuration(task.execution_time_ms)}
                  </div>
                </div>
              )}
              {task.token_usage && (
                <div>
                  <div className="text-sm text-foreground-tertiary mb-1">Token Usage</div>
                  <div className="text-sm text-foreground">
                    {task.token_usage.toLocaleString()} tokens
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tags */}
          {task.tags.length > 0 && (
            <div className="bg-background-secondary border border-border rounded-lg p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {task.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-3 py-1 bg-background-elevated text-foreground-secondary text-sm rounded-full border border-border"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Timeline & Approvals */}
        <div className="lg:col-span-2 space-y-6">
          {/* Approvals */}
          {approvals.length > 0 && (
            <div className="bg-background-secondary border border-border rounded-lg p-6">
              <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-status-paused" />
                Pending Approvals
              </h2>
              <div className="space-y-3">
                {approvals.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} />
                ))}
              </div>
            </div>
          )}

          {/* Execution Timeline */}
          <div className="bg-background-secondary border border-border rounded-lg p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">Execution Timeline</h2>
            <ExecutionTimeline events={executionEvents} />
          </div>
        </div>
      </div>
    </div>
  );
}

function getStatusConfig(status: string) {
  const configs: Record<string, { icon: JSX.Element; color: string }> = {
    pending: {
      icon: <Clock className="w-5 h-5 text-status-idle" />,
      color: 'bg-status-idle/10 text-status-idle border-status-idle/20',
    },
    running: {
      icon: <Play className="w-5 h-5 text-status-running" />,
      color: 'bg-status-running/10 text-status-running border-status-running/20',
    },
    completed: {
      icon: <CheckCircle className="w-5 h-5 text-status-completed" />,
      color: 'bg-status-completed/10 text-status-completed border-status-completed/20',
    },
    failed: {
      icon: <XCircle className="w-5 h-5 text-status-error" />,
      color: 'bg-status-error/10 text-status-error border-status-error/20',
    },
    awaiting_approval: {
      icon: <AlertTriangle className="w-5 h-5 text-status-paused" />,
      color: 'bg-status-paused/10 text-status-paused border-status-paused/20',
    },
  };
  return configs[status] || configs.pending;
}

function getPriorityConfig(priority: string) {
  const configs: Record<string, { color: string }> = {
    low: { color: 'bg-risk-low/10 text-risk-low border-risk-low/20' },
    medium: { color: 'bg-risk-medium/10 text-risk-medium border-risk-medium/20' },
    high: { color: 'bg-risk-high/10 text-risk-high border-risk-high/20' },
    critical: { color: 'bg-risk-critical/10 text-risk-critical border-risk-critical/20' },
  };
  return configs[priority] || configs.medium;
}

function getRiskConfig(riskLevel: string) {
  const configs: Record<string, { color: string }> = {
    low: { color: 'bg-risk-low/10 text-risk-low border-risk-low/20' },
    medium: { color: 'bg-risk-medium/10 text-risk-medium border-risk-medium/20' },
    high: { color: 'bg-risk-high/10 text-risk-high border-risk-high/20' },
    critical: { color: 'bg-risk-critical/10 text-risk-critical border-risk-critical/20' },
  };
  return configs[riskLevel] || configs.low;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
