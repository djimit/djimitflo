/**
 * MCP (Model Context Protocol) related types
 */

import {
  ID,
  Timestamps,
  MCPServerStatus,
  MCPToolPermission,
  RiskLevel,
} from './common';

export interface MCPServer extends Timestamps {
  id: ID;
  name: string;
  description: string;
  status: MCPServerStatus;
  command: string;
  args: string[];
  env: Record<string, string>;
  
  // Metadata
  version: string | null;
  author: string | null;
  url: string | null;
  
  // State
  last_ping_at: string | null;
  error_message: string | null;
  
  metadata: Record<string, unknown>;
}

export interface MCPTool extends Timestamps {
  id: ID;
  server_id: ID;
  name: string;
  description: string;
  permission: MCPToolPermission;
  risk_level: RiskLevel;
  
  // Schema
  input_schema: Record<string, unknown>;
  
  // Usage tracking
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  last_called_at: string | null;
  
  metadata: Record<string, unknown>;
}

export interface MCPServerCreateInput {
  name: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  version?: string;
  author?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface MCPToolUpdateInput {
  permission?: MCPToolPermission;
  risk_level?: RiskLevel;
  metadata?: Record<string, unknown>;
}
