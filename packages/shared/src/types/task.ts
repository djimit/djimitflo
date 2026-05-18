/**
 * Task-related types
 */

import {
  ID,
  Timestamps,
  TaskStatus,
  TaskPriority,
  ExecutionMode,
  RiskLevel,
} from './common';

export interface Task extends Timestamps {
  id: ID;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  risk_level: RiskLevel;
  execution_mode: ExecutionMode;
  agent_id: ID | null;
  parent_task_id: ID | null;
  repository_id: ID | null;
  instruction_profile_id: ID | null;
  
  // Execution tracking
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  
  // Metrics
  execution_time_ms: number | null;
  token_usage: number | null;

  // Ownership
  created_by: string | null;
  owner_user_id: string | null;
  updated_by: string | null;
  
  // Metadata
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface TaskArtifact extends Timestamps {
  id: ID;
  task_id: ID;
  type: ArtifactType;
  path: string;
  content: string | null;
  mime_type: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
}

export enum ArtifactType {
  FILE = 'file',
  DIFF = 'diff',
  LOG = 'log',
  SCREENSHOT = 'screenshot',
  OUTPUT = 'output',
  ERROR = 'error',
}

export interface TaskCreateInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  execution_mode?: ExecutionMode;
  agent_id?: ID;
  parent_task_id?: ID;
  repository_id?: ID;
  instruction_profile_id?: ID;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_by?: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
