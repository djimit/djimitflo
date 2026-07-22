import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { runMigrations } from '../database/migrate';
import { schema } from '../database/schema';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { AuthorizationService } from '../services/authorization-service';
import { JwtSign } from '../middleware/auth';
import { ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';

let db: Database.Database;
let authService: AuthService;

function createDb(): Database.Database {
  return createTestDb() as unknown as Database.Database;
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

  it('maker can read own task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canReadTask(maker, task)).toBe(true);
  });

  it('maker can read task where they are creator', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-2', created_by: 'm-1' };
    expect(AuthorizationService.canReadTask(maker, task)).toBe(true);
  });

  it('maker cannot read another maker task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-2', created_by: 'm-2' };
    expect(AuthorizationService.canReadTask(maker, task)).toBe(false);
  });

  it('maker cannot read null-owned (legacy) task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: null, created_by: null };
    expect(AuthorizationService.canReadTask(maker, task)).toBe(false);
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

  it('maker can modify own task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canModifyTask(maker, task)).toBe(true);
  });

  it('maker cannot modify another maker task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-2', created_by: 'm-2' };
    expect(AuthorizationService.canModifyTask(maker, task)).toBe(false);
  });

  it('admin can modify any task', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const task = { owner_user_id: 'op-1', created_by: 'op-1' };
    expect(AuthorizationService.canModifyTask(admin, task)).toBe(true);
  });

  it('maker can execute own task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canExecuteTask(maker, task)).toBe(true);
  });

  it('maker cannot execute another maker task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const task = { owner_user_id: 'm-2', created_by: 'm-2' };
    expect(AuthorizationService.canExecuteTask(maker, task)).toBe(false);
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

  it('maker cannot delete task', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canDeleteTask(maker, ownTask)).toBe(false);
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

  it('approver can approve tasks they do not own (separation of duties)', () => {
    const approver = { sub: 'a-1', email: 'a@test.local', role: UserRole.APPROVER, iat: 0, exp: 0 };
    const otherTask = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canApproveForTask(approver, otherTask)).toBe(true);
  });

  it('approver cannot approve own task (separation of duties)', () => {
    const approver = { sub: 'a-1', email: 'a@test.local', role: UserRole.APPROVER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'a-1', created_by: 'a-1' };
    expect(AuthorizationService.canApproveForTask(approver, ownTask)).toBe(false);
  });

  it('maker cannot approve any task (separation of duties)', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'm-1', created_by: 'm-1' };
    expect(AuthorizationService.canApproveForTask(maker, ownTask)).toBe(false);
  });

  it('viewer cannot approve any task', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'v-1', created_by: 'v-1' };
    expect(AuthorizationService.canApproveForTask(viewer, ownTask)).toBe(false);
  });

  it('evidence access follows task access', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const ownTask = { owner_user_id: 'm-1', created_by: 'm-1' };
    const otherTask = { owner_user_id: 'm-2', created_by: 'm-2' };

    expect(AuthorizationService.canReadEvidenceForTask(admin, ownTask)).toBe(true);
    expect(AuthorizationService.canReadEvidenceForTask(maker, ownTask)).toBe(true);
    expect(AuthorizationService.canReadEvidenceForTask(maker, otherTask)).toBe(false);
    expect(AuthorizationService.canReadEvidenceForTask(viewer, ownTask)).toBe(false);
  });

  it('getTaskVisibilityWhere returns null for admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    expect(AuthorizationService.getTaskVisibilityWhere(admin)).toBeNull();
  });

  it('getTaskVisibilityWhere returns owner filter for maker', () => {
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const result = AuthorizationService.getTaskVisibilityWhere(maker);
    expect(result).not.toBeNull();
    expect(result!.clause).toBe('(tasks.owner_user_id = ? OR tasks.created_by = ?)');
    expect(result!.params).toEqual(['m-1', 'm-1']);
  });

  it('getTaskVisibilityWhere returns owner filter for viewer', () => {
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    const result = AuthorizationService.getTaskVisibilityWhere(viewer);
    expect(result).not.toBeNull();
    expect(result!.clause).toBe('(tasks.owner_user_id = ? OR tasks.created_by = ?)');
    expect(result!.params).toEqual(['v-1', 'v-1']);
  });

  it('canManageBackups only for admin and platform_admin', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const platformAdmin = { sub: 'pa-1', email: 'pa@test.local', role: UserRole.PLATFORM_ADMIN, iat: 0, exp: 0 };
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    expect(AuthorizationService.canManageBackups(admin)).toBe(true);
    expect(AuthorizationService.canManageBackups(platformAdmin)).toBe(true);
    expect(AuthorizationService.canManageBackups(maker)).toBe(false);
    expect(AuthorizationService.canManageBackups(viewer)).toBe(false);
  });

  it('canAccessObservability for admin, platform_admin, and auditor', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const platformAdmin = { sub: 'pa-1', email: 'pa@test.local', role: UserRole.PLATFORM_ADMIN, iat: 0, exp: 0 };
    const auditor = { sub: 'a-1', email: 'a@test.local', role: UserRole.AUDITOR, iat: 0, exp: 0 };
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    expect(AuthorizationService.canAccessObservability(admin)).toBe(true);
    expect(AuthorizationService.canAccessObservability(platformAdmin)).toBe(true);
    expect(AuthorizationService.canAccessObservability(auditor)).toBe(true);
    expect(AuthorizationService.canAccessObservability(maker)).toBe(false);
  });

  it('canReadRepositoryDetail for all authenticated roles', () => {
    const admin = { sub: 'admin-id', email: 'admin@test.local', role: UserRole.ADMIN, iat: 0, exp: 0 };
    const maker = { sub: 'm-1', email: 'm@test.local', role: UserRole.MAKER, iat: 0, exp: 0 };
    const viewer = { sub: 'v-1', email: 'v@test.local', role: UserRole.VIEWER, iat: 0, exp: 0 };
    expect(AuthorizationService.canReadRepositoryDetail(admin)).toBe(true);
    expect(AuthorizationService.canReadRepositoryDetail(maker)).toBe(true);
    expect(AuthorizationService.canReadRepositoryDetail(viewer)).toBe(true);
  });
});

describe('Migration Phase 5.5', () => {
  function createMigratedDb(): Database.Database {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(schema);
    runMigrations(database);
    return database;
  }

  it('adds ownership columns to tasks table', () => {
    db = createMigratedDb();
    const columns = db.pragma('table_info(tasks)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('created_by');
    expect(colNames).toContain('owner_user_id');
    expect(colNames).toContain('updated_by');
    db.close();
  });

  it('adds added_by to repositories table', () => {
    db = createMigratedDb();
    const columns = db.pragma('table_info(repositories)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('added_by');
    db.close();
  });

  it('adds requested_by to approvals table', () => {
    db = createMigratedDb();
    const columns = db.pragma('table_info(approvals)') as any[];
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('requested_by');
    db.close();
  });
});
