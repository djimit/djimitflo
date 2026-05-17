import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { TaskPriority, ExecutionMode } from '@djimitflo/shared';

export function TasksPage() {
  const tasks = useStore((state) => state.tasks);
  const agents = useStore((state) => state.agents);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Filter tasks
  const filteredTasks = tasks.filter((task) => {
    const matchesSearch = task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         task.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || task.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Tasks</h1>
          <p className="text-foreground-secondary mt-2">
            Manage and monitor agent task execution
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors font-medium"
        >
          <Plus className="w-5 h-5" />
          New Task
        </button>
      </div>
      
      {/* Filters */}
      <div className="flex gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-foreground-muted" />
          <input
            type="text"
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-background-secondary border border-border rounded-lg text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-accent"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2 bg-background-secondary border border-border rounded-lg text-foreground focus:outline-none focus:border-accent"
        >
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
          <option value="awaiting_approval">Awaiting Approval</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      
      {/* Task List */}
      <div className="space-y-3">
        {filteredTasks.length === 0 ? (
          <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
            <p className="text-foreground-muted">
              {searchQuery || statusFilter !== 'all' ? 'No tasks match your filters' : 'No tasks yet. Create one to get started!'}
            </p>
          </div>
        ) : (
          filteredTasks.map((task) => {
            const agent = agents.find((a) => a.id === task.agent_id);
            const progress = calculateProgress(task);
            
            return (
              <TaskCard
                key={task.id}
                id={task.id}
                title={task.title}
                description={task.description}
                status={task.status}
                priority={task.priority}
                agent={agent?.name || 'Unassigned'}
                progress={progress}
              />
            );
          })
        )}
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          agents={agents}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}

interface TaskCardProps {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  agent: string;
  progress: number;
}

function TaskCard({ id, title, description, status, priority, agent, progress }: TaskCardProps) {
  const statusColors: Record<string, string> = {
    running: 'bg-status-running/10 text-status-running border-status-running/20',
    queued: 'bg-status-paused/10 text-status-paused border-status-paused/20',
    pending: 'bg-status-idle/10 text-status-idle border-status-idle/20',
    completed: 'bg-status-completed/10 text-status-completed border-status-completed/20',
    failed: 'bg-status-error/10 text-status-error border-status-error/20',
    awaiting_approval: 'bg-status-paused/10 text-status-paused border-status-paused/20',
    cancelled: 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20',
  };
  
  const priorityColors: Record<string, string> = {
    low: 'bg-risk-low/10 text-risk-low border-risk-low/20',
    medium: 'bg-risk-medium/10 text-risk-medium border-risk-medium/20',
    high: 'bg-risk-high/10 text-risk-high border-risk-high/20',
    critical: 'bg-risk-critical/10 text-risk-critical border-risk-critical/20',
  };
  
  return (
    <Link
      to={`/tasks/${id}`}
      className="block bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/30 transition-colors cursor-pointer"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <span className={`px-2 py-1 rounded text-xs font-medium border ${statusColors[status] || statusColors.pending}`}>
              {status.replace('_', ' ')}
            </span>
            <span className={`px-2 py-1 rounded text-xs font-medium border ${priorityColors[priority] || priorityColors.medium}`}>
              {priority}
            </span>
          </div>
          <p className="text-sm text-foreground-secondary line-clamp-2">{description}</p>
        </div>
      </div>
      
      <div className="flex items-center justify-between">
        <div className="text-sm text-foreground-tertiary">
          Agent: <span className="text-foreground font-medium">{agent}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-32 bg-background-elevated rounded-full h-2">
            <div
              className="bg-accent h-2 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-foreground-tertiary w-12 text-right">{progress}%</span>
        </div>
      </div>
    </Link>
  );
}

interface CreateTaskModalProps {
  agents: Array<{ id: string; name: string }>;
  onClose: () => void;
}

function CreateTaskModal({ agents, onClose }: CreateTaskModalProps) {
  const { addTask } = useStore();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.MEDIUM);
  const [agentId, setAgentId] = useState<string>('');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(ExecutionMode.REVIEW_ONLY);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description) return;

    setLoading(true);
    try {
      const task = await api.createTask({
        title,
        description,
        priority,
        execution_mode: executionMode,
        agent_id: agentId || undefined,
        tags: [],
        metadata: {},
      });
      
      addTask(task);
      onClose();
    } catch (error) {
      console.error('Failed to create task:', error);
      alert('Failed to create task. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-background-secondary border border-border rounded-lg p-6 w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-foreground mb-6">Create New Task</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-2">
              Title <span className="text-accent">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-accent"
              placeholder="e.g., Review authentication module"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-2">
              Description <span className="text-accent">*</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-accent h-24 resize-none"
              placeholder="Describe what the task should accomplish..."
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-2">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-accent"
              >
                <option value={TaskPriority.LOW}>Low</option>
                <option value={TaskPriority.MEDIUM}>Medium</option>
                <option value={TaskPriority.HIGH}>High</option>
                <option value={TaskPriority.CRITICAL}>Critical</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-2">
                Execution Mode
              </label>
              <select
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
                className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-accent"
              >
                <option value={ExecutionMode.LOCAL}>Local</option>
                <option value={ExecutionMode.DRY_RUN}>Dry Run</option>
                <option value={ExecutionMode.REVIEW_ONLY}>Review Only</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-2">
              Agent (Optional)
            </label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-4 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:border-accent"
            >
              <option value="">Auto-assign</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors font-medium disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Task'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-background-elevated text-foreground border border-border rounded-lg hover:bg-background-tertiary transition-colors font-medium"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function calculateProgress(task: { status: string; started_at: string | null; completed_at: string | null }): number {
  if (task.status === 'completed') return 100;
  if (task.status === 'failed') return 0;
  if (task.status === 'running') return 65; // Mock progress
  if (task.status === 'awaiting_approval') return 30;
  return 0;
}
