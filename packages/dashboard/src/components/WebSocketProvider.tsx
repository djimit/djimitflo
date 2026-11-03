import { createContext, useContext, useEffect, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useStore } from '../lib/store';
import { useAuthStore } from '../lib/auth-store';
import { WebSocketEventType } from '@djimitflo/shared';
import type { Agent, SystemHealthPayload, Task, WebSocketMessage } from '@djimitflo/shared';

type Subscribe = (eventType: WebSocketEventType | 'all', handler: (message: WebSocketMessage) => void) => () => void;
/** UX-3: the session's one socket, shared — pages subscribe through this instead of opening their own. */
export const WsContext = createContext<{ subscribe: Subscribe; isConnected: boolean }>({ subscribe: () => () => undefined, isConnected: false });
export const useWsSubscribe = (): Subscribe => useContext(WsContext).subscribe;

/** UX-3: says when live updates are off (after a short grace period, so a normal connect does not flash it). */
export function ConnectionBanner({ graceMs = 10_000 }: { graceMs?: number }) {
  const { isConnected } = useContext(WsContext);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (isConnected) { setShow(false); return undefined; }
    const t = setTimeout(() => setShow(true), graceMs);
    return () => clearTimeout(t);
  }, [isConnected, graceMs]);
  if (!show) return null;
  return <div role="status" className="px-4 py-2 text-sm border-b border-border text-status-warning">Live updates are off — the connection to the server dropped. Pages still refresh on their own timer.</div>;
}

type TaskPayload = { task?: Task };
type AgentPayload = { agent?: Agent };

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
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) addTask(task); });
    });
    const unsubTaskUpdated = subscribe(WebSocketEventType.TASK_UPDATED, (msg) => {
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskDeleted = subscribe(WebSocketEventType.TASK_DELETED, (msg) => {
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) removeTask(task.id); });
    });
    const unsubTaskStarted = subscribe(WebSocketEventType.TASK_STARTED, (msg) => {
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskCompleted = subscribe(WebSocketEventType.TASK_COMPLETED, (msg) => {
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubTaskFailed = subscribe(WebSocketEventType.TASK_FAILED, (msg) => {
      safe(() => { const task = (msg?.payload as TaskPayload | undefined)?.task; if (task?.id) updateTask(task.id, task); });
    });
    const unsubAgentUpdated = subscribe(WebSocketEventType.AGENT_UPDATED, (msg) => {
      safe(() => { const agent = (msg?.payload as AgentPayload | undefined)?.agent; if (agent?.id) updateAgent(agent.id, agent); });
    });
    const unsubAgentStatus = subscribe(WebSocketEventType.AGENT_STATUS_CHANGED, (msg) => {
      safe(() => { const agent = (msg?.payload as AgentPayload | undefined)?.agent; if (agent?.id) updateAgent(agent.id, { status: agent.status }); });
    });
    const unsubSystemHealth = subscribe(WebSocketEventType.SYSTEM_HEALTH, (msg) => {
      safe(() => { if (msg?.payload) setSystemHealth(msg.payload as Partial<SystemHealthPayload>); });
    });

    return () => {
      unsubTaskCreated(); unsubTaskUpdated(); unsubTaskDeleted();
      unsubTaskStarted(); unsubTaskCompleted(); unsubTaskFailed();
      unsubAgentUpdated(); unsubAgentStatus(); unsubSystemHealth();
    };
  }, [subscribe, addTask, updateTask, removeTask, updateAgent, setSystemHealth]);

  return <WsContext.Provider value={{ subscribe, isConnected }}>{children}</WsContext.Provider>;
}
