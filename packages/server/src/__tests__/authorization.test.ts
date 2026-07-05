import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { AuthorizationService } from '../services/authorization-service';
import { JwtSign } from '../middleware/auth';
import { ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';

let db: Database;
let authService: AuthService;

function createDb(): Database {
  return createTestDb() as unknown as Database;
}

function createAdminToken(auth: AuthService): string {
  const user = auth.findUserByEmail('admin@test.local');
  if (!user) throw new Error('Admin user not found');
  return auth.createToken(user);
}

function createOperatorToken(auth: AuthService, email: string): string {
  const user = auth.findUserByEmail(email);
  if (!user) throw new Error(`Operator user not found: ${email}`);
  return auth.createToken(user);
}

function createViewerToken(auth: AuthService, email: string): string {
  const user = auth.findUserByEmail(email);
  if (!user) throw new Error(`Viewer user not found: ${email}`);
  return auth.createToken(user);
}

function makeUser(role: string, suffix: string) {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = Array(40).fill('b').join('');
  const email = `${role}${suffix}@test.local`;
  authService.createUser(email, 'Passw0rdTest', role as UserRole);
  return { email, id: authService.findUserByEmail(email)!.id };
}

describe('AuthorizationService', () => {
  beforeEach(() => {
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = Array(40).fill('b').join('');
    delete process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
  });

  it('admin can read any task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: 'other-user', created_by: 'other-user' };
    expect(AuthorizationService.canReadTask(admin, task)).toBe(true);
  });

  it('admin can read null-owned task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: null, created_by: null };
    expect(AuthorizationService.canReadTask(admin, task)).toBe(true);
  });

  it('operator can read own task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canReadTask(op, task)).toBe(true);
  });

  it('operator can read task where they are creator', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-2', created_by: 'op-1' };
    expect(AuthorizationService.canReadTask(op, task)).toBe(true);
  });

  it('operator cannot read another operator task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-2', created_by: 'op-2' };
    expect(AuthorizationService.canReadTask(op, task)).toBe(false);
  });

  it('operator cannot read null-owned (legacy) task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: null, created_by: null };
    expect(AuthorizationService.canReadTask(op, task)).toBe(false);
  });

  it('viewer can read own task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'v-1', created_by: 'v-1' };
    expect(AuthorizationService.canReadTask(viewer, task)).toBe(true);
  });

  it('viewer cannot read another user task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canReadTask(viewer, task)).toBe(false);
  });

  it('viewer cannot read null-owned task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const task = { owner_user_id: null, created_by: null };
    expect(AuthorizationService.canReadTask(viewer, task)).toBe(false);
  });

  it('operator can modify own task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canModifyTask(op, task)).toBe(true);
  });

  it('operator cannot modify another operator task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-2', created_by: 'op-2' };
    expect(AuthorizationService.canModifyTask(op, task)).toBe(false);
  });

  it('admin can modify any task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canModifyTask(admin, task)).toBe(true);
  });

  it('operator can execute own task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canExecuteTask(op, task)).toBe(true);
  });

  it('operator cannot execute another operator task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-2', created_by: 'op-2' };
    expect(AuthorizationService.canExecuteTask(op, task)).toBe(false);
  });

  it('viewer cannot execute any task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'v-1', created_by: 'v-1' };
    expect(AuthorizationService.canExecuteTask(viewer, ownTask)).toBe(false);
  });

  it('admin can delete any task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canDeleteTask(admin, task)).toBe(true);
  });

  it('operator cannot delete task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canDeleteTask(op, ownTask)).toBe(false);
  });

  it('viewer cannot delete task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'v-1', created_by: 'v-1' };
    expect(AuthorizationService.canDeleteTask(viewer, ownTask)).toBe(false);
  });

  it('admin can approve for any task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canApproveForTask(admin, task)).toBe(true);
  });

  it('operator can approve own task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canApproveForTask(op, task)).toBe(true);
  });

  it('operator cannot approve another operator task', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-2', created_by: 'op-2' };
    expect(AuthorizationService.canApproveForTask(op, task)).toBe(false);
  });

  it('viewer cannot approve any task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'v-1', created_by: 'v-1' };
    expect(AuthorizationService.canApproveForTask(viewer, ownTask)).toBe(false);
  });

  it('evidence access follows task access', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'op-1', created_by: 'op-1' };
    const otherTask = { owner_user_id: 'op-2', created_by: 'op-2' };

    expect(AuthorizationService.canReadEvidenceForTask(admin, ownTask)).toBe(true);
    expect(AuthorizationService.canReadEvidenceForTask(op, ownTask)).toBe(true);
    expect(AuthorizationService.canReadEvidenceForTask(op, otherTask)).toBe(false);
    expect(AuthorizationService.canReadEvidenceForTask(viewer, ownTask)).toBe(false);
  });

  it('getTaskVisibilityWhere returns null for admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    expect(AuthorizationService.getTaskVisibilityWhere(admin)).toBeNull();
  });

  it('getTaskVisibilityWhere returns owner filter for operator', () => {
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const result = AuthorizationService.getTaskVisibilityWhere(op);
    expect(result).not.toBeNull();
    expect(result!.clause).toBe('(tasks.owner_user_id = ? OR tasks.created_by = ?)');
    expect(result!.params).toEqual(['op-1', 'op-1']);
  });

  it('getTaskVisibilityWhere returns owner filter for viewer', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const result = AuthorizationService.getTaskVisibilityWhere(viewer);
    expect(result).not.toBeNull();
    expect(result!.clause).toBe('(tasks.owner_user_id = ? OR tasks.created_by = ?)');
    expect(result!.params).toEqual(['v-1', 'v-1']);
  });

  it('canManageBackups only for admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    expect(AuthorizationService.canManageBackups(admin)).toBe(true);
    expect(AuthorizationService.canManageBackups(op)).toBe(false);
    expect(AuthorizationService.canManageBackups(viewer)).toBe(false);
  });

  it('canAccessObservability only for admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    expect(AuthorizationService.canAccessObservability(admin)).toBe(true);
    expect(AuthorizationService.canAccessObservability(op)).toBe(false);
  });

  it('canReadRepositoryDetail for operator and admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const op = { sub: 'op-1', email: 'op@test.local', role: UserRole.OPERATOR, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    expect(AuthorizationService.canReadRepositoryDetail(admin)).toBe(true);
    expect(AuthorizationService.canReadRepositoryDetail(op)).toBe(true);
    expect(AuthorizationService.canReadRepositoryDetail(viewer)).toBe(true);
  });
});

describe('Migration Phase 5.5', () => {
  it('adds ownership columns to tasks table', () => {
    db = createDb();
    const columns = db.pragma('table_info(tasks)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('created_by');
    expect(colNames).toContain('owner_user_id');
    expect(colNames).toContain('updated_by');
    db.close();
  });

  it('adds added_by to repositories table', () => {
    db = createDb();
    const columns = db.pragma('table_info(repositories)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('added_by');
    db.close();
  });

  it('adds requested_by to approvals table', () => {
    db = createDb();
    const columns = db.pragma('table_info(approvals)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('requested_by');
    db.close();
  });
});
