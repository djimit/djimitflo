/**
 * Zustand store for global state management
 */

import { create } from 'zustand';
import type { Task, Agent, TaskStatus } from '@djimitflo/shared';

interface DjimitfloState {
  // Tasks
  tasks: Task[];
  selectedTask: Task | null;
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  removeTask: (id: string) => void;
  selectTask: (task: Task | null) => void;

  // Agents
  agents: Agent[];
  selectedAgent: Agent | null;
  setAgents: (agents: Agent[]) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  selectAgent: (agent: Agent | null) => void;

  // System
  systemHealth: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime_ms: number;
    active_tasks: number;
    active_agents: number;
  };
  setSystemHealth: (health: Partial<DjimitfloState['systemHealth']>) => void;

  // WebSocket
  isConnected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useStore = create<DjimitfloState>((set) => ({
  // Tasks
  tasks: [],
  selectedTask: null,
  setTasks: (tasks) => set({ tasks: Array.isArray(tasks) ? tasks : [] }),
  addTask: (task) => set((state) => ({ tasks: [...state.tasks, task] })),
  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      selectedTask: state.selectedTask?.id === id
        ? { ...state.selectedTask, ...updates }
        : state.selectedTask,
    })),
  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTask: state.selectedTask?.id === id ? null : state.selectedTask,
    })),
  selectTask: (task) => set({ selectedTask: task }),

  // Agents
  agents: [],
  selectedAgent: null,
  setAgents: (agents) => set({ agents: Array.isArray(agents) ? agents : [] }),
  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
      selectedAgent: state.selectedAgent?.id === id
        ? { ...state.selectedAgent, ...updates }
        : state.selectedAgent,
    })),
  selectAgent: (agent) => set({ selectedAgent: agent }),

  // System
  systemHealth: {
    status: 'healthy',
    uptime_ms: 0,
    active_tasks: 0,
    active_agents: 0,
  },
  setSystemHealth: (health) =>
    set((state) => ({
      systemHealth: { ...state.systemHealth, ...health },
    })),

  // WebSocket
  isConnected: false,
  setConnected: (connected) => set({ isConnected: connected }),
}));

// Computed selectors
export const selectTasksByStatus = (status: TaskStatus) => (state: DjimitfloState) =>
  state.tasks.filter((t) => t.status === status);

export const selectActiveTasks = (state: DjimitfloState) =>
  state.tasks.filter((t) => ['running', 'queued', 'pending'].includes(t.status));

export const selectCompletedTasks = (state: DjimitfloState) =>
  state.tasks.filter((t) => t.status === 'completed');

export const selectFailedTasks = (state: DjimitfloState) =>
  state.tasks.filter((t) => t.status === 'failed');

export const selectActiveAgents = (state: DjimitfloState) =>
  state.agents.filter((a) => a.status === 'active');
