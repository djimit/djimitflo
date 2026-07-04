import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeDatabase } from '../database';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { LoopService } from '../services/loop-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { AgentAssuranceService } from '../services/agent-assurance-service';
import { createRoutes } from '../routes';

describe('Server Startup (main)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('initializes database without throwing', () => {
    expect(() => initializeDatabase()).not.toThrow();
  });

  it('creates all core service instances', () => {
    const db = initializeDatabase();

    expect(() => new AuthService(db)).not.toThrow();
    expect(() => new LoopService(db, '.data/evidence-test')).not.toThrow();
    expect(() => new SwarmStatusService(db)).not.toThrow();
    expect(() => new SwarmIntelligenceService(db)).not.toThrow();
    expect(() => new AgentAssuranceService(db)).not.toThrow();
  });

  it('creates auth middleware without throwing', () => {
    const db = initializeDatabase();
    const authService = new AuthService(db);
    expect(() => createAuthMiddleware(authService)).not.toThrow();
  });

  it('creates full route tree without throwing', () => {
    const db = initializeDatabase();
    const authService = new AuthService(db);
    const auth = createAuthMiddleware(authService);
    expect(() => createRoutes(db, undefined, authService, auth)).not.toThrow();
  });

  it('bootstrapAdmin creates admin user', () => {
    const db = initializeDatabase();
    const authService = new AuthService(db);
    expect(() => authService.bootstrapAdmin()).not.toThrow();
  });
});
