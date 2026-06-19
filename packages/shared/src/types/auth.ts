/**
 * Authentication and authorization types for Djimitflo
 */

export enum UserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
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
  ],
  [UserRole.OPERATOR]: [
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
    'write:evidence',
    'write:agents',
    'write:skills',
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
