import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../lib/store";
import { useWebSocket } from "../hooks/useWebSocket";
import { WebSocketEventType } from "@djimitflo/shared";
import { api } from "../lib/api";
import { Users, Activity, Zap, Clock, AlertCircle, Brain, Server, TrendingUp, MessageSquare, Lightbulb } from "lucide-react";
import type { Agent, Task } from "@djimitflo/shared";

interface Discussion {
  id: string;
  topic: string;
  status: "open" | "closed" | "archived";
  proposal_count?: number;
  vote_count?: number;
}

interface Learning {
  id: string;
  title: string;
  category: string;
  description: string;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getDiscussionStatusColor(status: string) {
  switch (status) {
    case "open": return "bg-blue-100 text-blue-700";
    case "closed": return "bg-emerald-100 text-emerald-700";
    case "archived": return "bg-slate-100 text-slate-600";
    default: return "bg-gray-100 text-gray-600";
  }
}

function getLearningCategoryColor(category: string) {
  switch (category) {
    case "pattern": return "bg-blue-100 text-blue-700";
    case "anti_pattern": return "bg-red-100 text-red-700";
    case "optimization": return "bg-emerald-100 text-emerald-700";
    case "security": return "bg-orange-100 text-orange-700";
    case "workflow": return "bg-purple-100 text-purple-700";
    case "tool_usage": return "bg-teal-100 text-teal-700";
    case "communication": return "bg-pink-100 text-pink-700";
    default: return "bg-gray-100 text-gray-600";
  }
}

export function SwarmOverviewPage() {
  const [swarmStatus, setSwarmStatus] = useState<any>(null);
  const [capabilities, setCapabilities] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.getSwarmStatus().catch(() => null),
      api.getSwarmCapabilities().catch(() => ({ capabilities: [] })),
    ]).then(([status, caps]: any) => {
      setSwarmStatus(status);
      setCapabilities(caps.capabilities || []);
    });
  }, []);
  const navigate = useNavigate();
  const { agents, tasks } = useStore();
  const [localAgents, setLocalAgents] = useState<Agent[]>([]);
  const [localTasks, setLocalTasks] = useState<Task[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket(true);

  const fetchData = useCallback(async () => {
    try {
      const [agentsRes, tasksRes] = await Promise.all([
        api.getAgents(),
        api.getTasks(),
      ]);
      setLocalAgents(agentsRes.agents || []);
      setLocalTasks(tasksRes.tasks || []);
    } catch (err) {
      console.error("Failed to fetch swarm data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDiscussions = useCallback(async () => {
    try {
      const res = await api.request<any>("/discussions?limit=10");
      setDiscussions(res.data || res || []);
    } catch (err) {
      console.error("Failed to fetch discussions:", err);
    }
  }, []);

  const fetchLearnings = useCallback(async () => {
    try {
      // NOTE: /learning endpoint does not exist yet — backend TBD
      const res = await api.request<any>("/learning?limit=5");
      setLearnings(res.data || res || []);
    } catch (err) {
      console.error("Failed to fetch learnings:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Discussions auto-refresh every 10s
  useEffect(() => {
    fetchDiscussions();
    const interval = setInterval(fetchDiscussions, 10000);
    return () => clearInterval(interval);
  }, [fetchDiscussions]);

  useEffect(() => {
    fetchLearnings();
  }, [fetchLearnings]);

  // WebSocket event handlers
  useEffect(() => {
    const unsubAgentStatus = subscribe(WebSocketEventType.AGENT_STATUS_CHANGED, (message) => {
      const { agent } = message.payload as { agent: Agent };
      setLocalAgents(prevAgents =>
        prevAgents.map(a => a.id === agent.id ? { ...a, ...agent } : a)
      );
    });

    const unsubTaskCreated = subscribe(WebSocketEventType.TASK_CREATED, (message) => {
      const { task } = message.payload as { task: Task };
      setLocalTasks(prevTasks => [task, ...prevTasks]);
    });

    const unsubTaskCompleted = subscribe(WebSocketEventType.TASK_COMPLETED, (message) => {
      const { task } = message.payload as { task: Task };
      setLocalTasks(prevTasks =>
        prevTasks.map(t => t.id === task.id ? { ...t, ...task } : t)
      );
    });

    const unsubTaskFailed = subscribe(WebSocketEventType.TASK_FAILED, (message) => {
      const { task } = message.payload as { task: Task };
      setLocalTasks(prevTasks =>
        prevTasks.map(t => t.id === task.id ? { ...t, ...task } : t)
      );
    });

    // Discussion WebSocket subscriptions
    const unsubDiscussionCreated = subscribe("DISCUSSION_CREATED" as WebSocketEventType, (message) => {
      const discussion = message.payload as unknown as Discussion;
      setDiscussions(prev => [discussion, ...prev]);
    });

    const unsubProposalAdded = subscribe("PROPOSAL_ADDED" as WebSocketEventType, (message) => {
      const { discussion_id } = message.payload as unknown as { discussion_id: string };
      setDiscussions(prev =>
        prev.map(d => d.id === discussion_id ? { ...d, proposal_count: (d.proposal_count || 0) + 1 } : d)
      );
    });

    const unsubVoteCast = subscribe("VOTE_CAST" as WebSocketEventType, (message) => {
      const { discussion_id } = message.payload as unknown as { discussion_id: string };
      setDiscussions(prev =>
        prev.map(d => d.id === discussion_id ? { ...d, vote_count: (d.vote_count || 0) + 1 } : d)
      );
    });

    return () => {
      unsubAgentStatus();
      unsubTaskCreated();
      unsubTaskCompleted();
      unsubTaskFailed();
      unsubDiscussionCreated();
      unsubProposalAdded();
      unsubVoteCast();
    };
  }, [subscribe]);

  // Sync with store when it updates
  useEffect(() => {
    if (agents.length > 0) {
      setLocalAgents(agents);
    }
  }, [agents]);

  useEffect(() => {
    if (tasks.length > 0) {
      setLocalTasks(tasks);
    }
  }, [tasks]);

  const activeAgents = localAgents.filter(a => a.status === "active");
  const idleAgents = localAgents.filter(a => a.status === "idle");
  const errorAgents = localAgents.filter(a => a.status === "error");
  const totalTasks = localAgents.reduce((sum, a) => sum + (a.total_tasks || 0), 0);
  const totalTokens = localAgents.reduce((sum, a) => sum + (a.total_token_usage || 0), 0);
  const totalExecTime = localAgents.reduce((sum, a) => sum + (a.total_execution_time_ms || 0), 0);
  const completedTasks = localTasks.filter(t => t.status === "completed");
  const failedTasks = localTasks.filter(t => t.status === "failed");

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-emerald-100 text-emerald-700";
      case "idle": return "bg-slate-100 text-slate-600";
      case "error": return "bg-red-100 text-red-700";
      default: return "bg-gray-100 text-gray-600";
    }
  };

  const getTaskStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "bg-emerald-50 text-emerald-600";
      case "failed": return "bg-red-50 text-red-600";
      case "running": return "bg-blue-50 text-blue-600";
      case "pending": return "bg-amber-50 text-amber-600";
      default: return "bg-gray-50 text-gray-600";
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Brain className="w-7 h-7 text-indigo-600" />
          Swarm Overview
        </h1>
        <p className="text-slate-500 mt-1">Real-time swarm metrics and agent status</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-5 h-5 text-indigo-600" />
            <span className="text-sm font-medium text-slate-600">Active Agents</span>
          </div>
          <div className="text-3xl font-bold text-slate-900">{activeAgents.length}</div>
          <div className="text-xs text-slate-500 mt-1">{idleAgents.length} idle · {errorAgents.length} error</div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-5 h-5 text-emerald-600" />
            <span className="text-sm font-medium text-slate-600">Total Tasks</span>
          </div>
          <div className="text-3xl font-bold text-slate-900">{formatNumber(totalTasks)}</div>
          <div className="text-xs text-slate-500 mt-1">{completedTasks.length} completed · {failedTasks.length} failed</div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-5 h-5 text-amber-600" />
            <span className="text-sm font-medium text-slate-600">Token Usage</span>
          </div>
          <div className="text-3xl font-bold text-slate-900">{formatNumber(totalTokens)}</div>
          <div className="text-xs text-slate-500 mt-1">Cumulative across all agents</div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-5 h-5 text-blue-600" />
            <span className="text-sm font-medium text-slate-600">Exec Time</span>
          </div>
          <div className="text-3xl font-bold text-slate-900">{formatDuration(totalExecTime)}</div>
          <div className="text-xs text-slate-500 mt-1">Total execution time</div>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <Server className="w-5 h-5" />
          Agents ({localAgents.length})
        </h2>
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading agents…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {localAgents.map(agent => (
              <div
                key={agent.id}
                className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => navigate(`/agents/${agent.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-slate-900">{agent.name}</h3>
                    <p className="text-xs text-slate-500">{agent.model || "No model"}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(agent.status)}`}>
                    {agent.status}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-lg font-bold text-slate-900">{agent.total_tasks || 0}</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">Tasks</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-slate-900">{formatNumber(agent.total_token_usage || 0)}</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">Tokens</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-slate-900">{formatDuration(agent.total_execution_time_ms || 0)}</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider">Time</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Task Timeline */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <TrendingUp className="w-5 h-5" />
          Recent Tasks ({localTasks.length})
        </h2>
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading tasks…</div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Title</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Agent</th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">Tokens</th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {localTasks.map(task => {
                    const agent = localAgents.find(a => a.id === task.agent_id);
                    return (
                      <tr key={task.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 truncate max-w-[200px]">{task.title}</div>
                          <div className="text-xs text-slate-500">{task.priority || "normal"}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${getTaskStatusColor(task.status)}`}>
                            {task.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{agent?.name || task.agent_id}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-600">{formatNumber(task.token_usage || 0)}</td>
                        <td className="px-4 py-3 text-right font-mono text-slate-600">{formatDuration(task.execution_time_ms || 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Discussions Panel */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <MessageSquare className="w-5 h-5" />
          Discussions ({discussions.length})
        </h2>
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
          {discussions.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">No discussions yet</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
              {discussions.map(d => (
                <div
                  key={d.id}
                  className="border border-slate-200 rounded-lg p-4 hover:shadow-sm transition-shadow"
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-medium text-slate-900 text-sm leading-snug">{d.topic}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getDiscussionStatusColor(d.status)}`}>
                      {d.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500">
                    <span>{d.proposal_count ?? 0} proposals</span>
                    <span>{d.vote_count ?? 0} votes</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Learning Feed */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <Lightbulb className="w-5 h-5" />
          Learning Feed ({learnings.length})
        </h2>
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
          {learnings.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">No learnings yet</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {learnings.map(l => (
                <div key={l.id} className="p-4 hover:bg-slate-50 transition-colors">
                  <div className="flex items-start justify-between mb-1">
                    <h3 className="font-medium text-slate-900 text-sm">{l.title}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getLearningCategoryColor(l.category)}`}>
                      {l.category}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 line-clamp-2">{l.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {errorAgents.length > 0 && (
        <div className="mt-8 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-red-800">{errorAgents.length} agent(s) in error state</h3>
            <p className="text-sm text-red-600 mt-1">
              {errorAgents.map(a => a.name).join(", ")} — check logs for details.
            </p>
          </div>
        </div>
      )}
      {/* D5: Swarm Status + Capabilities */}
      {swarmStatus && (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">Fleet Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-3 bg-background-elevated rounded-lg">
              <div className="text-2xl font-bold text-foreground">{swarmStatus.resource_snapshot?.cpu_threads || '—'}</div>
              <div className="text-xs text-foreground-tertiary">CPU Threads</div>
            </div>
            <div className="text-center p-3 bg-background-elevated rounded-lg">
              <div className="text-2xl font-bold text-foreground">{Math.round((swarmStatus.resource_snapshot?.total_memory_bytes || 0) / 1e9)}GB</div>
              <div className="text-xs text-foreground-tertiary">Total RAM</div>
            </div>
            <div className="text-center p-3 bg-background-elevated rounded-lg">
              <div className="text-2xl font-bold text-status-active">{Math.round((swarmStatus.resource_snapshot?.free_memory_bytes || 0) / 1e9)}GB</div>
              <div className="text-xs text-foreground-tertiary">Free RAM</div>
            </div>
            <div className="text-center p-3 bg-background-elevated rounded-lg">
              <div className="text-2xl font-bold text-foreground">{(swarmStatus.fleet_pools || []).length}</div>
              <div className="text-xs text-foreground-tertiary">Runtime Pools</div>
            </div>
          </div>
          {(swarmStatus.fleet_pools || []).length > 0 && (
            <div className="mt-4 space-y-2">
              {swarmStatus.fleet_pools.map((pool: any) => (
                <div key={pool.runtime} className="flex items-center justify-between p-3 bg-background-elevated rounded-lg border border-border text-sm">
                  <span className="font-mono text-foreground">{pool.runtime}</span>
                  <span className="text-foreground-secondary">concurrency: {pool.recommended_concurrency}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {capabilities.length > 0 && (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">Capabilities ({capabilities.length})</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {capabilities.slice(0, 12).map((cap: any) => (
              <div key={cap.id} className="p-4 bg-background-elevated rounded-lg border border-border">
                <div className="font-mono text-sm text-foreground truncate">{cap.id?.slice(0, 20)}</div>
                <div className="flex items-center gap-2 mt-2">
                  <span className="px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent-secondary">{cap.status}</span>
                  <span className="text-xs text-foreground-tertiary">{cap.kind}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}