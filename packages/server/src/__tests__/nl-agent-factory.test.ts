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
    expect(result.config.capabilities).toContain('security-scanning');
    expect(result.config.risk_class).toBe('high');
    expect(result.status).toBe('pending_approval');
    expect(result.config.system_prompt).toContain('security');
  });

  it('creates an agent from a code review description', () => {
    const result = factory.createFromDescription('Review pull requests for code quality and standards');
    expect(result.config.agent_type).toBe('code-reviewer');
    expect(result.config.capabilities).toContain('code-review');
  });

  it('creates an agent from a test engineering description', () => {
    const result = factory.createFromDescription('Generate and run tests for the codebase');
    expect(result.config.agent_type).toBe('test-engineer');
    expect(result.config.capabilities).toContain('test-generation');
  });

  it('defaults to generalist for unknown descriptions', () => {
    const result = factory.createFromDescription('Help with various tasks around the office');
    expect(result.config.agent_type).toBe('generalist');
    expect(result.config.capabilities).toContain('task-execution');
  });

  it('throws on empty description', () => {
    expect(() => factory.createFromDescription('')).toThrow('AGENT_DESCRIPTION_REQUIRED');
    expect(() => factory.createFromDescription('   ')).toThrow('AGENT_DESCRIPTION_REQUIRED');
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

  it('generates unique names for agents', () => {
    const a = factory.createFromDescription('Security scanner for the API');
    const b = factory.createFromDescription('Security scanner for the database');
    expect(a.config.name).not.toBe(b.config.name);
  });

  it('respects custom name option', () => {
    const result = factory.createFromDescription('A test agent', { name: 'My-Custom-Agent' });
    expect(result.config.name).toBe('My-Custom-Agent');
  });

  it('infers high risk for destructive operations', () => {
    const result = factory.createFromDescription('Delete old production logs and rotate storage');
    expect(result.config.risk_class).toBe('high');
  });
});
