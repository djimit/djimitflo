import { useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useStore } from '../lib/store';
import { useAuthStore } from '../lib/auth-store';
import { WebSocketEventType } from '@djimitflo/shared';
import type { TaskEventPayload, AgentEventPayload, SystemHealthPayload } from '@djimitflo/shared';

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const { subscribe, isConnected } = useWebSocket(isAuthenticated);
  const { updateTask, addTask, removeTask, updateAgent, setSystemHealth, setConnected } = useStore();

  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected, setConnected]);

  useEffect(() => {
    const unsubTaskCreated = subscribe(WebSocketEventType.TASK_CREATED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      addTask(task);
    });

    const unsubTaskUpdated = subscribe(WebSocketEventType.TASK_UPDATED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      updateTask(task.id, task);
    });

    const unsubTaskDeleted = subscribe(WebSocketEventType.TASK_DELETED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      removeTask(task.id);
    });

    const unsubTaskStarted = subscribe(WebSocketEventType.TASK_STARTED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      updateTask(task.id, task);
    });

    const unsubTaskCompleted = subscribe(WebSocketEventType.TASK_COMPLETED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      updateTask(task.id, task);
    });

    const unsubTaskFailed = subscribe(WebSocketEventType.TASK_FAILED, (message) => {
      const { task } = message.payload as TaskEventPayload;
      updateTask(task.id, task);
    });

    const unsubAgentUpdated = subscribe(WebSocketEventType.AGENT_UPDATED, (message) => {
      const { agent } = message.payload as AgentEventPayload;
      updateAgent(agent.id, agent);
    });

    const unsubAgentStatus = subscribe(WebSocketEventType.AGENT_STATUS_CHANGED, (message) => {
      const { agent } = message.payload as AgentEventPayload;
      updateAgent(agent.id, { status: agent.status });
    });

    const unsubSystemHealth = subscribe(WebSocketEventType.SYSTEM_HEALTH, (message) => {
      const health = message.payload as SystemHealthPayload;
      setSystemHealth(health);
    });

    return () => {
      unsubTaskCreated();
      unsubTaskUpdated();
      unsubTaskDeleted();
      unsubTaskStarted();
      unsubTaskCompleted();
      unsubTaskFailed();
      unsubAgentUpdated();
      unsubAgentStatus();
      unsubSystemHealth();
    };
  }, [subscribe, addTask, updateTask, removeTask, updateAgent, setSystemHealth]);

  return <>{children}</>;
}