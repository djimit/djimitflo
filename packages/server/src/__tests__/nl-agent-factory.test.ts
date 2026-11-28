import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NlAgentFactory } from '../services/nl-agent-factory';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

describe('NlAgentFactory', () => {
  let db: Database.Database;
  let factory: NlAgentFactory;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    factory = new NlAgentFactory(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates an agent from a security description', () => {
    const result = factory.createFromDescription('A security scanner that checks for OWASP Top 10 vulnerabilities');
    expect(result.id).toBeDefined();
    expect(result.config.agent_type).toBe('security');
    expect(result.config.capabilities).toStrictEqual(['security-scanning', 'vulnerability-assessment', 'compliance-checking']);
    expect(result.config.risk_class).toBe('high');
    expect(result.status).toBe('pending_approval');
    expect(result.draft).toBe(true);
    expect(result.config.system_prompt).toContain('security');
    expect(result.config.tools).toStrictEqual(['sast-scan', 'dependency-audit', 'secret-scan', 'compliance-check']);
    expect(result.config.model).toBe('workstation-litellm/coding');
    expect(result.config.temperature).toBe(0.7);
    expect(result.config.max_tokens).toBe(4096);
    expect(result.config.metadata).toMatchObject({ created_from: 'nl-description', auto_generated: true });
  });

  it('creates an agent from a code review description', () => {
    const result = factory.createFromDescription('Review pull requests for code quality and standards');
    expect(result.config.agent_type).toBe('code-reviewer');
    expect(result.config.capabilities).toStrictEqual(['code-review', 'static-analysis', 'quality-gate']);
    expect(result.config.tools).toStrictEqual(['code-review', 'diff-analysis', 'quality-gate', 'pr-comment']);
  });

  it('creates an agent from a test engineering description', () => {
    const result = factory.createFromDescription('Generate and run tests for the codebase');
    expect(result.config.agent_type).toBe('test-engineer');
    expect(result.config.capabilities).toStrictEqual(['test-generation', 'test-execution', 'coverage-analysis']);
    expect(result.config.tools).toStrictEqual(['test-generate', 'test-run', 'coverage-report', 'mutation-test']);
  });

  it('defaults to generalist for unknown descriptions', () => {
    const result = factory.createFromDescription('Help with various tasks around the office');
    expect(result.config.agent_type).toBe('generalist');
    expect(result.config.capabilities).toStrictEqual(['task-execution', 'reporting']);
    expect(result.config.tools).toStrictEqual(['task-execute', 'report-generate', 'status-query']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers deployer type with high risk', () => {
    const result = factory.createFromDescription('Deploy and release the application');
    expect(result.config.agent_type).toBe('deployer');
    expect(result.config.capabilities).toStrictEqual(['deployment', 'rollback', 'release-management']);
    expect(result.config.tools).toStrictEqual(['deploy', 'rollback', 'health-check', 'release-note']);
    expect(result.config.risk_class).toBe('high');
  });

  it('infers researcher type', () => {
    const result = factory.createFromDescription('Research and investigate the topic');
    expect(result.config.agent_type).toBe('researcher');
    expect(result.config.capabilities).toStrictEqual(['web-search', 'analysis', 'synthesis']);
    expect(result.config.tools).toStrictEqual(['web-search', 'summarize', 'analyze', 'cite']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers documenter type', () => {
    const result = factory.createFromDescription('Document the wiki and readme');
    expect(result.config.agent_type).toBe('documenter');
    expect(result.config.capabilities).toStrictEqual(['documentation', 'wiki-management', 'readme-generation']);
    expect(result.config.tools).toStrictEqual(['doc-generate', 'wiki-update', 'readme-sync', 'diagram-generate']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers monitor type', () => {
    const result = factory.createFromDescription('Monitor and observe alerts');
    expect(result.config.agent_type).toBe('monitor');
    expect(result.config.capabilities).toStrictEqual(['monitoring', 'alerting', 'health-checks']);
    expect(result.config.tools).toStrictEqual(['health-check', 'alert-query', 'metric-collect', 'log-analysis']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers data-engineer type', () => {
    const result = factory.createFromDescription('ETL data pipeline');
    expect(result.config.agent_type).toBe('data-engineer');
    expect(result.config.capabilities).toStrictEqual(['data-processing', 'etl', 'pipeline-management']);
    expect(result.config.tools).toStrictEqual(['etl-run', 'data-validate', 'pipeline-manage', 'schema-check']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers infrastructure type', () => {
    const result = factory.createFromDescription('Provision infrastructure servers');
    expect(result.config.agent_type).toBe('infrastructure');
    expect(result.config.capabilities).toStrictEqual(['server-management', 'provisioning', 'configuration']);
    expect(result.config.tools).toStrictEqual(['server-provision', 'config-apply', 'health-check', 'backup-verify']);
    expect(result.config.risk_class).toBe('low');
  });

  it('infers orchestrator type', () => {
    const result = factory.createFromDescription('Orchestrate and coordinate management');
    expect(result.config.agent_type).toBe('orchestrator');
    expect(result.config.capabilities).toStrictEqual(['task-delegation', 'coordination', 'scheduling']);
    expect(result.config.tools).toStrictEqual(['task-delegate', 'status-query', 'schedule-manage', 'evidence-collect']);
    expect(result.config.risk_class).toBe('low');
  });

  it('throws on empty description', () => {
    expect(() => factory.createFromDescription('')).toThrow('AGENT_DESCRIPTION_REQUIRED');
    expect(() => factory.createFromDescription('   ')).toThrow('AGENT_DESCRIPTION_REQUIRED');
  });

  it('throws on null description', () => {
    expect(() => factory.createFromDescription(null as unknown as string)).toThrow('AGENT_DESCRIPTION_REQUIRED');
  });

  it('trims the description in config but keeps raw in metadata', () => {
    const result = factory.createFromDescription('  security scan  ');
    expect(result.config.description).toBe('security scan');
    expect(result.config.metadata.source_description).toBe('  security scan  ');
  });

  it('stores agent in database with pending_approval status', () => {
    const result = factory.createFromDescription('Monitor server health and alert on issues');
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.id) as any;
    expect(row).toBeDefined();
    expect(row.status).toBe('pending_approval');
    expect(row.name).toBe(result.config.name);
    const metadata = JSON.parse(row.metadata);
    expect(metadata.auto_generated).toBe(true);
    expect(metadata.system_prompt).toBeDefined();
    expect(metadata.tools).toStrictEqual(result.config.tools);
  });

  it('approves a pending agent', () => {
    const result = factory.createFromDescription('Deploy applications to staging');
    expect(result.status).toBe('pending_approval');

    factory.approveAgent(result.id);

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.id) as any;
    expect(row.status).toBe('idle');
  });

  it('throws when approving non-existent agent', () => {
    expect(() => factory.approveAgent('nonexistent')).toThrow('AGENT_NOT_FOUND');
  });

  it('throws when approving non-pending agent', () => {
    const result = factory.createFromDescription('Research competitor products');
    db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(result.id);
    expect(() => factory.approveAgent(result.id)).toThrow('AGENT_NOT_PENDING');
  });

  it('throws when approving a retired agent', () => {
    const result = factory.createFromDescription('Research competitor products');
    db.prepare('UPDATE agents SET retired_at = ? WHERE id = ?').run(new Date().toISOString(), result.id);
    expect(() => factory.approveAgent(result.id)).toThrow('Retired agents cannot be approved for dispatch');
  });

  it('generates unique names for agents', () => {
    const a = factory.createFromDescription('Security scanner for the API');
    const b = factory.createFromDescription('Security scanner for the database');
    expect(a.config.name).not.toBe(b.config.name);
  });

  it('generates a name from the description when no name is provided', () => {
    const result = factory.createFromDescription('alpha beta gamma delta');
    expect(result.config.name).toMatch(/^generalist-Alpha-Beta-Gamma-[a-f0-9]{6}$/);
  });

  it('strips special characters from the generated name prefix', () => {
    const result = factory.createFromDescription('alpha! beta gamma');
    expect(result.config.name).toMatch(/^generalist-Alpha-Beta-Gamma-[a-f0-9]{6}$/);
  });

  it('truncates the generated name prefix to 20 characters', () => {
    const result = factory.createFromDescription('alphabetical betacarotene gammadelta');
    expect(result.config.name).toMatch(/^generalist-Alphabetical-Betacar-[a-f0-9]{6}$/);
  });

  it('respects custom name option and trims it', () => {
    const result = factory.createFromDescription('A test agent', { name: '  My-Custom-Agent  ' });
    expect(result.config.name).toBe('My-Custom-Agent');
  });

  it('respects custom model, temperature and max_tokens', () => {
    const result = factory.createFromDescription('security scan', {
      model: 'custom-model',
      temperature: 0.5,
      max_tokens: 1000,
    });
    expect(result.config.model).toBe('custom-model');
    expect(result.config.temperature).toBe(0.5);
    expect(result.config.max_tokens).toBe(1000);
  });

  it('handles zero temperature and max_tokens', () => {
    const result = factory.createFromDescription('security scan', {
      temperature: 0,
      max_tokens: 0,
    });
    expect(result.config.temperature).toBe(0);
    expect(result.config.max_tokens).toBe(0);
  });

  it('infers high risk for destructive operations', () => {
    const result = factory.createFromDescription('Delete old production logs and rotate storage');
    expect(result.config.risk_class).toBe('high');
  });

  it('infers high risk for force/remove without security words', () => {
    const result = factory.createFromDescription('Force remove old backup files');
    expect(result.config.risk_class).toBe('high');
  });

  it('infers medium risk for write/create operations', () => {
    const result = factory.createFromDescription('Write a report and send notifications');
    expect(result.config.risk_class).toBe('medium');
  });
});
