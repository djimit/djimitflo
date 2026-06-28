import { useEffect } from 'react';
import { Bot, Activity, XCircle, Clock } from 'lucide-react';
import { useStore } from '../lib/store'
import { api } from '../lib/api';

export function AgentsPage() {
  const agents = useStore((state) => state.agents);
  const tasks = useStore((state) => state.tasks);

  // D4: REST fallback — load agents via API when WebSocket store is empty.
  useEffect(() => {
    if (agents.length === 0) {
      api.getAgents().then((res) => useStore.setState({ agents: res.agents })).catch(() => {});
    }
  }, []);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-foreground">Agents</h1>
        <p className="text-foreground-secondary mt-2">
          Manage and monitor your AI agents
        </p>
      </div>
      
      {/* Agent Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {agents.length === 0 ? (
          <div className="col-span-2 bg-background-secondary border border-border rounded-lg p-12 text-center">
            <p className="text-foreground-muted">No agents configured</p>
          </div>
        ) : (
          agents.map((agent) => {
            const agentTasks = tasks.filter((t) => t.agent_id === agent.id);
            const currentTask = agentTasks.find((t) => t.status === 'running');
            
            return (
              <AgentCard
                key={agent.id}
                name={agent.name}
                description={agent.description}
                status={agent.status}
                currentTask={currentTask?.title || null}
                totalTasks={agent.total_tasks}
                completedTasks={agent.completed_tasks}
                failedTasks={agent.failed_tasks}
                capabilities={agent.capabilities}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

interface AgentCardProps {
  name: string;
  description: string;
  status: 'active' | 'idle' | 'error' | 'offline' | 'paused';
  currentTask: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  capabilities: string[];
}

function AgentCard({
  name,
  description,
  status,
  currentTask,
  totalTasks,
  completedTasks,
  failedTasks,
  capabilities,
}: AgentCardProps) {
  const statusConfig = {
    active: {
      color: 'bg-status-active/10 text-status-active border-status-active/20',
      icon: <Activity className="w-4 h-4" />,
    },
    idle: {
      color: 'bg-status-idle/10 text-status-idle border-status-idle/20',
      icon: <Clock className="w-4 h-4" />,
    },
    paused: {
      color: 'bg-status-paused/10 text-status-paused border-status-paused/20',
      icon: <Clock className="w-4 h-4" />,
    },
    error: {
      color: 'bg-status-error/10 text-status-error border-status-error/20',
      icon: <XCircle className="w-4 h-4" />,
    },
    offline: {
      color: 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20',
      icon: <XCircle className="w-4 h-4" />,
    },
  };
  
  const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  
  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent/10 rounded-lg">
            <Bot className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">{name}</h3>
            <p className="text-sm text-foreground-secondary mt-1">{description}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-2 ${statusConfig[status].color}`}>
          {statusConfig[status].icon}
          {status}
        </span>
      </div>
      
      {/* Current Task */}
      {currentTask && (
        <div className="mb-4 p-3 bg-background-elevated border border-border rounded-lg">
          <div className="text-xs text-foreground-tertiary mb-1">Current Task</div>
          <div className="text-sm text-foreground font-medium">{currentTask}</div>
        </div>
      )}
      
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-2xl font-bold text-foreground">{totalTasks}</div>
          <div className="text-xs text-foreground-tertiary">Total</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-status-completed">{completedTasks}</div>
          <div className="text-xs text-foreground-tertiary">Completed</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-status-error">{failedTasks}</div>
          <div className="text-xs text-foreground-tertiary">Failed</div>
        </div>
      </div>
      
      {/* Success Rate */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-foreground-secondary">Success Rate</span>
          <span className="text-foreground font-semibold">{successRate}%</span>
        </div>
        <div className="w-full bg-background-elevated rounded-full h-2">
          <div
            className="bg-status-completed h-2 rounded-full transition-all"
            style={{ width: `${successRate}%` }}
          />
        </div>
      </div>
      
      {/* Capabilities */}
      <div>
        <div className="text-xs text-foreground-tertiary mb-2">Capabilities</div>
        <div className="flex flex-wrap gap-2">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="px-2 py-1 bg-background-elevated text-foreground-secondary text-xs rounded border border-border"
            >
              {formatCapability(cap)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatCapability(cap: string): string {
  return cap
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
