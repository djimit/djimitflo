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
