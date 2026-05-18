/**
 * AuthService — user management, password hashing, JWT, and bootstrap
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { UserRole, ROLE_PERMISSIONS, type User, type AuthTokenPayload } from '@djimitflo/shared';

const BCRYPT_ROUNDS = 12;
const DEFAULT_JWT_EXPIRES_IN = '24h';
const DEV_SECRET = 'dev-secret-do-not-use-in-production';

export class AuthService {
  private db: Database;
  private jwtSecret: string;
  private jwtExpiresIn: string;

  constructor(db: Database) {
    this.db = db;
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: JWT_SECRET is required in production. Server cannot start.');
        process.exit(1);
      }
      console.warn('WARNING: JWT_SECRET not set. Using development secret. Do not use in production.');
      this.jwtSecret = DEV_SECRET;
    } else {
      this.jwtSecret = secret;
    }
    this.jwtExpiresIn = process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN;
  }

  hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
  }

  verifyPassword(plain: string, hash: string): boolean {
    return bcrypt.compareSync(plain, hash);
  }

  generateToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return jwt.sign(payload, this.jwtSecret, { expiresIn: this.jwtExpiresIn as any });
  }

  verifyToken(token: string): AuthTokenPayload | null {
    try {
      return jwt.verify(token, this.jwtSecret) as AuthTokenPayload;
    } catch {
      return null;
    }
  }

  sanitizeUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      email: row.email as string,
      role: row.role as UserRole,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  createUser(email: string, password: string, role: UserRole = UserRole.OPERATOR): User {
    const id = randomUUID();
    const passwordHash = this.hashPassword(password);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, email.toLowerCase().trim(), passwordHash, role, now, now);

    return this.findUserById(id)!;
  }

  findUserByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!row) return null;
    return this.sanitizeUser(row as Record<string, unknown>);
  }

  findUserById(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return null;
    return this.sanitizeUser(row as Record<string, unknown>);
  }

  authenticate(email: string, password: string): { user: User; token: string } | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
    if (!row) return null;

    const userRow = row as Record<string, unknown>;
    if (!this.verifyPassword(password, userRow.password_hash as string)) return null;

    const user = this.sanitizeUser(userRow);
    const token = this.generateToken(user);
    return { user, token };
  }

  hasPermission(role: UserRole, permission: string): boolean {
    const permissions = ROLE_PERMISSIONS[role];
    return permissions ? permissions.includes(permission) : false;
  }

  bootstrapAdmin(): void {
    const adminEmail = process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
    const adminPassword = process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
    const adminRole = (process.env.AUTH_BOOTSTRAP_ADMIN_ROLE as UserRole) || UserRole.ADMIN;

    if (!adminEmail || !adminPassword) {
      const userCount = (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
      if (userCount === 0) {
        if (process.env.NODE_ENV === 'production') {
          console.error('FATAL: No users exist and AUTH_BOOTSTRAP_ADMIN_EMAIL/PASSWORD not provided. Cannot authenticate.');
          process.exit(1);
        }
        console.warn('No users exist and no bootstrap credentials configured. Set AUTH_BOOTSTRAP_ADMIN_EMAIL and AUTH_BOOTSTRAP_ADMIN_PASSWORD to create an admin user.');
      }
      return;
    }

    const existing = this.findUserByEmail(adminEmail);
    if (existing) {
      console.log(`Bootstrap: user ${adminEmail} already exists, skipping.`);
      return;
    }

    this.createUser(adminEmail, adminPassword, adminRole);
    console.log(`Bootstrap: admin user ${adminEmail} created with role ${adminRole}.`);
  }
}