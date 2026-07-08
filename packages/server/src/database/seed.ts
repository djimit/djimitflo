/**
 * Database seed script - populate with mock data for testing
 */

import { randomUUID } from 'crypto';
import { initializeDatabase } from './index';
import {
  TaskStatus,
  TaskPriority,
  ExecutionMode,
  RiskLevel,
  AgentStatus,
  AgentCapability,
  ExecutionEventType,
  LogLevel,
  ApprovalStatus,
  ApprovalRequestType,
} from '@djimitflo/shared';

function seed() {
  console.log('🌱 Seeding database...');
  const db = initializeDatabase();

  // Create agents
  const agents = [
    {
      id: randomUUID(),
      name: 'CodeReviewer',
      description: 'Reviews code for security, performance, and best practices',
      status: AgentStatus.ACTIVE,
      capabilities: JSON.stringify([
        AgentCapability.CODE_REVIEW,
        AgentCapability.CODE_GENERATION,
      ]),
      model: 'claude-sonnet-4',
      temperature: 0.7,
      max_tokens: 4096,
      total_tasks: 47,
      completed_tasks: 42,
      failed_tasks: 2,
      total_execution_time_ms: 1240000,
      total_token_usage: 125000,
      last_active_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      name: 'TestRunner',
      description: 'Executes test suites and generates coverage reports',
      status: AgentStatus.IDLE,
      capabilities: JSON.stringify([AgentCapability.TESTING]),
      model: 'gpt-4',
      temperature: 0.3,
      max_tokens: 2048,
      total_tasks: 134,
      completed_tasks: 128,
      failed_tasks: 4,
      total_execution_time_ms: 890000,
      total_token_usage: 89000,
      last_active_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      name: 'DeploymentBot',
      description: 'Automates deployment workflows with safety checks',
      status: AgentStatus.ACTIVE,
      capabilities: JSON.stringify([AgentCapability.DEPLOYMENT, AgentCapability.SHELL_COMMANDS]),
      model: 'claude-opus-4',
      temperature: 0.5,
      max_tokens: 8192,
      total_tasks: 89,
      completed_tasks: 85,
      failed_tasks: 1,
      total_execution_time_ms: 2140000,
      total_token_usage: 234000,
      last_active_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      name: 'DocGenerator',
      description: 'Generates and maintains technical documentation',
      status: AgentStatus.IDLE,
      capabilities: JSON.stringify([AgentCapability.CODE_GENERATION, AgentCapability.FILE_OPERATIONS]),
      model: 'gpt-4-turbo',
      temperature: 0.8,
      max_tokens: 4096,
      total_tasks: 23,
      completed_tasks: 23,
      failed_tasks: 0,
      total_execution_time_ms: 450000,
      total_token_usage: 67000,
      last_active_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      metadata: JSON.stringify({}),
    },
  ];

  agents.forEach((agent) => {
    db.prepare(`
      INSERT INTO agents (
        id, name, description, status, capabilities, model, temperature, max_tokens,
        total_tasks, completed_tasks, failed_tasks, total_execution_time_ms,
        total_token_usage, last_active_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description,
      agent.status,
      agent.capabilities,
      agent.model,
      agent.temperature,
      agent.max_tokens,
      agent.total_tasks,
      agent.completed_tasks,
      agent.failed_tasks,
      agent.total_execution_time_ms,
      agent.total_token_usage,
      agent.last_active_at,
      agent.metadata
    );
  });

  console.log(`✓ Created ${agents.length} agents`);

  // Create tasks
  const tasks = [
    {
      id: randomUUID(),
      title: 'Code review: Authentication module',
      description: 'Review pull request #234 for security vulnerabilities and best practices',
      status: TaskStatus.RUNNING,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.MEDIUM,
      execution_mode: ExecutionMode.LOCAL,
      agent_id: agents[0].id,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      tags: JSON.stringify(['security', 'code-review', 'auth']),
      metadata: JSON.stringify({ pr_number: 234 }),
    },
    {
      id: randomUUID(),
      title: 'Run unit tests for payment service',
      description: 'Execute full test suite and generate coverage report',
      status: TaskStatus.QUEUED,
      priority: TaskPriority.MEDIUM,
      risk_level: RiskLevel.LOW,
      execution_mode: ExecutionMode.LOCAL,
      agent_id: agents[1].id,
      tags: JSON.stringify(['testing', 'payment']),
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      title: 'Deploy staging environment',
      description: 'Deploy latest changes to staging with health checks',
      status: TaskStatus.AWAITING_APPROVAL,
      priority: TaskPriority.CRITICAL,
      risk_level: RiskLevel.HIGH,
      execution_mode: ExecutionMode.LOCAL,
      agent_id: agents[2].id,
      started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      tags: JSON.stringify(['deployment', 'staging']),
      metadata: JSON.stringify({ environment: 'staging' }),
    },
    {
      id: randomUUID(),
      title: 'Generate API documentation',
      description: 'Update OpenAPI specs and generate client SDKs',
      status: TaskStatus.COMPLETED,
      priority: TaskPriority.LOW,
      risk_level: RiskLevel.LOW,
      execution_mode: ExecutionMode.LOCAL,
      agent_id: agents[3].id,
      started_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      completed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      execution_time_ms: 1800000,
      token_usage: 12000,
      tags: JSON.stringify(['documentation', 'api']),
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      title: 'Database migration',
      description: 'Apply pending schema changes to production',
      status: TaskStatus.FAILED,
      priority: TaskPriority.HIGH,
      risk_level: RiskLevel.CRITICAL,
      execution_mode: ExecutionMode.LOCAL,
      agent_id: agents[2].id,
      started_at: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
      failed_at: new Date(Date.now() - 110 * 60 * 1000).toISOString(),
      execution_time_ms: 600000,
      tags: JSON.stringify(['database', 'migration']),
      metadata: JSON.stringify({ error: 'Connection timeout' }),
    },
    {
      id: randomUUID(),
      title: 'Refactor user authentication flow',
      description: 'Improve session management and add MFA support',
      status: TaskStatus.PENDING,
      priority: TaskPriority.MEDIUM,
      risk_level: RiskLevel.MEDIUM,
      execution_mode: ExecutionMode.REVIEW_ONLY,
      agent_id: null,
      tags: JSON.stringify(['refactoring', 'auth', 'security']),
      metadata: JSON.stringify({}),
    },
  ];

  tasks.forEach((task) => {
    db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, risk_level, execution_mode,
        agent_id, started_at, completed_at, failed_at, execution_time_ms,
        token_usage, tags, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.risk_level,
      task.execution_mode,
      task.agent_id,
      task.started_at || null,
      task.completed_at || null,
      task.failed_at || null,
      task.execution_time_ms || null,
      task.token_usage || null,
      task.tags,
      task.metadata
    );
  });

  console.log(`✓ Created ${tasks.length} tasks`);

  // Create execution events for running task
  const runningTask = tasks[0];
  const executionEvents = [
    {
      id: randomUUID(),
      task_id: runningTask.id,
      event_type: ExecutionEventType.TASK_STARTED,
      timestamp: runningTask.started_at!,
      message: 'Task execution started',
      level: LogLevel.INFO,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      tool_error: null,
      approval_id: null,
      artifact_id: null,
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      task_id: runningTask.id,
      event_type: ExecutionEventType.TOOL_CALL,
      timestamp: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      message: 'Reading authentication module files',
      level: LogLevel.INFO,
      tool_name: 'read_file',
      tool_input: JSON.stringify({ path: 'src/auth/index.ts' }),
      tool_output: JSON.stringify({ content: '// Auth module code...' }),
      tool_error: null,
      approval_id: null,
      artifact_id: null,
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      task_id: runningTask.id,
      event_type: ExecutionEventType.LOG,
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      message: 'Analyzing code for security vulnerabilities',
      level: LogLevel.INFO,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      tool_error: null,
      approval_id: null,
      artifact_id: null,
      metadata: JSON.stringify({}),
    },
    {
      id: randomUUID(),
      task_id: runningTask.id,
      event_type: ExecutionEventType.LOG,
      timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      message: 'Found 3 potential security issues',
      level: LogLevel.WARNING,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      tool_error: null,
      approval_id: null,
      artifact_id: null,
      metadata: JSON.stringify({}),
    },
  ];

  executionEvents.forEach((event) => {
    db.prepare(`
      INSERT INTO execution_events (
        id, task_id, event_type, timestamp, message, level,
        tool_name, tool_input, tool_output, tool_error,
        approval_id, artifact_id, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.task_id,
      event.event_type,
      event.timestamp,
      event.message,
      event.level,
      event.tool_name,
      event.tool_input,
      event.tool_output,
      event.tool_error,
      event.approval_id,
      event.artifact_id,
      event.metadata
    );
  });

  console.log(`✓ Created ${executionEvents.length} execution events`);

  // Create approval for awaiting_approval task
  const approvalTask = tasks[2];
  const approvals = [
    {
      id: randomUUID(),
      task_id: approvalTask.id,
      execution_event_id: null,
      status: ApprovalStatus.PENDING,
      risk_level: RiskLevel.HIGH,
      request_type: ApprovalRequestType.HIGH_RISK_ACTION,
      request_message: 'Deployment to staging requires approval due to high-risk database migrations',
      request_data: JSON.stringify({
        environment: 'staging',
        migrations: ['001_add_users_table', '002_add_auth_tokens'],
        affected_services: ['api', 'auth-service'],
      }),
      approved_by: null,
      approved_at: null,
      denied_at: null,
      denial_reason: null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // Expires in 1 hour
      metadata: JSON.stringify({}),
    },
  ];

  approvals.forEach((approval) => {
    db.prepare(`
      INSERT INTO approvals (
        id, task_id, execution_event_id, status, risk_level,
        request_type, request_message, request_data,
        approved_by, approved_at, denied_at, denial_reason,
        expires_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approval.id,
      approval.task_id,
      approval.execution_event_id,
      approval.status,
      approval.risk_level,
      approval.request_type,
      approval.request_message,
      approval.request_data,
      approval.approved_by,
      approval.approved_at,
      approval.denied_at,
      approval.denial_reason,
      approval.expires_at,
      approval.metadata
    );
  });

  console.log(`✓ Created ${approvals.length} approvals`);
  // Ransomware pattern policies (anti-agentic-ransomware module)
  const ransomwarePolicies = [
    {
      id: 'policy-ransomware-critical',
      name: 'Ransomware CRITICAL patterns',
      match_pattern: 'AES_ENCRYPT|DROP DATABASE|DROP TABLE|minioadmin|README_RANSOM|vssadmin|shadowcopy',
      decision: 'deny',
      priority: 200,
      description: 'Deny commands matching JADEPUFFER-class ransomware indicators',
      created_at: new Date().toISOString(),
    },
    {
      id: 'policy-ransomware-high',
      name: 'Ransomware HIGH patterns',
      match_pattern: 'gpg.*--encrypt|openssl.*enc|INTO OUTFILE|LOAD_FILE|crontab.*-e|credentials\.json',
      decision: 'require_approval',
      priority: 150,
      description: 'Require approval for commands matching suspicious encryption/persistence patterns',
      created_at: new Date().toISOString(),
    },
  ];

  for (const policy of ransomwarePolicies) {
    db.prepare(`
      INSERT OR IGNORE INTO approval_policies (id, name, match_pattern, decision, priority, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(policy.id, policy.name, policy.match_pattern, policy.decision, policy.priority, policy.description, policy.created_at);
  }

  console.log(`✓ Created ${ransomwarePolicies.length} ransomware approval policies`);
  console.log('✅ Database seeded successfully!');

  db.close();
}

// Run if executed directly
if (require.main === module) {
  seed();
}

export { seed };
