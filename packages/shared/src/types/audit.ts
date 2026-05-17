/**
 * Audit-related types
 */

import { ID, Timestamps, AuditEventType, RiskLevel } from './common';

export interface AuditEvent extends Timestamps {
  id: ID;
  event_type: AuditEventType;
  timestamp: string; // ISO 8601
  
  // Actor
  user_id: string | null; // "system" for automated actions
  agent_id: ID | null;
  
  // Context
  task_id: ID | null;
  execution_event_id: ID | null;
  
  // Event details
  action: string;
  resource_type: string;
  resource_id: ID | null;
  risk_level: RiskLevel;
  
  // Changes
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  
  // Metadata
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditEventCreateInput {
  event_type: AuditEventType;
  user_id?: string;
  agent_id?: ID;
  task_id?: ID;
  execution_event_id?: ID;
  action: string;
  resource_type: string;
  resource_id?: ID;
  risk_level?: RiskLevel;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditQuery {
  event_types?: AuditEventType[];
  user_id?: string;
  agent_id?: ID;
  task_id?: ID;
  resource_type?: string;
  risk_level?: RiskLevel;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}
