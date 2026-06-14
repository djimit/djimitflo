export interface SwarmMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: 'task_delegation' | 'status_update' | 'knowledge_share' | 'alert';
  payload: Record<string, unknown>;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  read_at: string | null;
  created_at: string;
}

class MessageBus {
  private callbacks = new Map<string, Set<(message: SwarmMessage) => void>>();

  async publish(toAgentId: string, message: SwarmMessage): Promise<void> {
    const callbacks = this.callbacks.get(toAgentId);
    if (!callbacks) return;

    for (const callback of callbacks) {
      callback(message);
    }
  }

  subscribe(agentId: string, callback: (message: SwarmMessage) => void): () => void {
    const callbacks = this.callbacks.get(agentId) ?? new Set<(message: SwarmMessage) => void>();
    callbacks.add(callback);
    this.callbacks.set(agentId, callbacks);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.callbacks.delete(agentId);
      }
    };
  }

  unsubscribe(agentId: string): void {
    this.callbacks.delete(agentId);
  }

  disconnect(): void {
    this.callbacks.clear();
  }
}

export const messageBus = new MessageBus();
