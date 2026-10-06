/**
 * Agent-related types
 */

import { ID, Timestamps, AgentStatus, AgentCapability } from './common';

export interface Agent extends Timestamps {
  id: ID;
  name: string;
  description: string;
  status: AgentStatus;
  capabilities: AgentCapability[];
  instruction_profile_id: ID | null;
  
  // Configuration
  model: string | null;
  temperature: number | null;
  max_tokens: number | null;
  
  // Metrics
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_execution_time_ms: number;
  total_token_usage: number;
  
  // State
  current_task_id: ID | null;
  last_active_at: string | null;
  retired_at?: string | null;
  retirement_reason?: string | null;
  /** Derived by GET /api/agents (plan I0): recent activity or an ONLINE registry node; `status` itself never decays. */
  liveness?: 'live' | 'stale' | 'unknown';
  last_seen_at?: string | null;
  /** UX-14: where the agent is between 'registered' and 'connected and talking', with the evidence for it. */
  connection_state?: 'enrolled' | 'token_issued' | 'first_heartbeat' | 'first_reply' | 'live' | 'lapsed' | 'dormant' | 'retired' | null;
  connection_reason?: string | null;
  /** Public Telegram handle of the agent's bot (no token), set via PATCH /api/agents/:id/telegram. */
  telegram_bot_name?: string | null;
  
  // Metadata
  metadata: Record<string, unknown>;
}

export interface AgentCreateInput {
  name: string;
  description: string;
  capabilities?: AgentCapability[];
  instruction_profile_id?: ID;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentUpdateInput {
  name?: string;
  description?: string;
  status?: AgentStatus;
  capabilities?: AgentCapability[];
  instruction_profile_id?: ID;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
}
