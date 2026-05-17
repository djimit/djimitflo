/**
 * Configuration types
 */

export interface DjimitfloConfig {
  // Server
  server: ServerConfig;
  
  // Database
  database: DatabaseConfig;
  
  // Execution
  execution: ExecutionConfig;
  
  // Security
  security: SecurityConfig;
  
  // Integration
  integration: IntegrationConfig;
}

export interface ServerConfig {
  host: string;
  port: number;
  cors_origins: string[];
  log_level: 'debug' | 'info' | 'warning' | 'error';
}

export interface DatabaseConfig {
  path: string;
  backup_enabled: boolean;
  backup_interval_hours: number;
}

export interface ExecutionConfig {
  default_mode: 'local' | 'dry_run' | 'review_only';
  default_timeout_ms: number;
  max_concurrent_tasks: number;
  enable_auto_approval: boolean;
}

export interface SecurityConfig {
  enable_sandbox: boolean;
  enable_approval_policies: boolean;
  enable_audit_log: boolean;
  default_risk_level: 'low' | 'medium' | 'high' | 'critical';
}

export interface IntegrationConfig {
  codex_path: string;
  opencode_path: string;
  mcp_discovery_paths: string[];
}
