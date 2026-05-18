import { UserRole, ROLE_PERMISSIONS } from '@djimitflo/shared';
import type { AuthTokenPayload } from '@djimitflo/shared';

export interface OwnableResource {
  owner_user_id?: string | null;
  created_by?: string | null;
}

export class AuthorizationService {
  static isAdmin(user: AuthTokenPayload): boolean {
    return user.role === UserRole.ADMIN;
  }

  static canReadTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (user.role === UserRole.ADMIN) return true;
    return AuthorizationService.isOwner(user, task);
  }

  static canModifyTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (user.role === UserRole.ADMIN) return true;
    if (!AuthorizationService.hasPermission(user, 'create:task')) return false;
    return AuthorizationService.isOwner(user, task);
  }

  static canExecuteTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (user.role === UserRole.ADMIN) return true;
    if (!AuthorizationService.hasPermission(user, 'execute:task')) return false;
    return AuthorizationService.isOwner(user, task);
  }

  static canDeleteTask(user: AuthTokenPayload, _task: OwnableResource): boolean {
    if (user.role === UserRole.ADMIN) return true;
    return false;
  }

  static canApproveForTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (user.role === UserRole.ADMIN) return true;
    if (!AuthorizationService.hasPermission(user, 'approve:task')) return false;
    return AuthorizationService.isOwner(user, task);
  }

  static canReadEvidenceForTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    return AuthorizationService.canReadTask(user, task);
  }

  static canManageBackups(user: AuthTokenPayload): boolean {
    return AuthorizationService.hasPermission(user, 'manage:backups');
  }

  static canReadRepositoryDetail(user: AuthTokenPayload): boolean {
    return AuthorizationService.hasPermission(user, 'read:repository');
  }

  static canScanRepository(user: AuthTokenPayload): boolean {
    return AuthorizationService.hasPermission(user, 'scan:repository');
  }

  static canAccessObservability(user: AuthTokenPayload): boolean {
    return user.role === UserRole.ADMIN;
  }

  static isOwner(user: AuthTokenPayload, resource: OwnableResource): boolean {
    const userId = user.sub;
    if (resource.owner_user_id === userId) return true;
    if (resource.created_by === userId) return true;
    return false;
  }

  static hasPermission(user: AuthTokenPayload, permission: string): boolean {
    const permissions = ROLE_PERMISSIONS[user.role as UserRole];
    return permissions ? permissions.includes(permission) : false;
  }

  static getTaskVisibilityWhere(user: AuthTokenPayload): { clause: string; params: string[] } | null {
    if (user.role === UserRole.ADMIN) return null;
    return {
      clause: '(tasks.owner_user_id = ? OR tasks.created_by = ?)',
      params: [user.sub, user.sub],
    };
  }

  static getApprovalTaskVisibilityWhere(user: AuthTokenPayload): { clause: string; params: string[] } | null {
    if (user.role === UserRole.ADMIN) return null;
    return {
      clause: '(tasks.owner_user_id = ? OR tasks.created_by = ?)',
      params: [user.sub, user.sub],
    };
  }
}