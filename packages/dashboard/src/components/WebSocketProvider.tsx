import { useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useStore } from '../lib/store';
import { useAuthStore } from '../lib/auth-store';
import { WebSocketEventType } from '@djimitflo/shared';

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const { subscribe, isConnected } = useWebSocket(isAuthenticated);
  const { updateTask, addTask, removeTask, updateAgent, setSystemHealth, setConnected } = useStore();

  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected, setConnected]);

  useEffect(() => {
    // Defensive wrapper — never let a WebSocket event crash the app
    const safe = (fn: () => void) => { try { fn(); } catch (e) { console.error('[WS] event handler error:', e); } };

    const unsubTaskCreated = subscribe(WebSocketEventType.TASK_CREATED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) addTask(task); });
    });
    const unsubTaskUpdated = subscribe(WebSocketEventType.TASK_UPDATED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskDeleted = subscribe(WebSocketEventType.TASK_DELETED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) removeTask(task.id); });
    });
    const unsubTaskStarted = subscribe(WebSocketEventType.TASK_STARTED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskCompleted = subscribe(WebSocketEventType.TASK_COMPLETED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskFailed = subscribe(WebSocketEventType.TASK_FAILED, (msg) => {
      safe(() => { const task = msg?.payload?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubAgentUpdated = subscribe(WebSocketEventType.AGENT_UPDATED, (msg) => {
      safe(() => { const agent = msg?.payload?.agent; if (agent?.id) updateAgent(agent.id, agent); });
    });
    const unsubAgentStatus = subscribe(WebSocketEventType.AGENT_STATUS_CHANGED, (msg) => {
      safe(() => { const agent = msg?.payload?.agent; if (agent?.id) updateAgent(agent.id, { status: agent.status }); });
    });
    const unsubSystemHealth = subscribe(WebSocketEventType.SYSTEM_HEALTH, (msg) => {
      safe(() => { if (msg?.payload) setSystemHealth(msg.payload); });
    });

    return () => {
      unsubTaskCreated(); unsubTaskUpdated(); unsubTaskDeleted();
      unsubTaskStarted(); unsubTaskCompleted(); unsubTaskFailed();
      unsubAgentUpdated(); unsubAgentStatus(); unsubSystemHealth();
    };
  }, [subscribe, addTask, updateTask, removeTask, updateAgent, setSystemHealth]);

  return <>{children}</>;
}
