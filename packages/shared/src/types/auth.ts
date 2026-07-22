/**
 * Authentication and authorization types for Djimitflo
 */

export enum UserRole {
  ADMIN = 'admin',
  PLATFORM_ADMIN = 'platform_admin',
  APPROVER = 'approver',
  MAKER = 'maker',
  CHECKER = 'checker',
  AUDITOR = 'auditor',
  VIEWER = 'viewer',
}

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  [UserRole.ADMIN]: [
    'read:evidence',
    'read:repository',
    'scan:repository',
    'create:task',
    'write:capability',
    'write:claim',
    'write:governance',
    'write:runner_manifest',
    'write:swarm_action',
    'execute:task',
    'approve:task',
    'delete:task',
    'manage:config',
    'manage:users',
    'manage:backups',
    'write:evidence',
    'write:agents',
    'write:skills',
    'manage:policies',
    'manage:tokens',
    'read:audit',
  ],
  [UserRole.PLATFORM_ADMIN]: [
    'manage:config',
    'manage:users',
    'manage:backups',
    'manage:policies',
    'manage:tokens',
    'read:evidence',
    'read:repository',
    'read:audit',
  ],
  [UserRole.APPROVER]: [
    'approve:task',
    'read:evidence',
    'read:repository',
    'create:task',
  ],
  [UserRole.MAKER]: [
    'create:task',
    'write:evidence',
    'write:agents',
    'write:skills',
    'write:capability',
    'write:claim',
    'write:swarm_action',
    'read:evidence',
    'read:repository',
    'scan:repository',
  ],
  [UserRole.CHECKER]: [
    'read:evidence',
    'read:repository',
    'scan:repository',
    'write:evidence',
  ],
  [UserRole.AUDITOR]: [
    'read:evidence',
    'read:repository',
    'read:audit',
  ],
  [UserRole.VIEWER]: [
    'read:evidence',
    'read:repository',
  ],
};

export interface User {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}
