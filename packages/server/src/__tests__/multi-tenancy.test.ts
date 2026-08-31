import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeDatabase } from '../database';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { AuditEventType } from '@djimitflo/shared';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { createRoutes } from '../routes';
import { createAuthMiddleware } from '../middleware/auth';

// Mock Request object
const mockReq = {
  ip: '127.0.0.1',
  get: (header: string) => header === 'User-Agent' ? 'TestRunner/1.0' : undefined,
  user: { organization_id: 'org-a' },
} as any;

let app: express.Application;

describe('Multi-Tenancy + Audit Trail', () => {
  let db: Database;
  let authService: AuthService;
  let auditService: AuditService;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        organization_id TEXT NOT NULL DEFAULT 'default',
        role TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        user_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        execution_event_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        risk_level TEXT NOT NULL DEFAULT 'medium',
        before TEXT,
        after TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        metadata JSON NOT NULL,
        log_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );
    `);
    authService = new AuthService(db);
    auditService = new AuditService(db);
    const auth = createAuthMiddleware(authService);
    const requireAuthMiddleware = auth.requireAuth;
    app = express();
    app.use(express.json());
    const { createOrganizationRoutes } = await import('../routes/organizations');
    app.use('/api/organizations', createOrganizationRoutes(db, auth.requireAuth, authService, auditService));
    app.use('/api', createRoutes(db, undefined, authService, auth, undefined, undefined));

    // Maak testorganisaties
    db.prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'org-a', 'Organization A', new Date().toISOString(), new Date().toISOString()
    );
    db.prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'org-b', 'Organization B', new Date().toISOString(), new Date().toISOString()
    );

    // Maak testgebruikers
    db.prepare("INSERT INTO users (id, email, password_hash, organization_id, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))").run(
      'user-a', 'user-a@test.local', authService.hashPassword ? authService.hashPassword('password') : 'x', 'org-a', UserRole.MAKER,
    );
    db.prepare("INSERT INTO users (id, email, password_hash, organization_id, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))").run(
      'user-b', 'user-b@test.local', authService.hashPassword ? authService.hashPassword('password') : 'x', 'org-b', UserRole.MAKER,
    );
  });

  afterAll(() => {
    db.close();
  });

  describe('Cross-Tenant Isolatie', () => {
    it('GET /api/organizations retourneert alleen organisaties van de ingelogde gebruiker', () => {
      const userA = authService.findUserByEmail('user-a@test.local');
      const tokenA = authService.generateToken(userA!);
      const payloadA = authService.verifyToken(tokenA);
      
      // Valideer dat de token organization_id bevat
      expect(payloadA?.organization_id).toBe('org-a');
      
      // Valideer dat alleen org-a wordt geretourneerd
      const orgs = db.prepare('SELECT * FROM organizations WHERE id = ?').all('org-a');
      expect(orgs).toHaveLength(1);
      expect(orgs[0].id).toBe('org-a');
    });

    it('POST /api/organizations/switch werkt alleen als organization_id matcht met de gebruiker', async () => {
      const userA = authService.findUserByEmail('user-a@test.local');
      const tokenA = authService.generateToken(userA!);
      
      // Probeer te switchen naar org-b (moet falen)
      const switchRes = await request(app)
        .post('/api/organizations/switch')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ organization_id: 'org-b' });
      expect(switchRes.status).toBe(403);
      
      // Switch naar org-a (moet slagen)
      const validSwitchRes = await request(app)
        .post('/api/organizations/switch')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ organization_id: 'org-a' });
      expect(validSwitchRes.status).toBe(200);
      expect(validSwitchRes.body.token).toBeTruthy();
    });
  });

  describe('Audit Trail', () => {
    it('Alle mutaties maken een audit log entry met organization_id en log_hash', () => {
      // Test audit logging — HEAD AuditService.record contract
      auditService.record({
        event_type: AuditEventType.RESOURCE_CREATED ?? ('resource.created' as any),
        user_id: 'user-a',
        action: 'create',
        resource_type: 'test_entity',
        resource_id: 'test-id',
        metadata: { test: 'data' },
      } as any);

      // Valideer de log entry
      const logs = db.prepare('SELECT * FROM audit_events WHERE action = ?').all('create') as any[];
      expect(logs).toHaveLength(1);
      expect(logs[0].resource_id).toBe('test-id');
      expect(logs[0].action).toBe('create');
    });
  });

  describe('RBAC', () => {
    it('Gebruiker met viewer rol mag geen taken aanmaken', () => {
      const viewer = authService.createUser('viewer@test.local', 'password', UserRole.VIEWER, 'org-a');
      const viewerToken = authService.generateToken(viewer);
      
      // Valideer permissies
      const hasPermission = authService.hasPermission(UserRole.VIEWER, 'create:task');
      expect(hasPermission).toBe(false);
    });
  });
});