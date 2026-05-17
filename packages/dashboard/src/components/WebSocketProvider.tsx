/**
 * WebSocket Provider - Manages real-time connections and updates
 */

import { useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useStore } from '../lib/store';
import { WebSocketEventType } from '@djimitflo/shared';
import type { TaskEventPayload, AgentEventPayload, SystemHealthPayload } from '@djimitflo/shared';

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { subscribe, isConnected } = useWebSocket();
  const { updateTask, addTask, removeTask, updateAgent, setSystemHealth, setConnected } = useStore();

  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected, setConnected]);

  useEffect(() => {
    // Task events
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

    // Agent events
    const unsubAgentUpdated = subscribe(WebSocketEventType.AGENT_UPDATED, (message) => {
      const { agent } = message.payload as AgentEventPayload;
      updateAgent(agent.id, agent);
    });

    const unsubAgentStatus = subscribe(WebSocketEventType.AGENT_STATUS_CHANGED, (message) => {
      const { agent } = message.payload as AgentEventPayload;
      updateAgent(agent.id, { status: agent.status });
    });

    // System health
    const unsubSystemHealth = subscribe(WebSocketEventType.SYSTEM_HEALTH, (message) => {
      const health = message.payload as SystemHealthPayload;
      setSystemHealth(health);
    });

    // Cleanup
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
