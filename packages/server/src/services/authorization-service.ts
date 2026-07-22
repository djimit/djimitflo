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

  static isPrivileged(user: AuthTokenPayload): boolean {
    return user.role === UserRole.ADMIN || user.role === UserRole.PLATFORM_ADMIN;
  }

  static canReadTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (AuthorizationService.isPrivileged(user)) return true;
    return AuthorizationService.isOwner(user, task);
  }

  static canModifyTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (AuthorizationService.isPrivileged(user)) return true;
    if (!AuthorizationService.hasPermission(user, 'create:task')) return false;
    return AuthorizationService.isOwner(user, task);
  }

  static canExecuteTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (AuthorizationService.isPrivileged(user)) return true;
    if (!AuthorizationService.hasPermission(user, 'execute:task')) return false;
    return AuthorizationService.isOwner(user, task);
  }

  static canDeleteTask(user: AuthTokenPayload, _task: OwnableResource): boolean {
    return AuthorizationService.isPrivileged(user);
  }

  static canApproveForTask(user: AuthTokenPayload, task: OwnableResource): boolean {
    if (AuthorizationService.isPrivileged(user)) return true;
    if (!AuthorizationService.hasPermission(user, 'approve:task')) return false;
    if (AuthorizationService.isOwner(user, task)) return false;
    return true;
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
    return AuthorizationService.isPrivileged(user) || AuthorizationService.hasPermission(user, 'read:audit');
  }

  static isOwner(user: AuthTokenPayload, resource: OwnableResource): boolean {
    const userId = user.sub;
    if (resource.owner_user_id === userId) return true;
    if (resource.created_by === userId) return true;
    return false;
  }

  static hasPermission(userOrRole: AuthTokenPayload | string, permission: string): boolean {
    const role = typeof userOrRole === 'string' ? userOrRole : userOrRole.role;
    const permissions = ROLE_PERMISSIONS[role as UserRole];
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
    if (AuthorizationService.isPrivileged(user)) return null;
    if (user.role === UserRole.AUDITOR || user.role === UserRole.APPROVER) return null;
    return {
      clause: '(tasks.owner_user_id = ? OR tasks.created_by = ?)',
      params: [user.sub, user.sub],
    };
  }
}