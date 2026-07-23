import type { ReactNode } from 'react';
import { Activity, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { useStore, selectActiveTasks, selectCompletedTasks, selectFailedTasks } from '../lib/store';
import { api } from '../lib/api';
import { SpecComplianceWidget } from '../components/SpecComplianceWidget';

export function DashboardPage() {
  const tasks = useStore((state) => state.tasks);
  const agents = useStore((state) => state.agents);
  const systemHealth = useStore((state) => state.systemHealth);
  const isConnected = useStore((state) => state.isConnected);

  const activeTasks = useStore(selectActiveTasks);
  const completedTasks = useStore(selectCompletedTasks);
  const failedTasks = useStore(selectFailedTasks);
  const queuedTasks = tasks.filter((t) => t.status === 'queued' || t.status === 'pending');

  // D3: REST fallback — load initial data via API when WebSocket store is empty.
  useEffect(() => {
    if (tasks.length === 0 && agents.length === 0) {
      Promise.all([api.getTasks(), api.getAgents()])
        .then(([taskRes, agentRes]) => {
          useStore.setState({ tasks: taskRes.tasks });
          useStore.setState({ agents: agentRes.agents });
        })
        .catch(() => { /* best-effort */ });
    }
  }, []);
  const activeAgents = agents.filter((a) => a.status === 'active');

  // Calculate uptime
  const uptimeHours = Math.floor(systemHealth.uptime_ms / 1000 / 60 / 60);
  const memoryMb = Math.round(systemHealth.memory_usage_mb || 0);

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Mission Control</h1>
          <p className="text-foreground-secondary mt-2">
            Real-time agent orchestration and task execution monitoring
          </p>
        </div>
        {/* Connection status */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-status-active animate-pulse' : 'bg-status-error'}`} />
          <span className="text-sm text-foreground-tertiary">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
      
      {/* System Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatusCard
          title="Active Tasks"
          value={activeTasks.length.toString()}
          icon={<Activity className="w-6 h-6 text-status-running" />}
          trend={`${activeTasks.length} running now`}
          trendUp={true}
        />
        <StatusCard
          title="Completed"
          value={completedTasks.length.toString()}
          icon={<CheckCircle2 className="w-6 h-6 text-status-completed" />}
          trend={`${completedTasks.length} successful`}
          trendUp={true}
        />
        <StatusCard
          title="Failed"
          value={failedTasks.length.toString()}
          icon={<XCircle className="w-6 h-6 text-status-error" />}
          trend={failedTasks.length === 0 ? 'All good' : 'Needs attention'}
          trendUp={false}
        />
        <StatusCard
          title="Queued"
          value={queuedTasks.length.toString()}
          icon={<Clock className="w-6 h-6 text-status-paused" />}
          trend={`${queuedTasks.length} pending`}
          trendUp={true}
        />
      </div>
      
      {/* System Health */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-foreground">System Health</h2>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${
            systemHealth.status === 'healthy'
              ? 'bg-status-active/10 text-status-active border border-status-active/20'
              : systemHealth.status === 'degraded'
              ? 'bg-status-paused/10 text-status-paused border border-status-paused/20'
              : 'bg-status-error/10 text-status-error border border-status-error/20'
          }`}>
            {systemHealth.status === 'healthy' ? 'Operational' : systemHealth.status}
          </span>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <HealthMetric
            label="Uptime"
            value={uptimeHours > 0 ? `${uptimeHours}h` : '<1h'}
            status="healthy"
          />
          <HealthMetric
            label="Memory Usage"
            value={`${memoryMb} MB`}
            status={memoryMb > 500 ? 'warning' : 'healthy'}
          />
          <HealthMetric
            label="Active Agents"
            value={`${activeAgents.length}/${agents.length}`}
            status={activeAgents.length > 0 ? 'healthy' : 'warning'}
          />
        </div>
      </div>
      
      {/* SDD Compliance */}
      <SpecComplianceWidget />
      
      {/* Recent Activity */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-6">Recent Activity</h2>
        
        <div className="space-y-4">
          {tasks.length === 0 ? (
            <div className="text-center py-8 text-foreground-muted">
              No recent activity
            </div>
          ) : (
            tasks.slice(0, 5).map((task) => {
              const timeAgo = getTimeAgo(new Date(task.updated_at));
              const status = getActivityStatus(task.status);
              
              return (
                <ActivityItem
                  key={task.id}
                  title={`Task: ${task.title}`}
                  description={task.description}
                  time={timeAgo}
                  status={status}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

interface StatusCardProps {
  title: string;
  value: string;
  icon: ReactNode;
  trend: string;
  trendUp: boolean;
}

function StatusCard({ title, value, icon, trend, trendUp }: StatusCardProps) {
  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-foreground-secondary">{title}</span>
        {icon}
      </div>
      <div className="text-3xl font-bold text-foreground mb-2">{value}</div>
      <div className={`text-sm ${trendUp ? 'text-status-active' : 'text-foreground-muted'}`}>
        {trend}
      </div>
    </div>
  );
}

interface HealthMetricProps {
  label: string;
  value: string;
  status: 'healthy' | 'warning' | 'critical';
}

function HealthMetric({ label, value, status }: HealthMetricProps) {
  const statusColors = {
    healthy: 'text-status-active',
    warning: 'text-status-paused',
    critical: 'text-status-error',
  };
  
  return (
    <div>
      <div className="text-sm text-foreground-secondary mb-2">{label}</div>
      <div className={`text-2xl font-bold ${statusColors[status]}`}>{value}</div>
    </div>
  );
}

interface ActivityItemProps {
  title: string;
  description: string;
  time: string;
  status: 'success' | 'error' | 'warning' | 'info';
}

function ActivityItem({ title, description, time, status }: ActivityItemProps) {
  const statusIcons = {
    success: <CheckCircle2 className="w-5 h-5 text-status-completed" />,
    error: <XCircle className="w-5 h-5 text-status-error" />,
    warning: <AlertTriangle className="w-5 h-5 text-status-paused" />,
    info: <Activity className="w-5 h-5 text-status-running" />,
  };
  
  return (
    <div className="flex items-start gap-4 p-4 bg-background-elevated border border-border rounded-lg">
      {statusIcons[status]}
      <div className="flex-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-foreground-secondary mt-1 line-clamp-2">{description}</p>
        <p className="text-xs text-foreground-muted mt-2">{time}</p>
      </div>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function getActivityStatus(taskStatus: string): 'success' | 'error' | 'warning' | 'info' {
  if (taskStatus === 'completed') return 'success';
  if (taskStatus === 'failed') return 'error';
  if (taskStatus === 'awaiting_approval' || taskStatus === 'paused') return 'warning';
  return 'info';
}
