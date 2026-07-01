import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AuditLogEntry {
  id: string;
  action: string;
  component: string;
  details: Record<string, unknown>;
  actor: string;
  timestamp: string;
}

export interface SafetyStatus {
  enabled: boolean;
  mutationsToday: number;
  mutationsLimit: number;
  lastMutation: string | null;
  frozenComponents: string[];
}

export class RsiSafetyGuard {
  private mutationsLimit = 5;
  private frozenComponents = ['auth-service', 'authorization-service', 'audit-service', 'rate-limiter', 'security-scanning-agent'];
  private enabled = true;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rsi_audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        component TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_rsi_audit_created ON rsi_audit_log(created_at DESC)');
  }

  canMutate(component: string): { allowed: boolean; reason?: string } {
    if (!this.enabled) {
      return { allowed: false, reason: 'RSI is disabled via kill switch' };
    }

    if (this.isFrozen(component)) {
      return { allowed: false, reason: `Component "${component}" is frozen (security/audit boundary)` };
    }

    const todayCount = this.getTodayMutationCount();
    if (todayCount >= this.mutationsLimit) {
      return { allowed: false, reason: `Daily mutation budget exhausted (${todayCount}/${this.mutationsLimit})` };
    }

    return { allowed: true };
  }

  logAction(action: string, component: string, details: Record<string, unknown>, actor: string = 'system'): void {
    this.db.prepare(`
      INSERT INTO rsi_audit_log (id, action, component, details_json, actor)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), action, component, JSON.stringify(details), actor);
  }

  getAuditLog(limit: number = 50): AuditLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM rsi_audit_log ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{
      id: string; action: string; component: string; details_json: string; actor: string; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      component: r.component,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
      actor: r.actor,
      timestamp: r.created_at,
    }));
  }

  getStatus(): SafetyStatus {
    return {
      enabled: this.enabled,
      mutationsToday: this.getTodayMutationCount(),
      mutationsLimit: this.mutationsLimit,
      lastMutation: this.getLastMutation(),
      frozenComponents: [...this.frozenComponents],
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logAction('kill_switch', 'rsi-safety-guard', { enabled }, 'operator');
  }

  isFrozen(component: string): boolean {
    return this.frozenComponents.some(f => component.includes(f) || f.includes(component));
  }

  private getTodayMutationCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM rsi_audit_log WHERE action = 'mutation' AND created_at > datetime('now', 'start of day')"
    ).get() as { c: number };

    return row.c;
  }

  private getLastMutation(): string | null {
    const row = this.db.prepare(
      "SELECT created_at FROM rsi_audit_log WHERE action = 'mutation' ORDER BY created_at DESC LIMIT 1"
    ).get() as { created_at: string } | undefined;

    return row?.created_at ?? null;
  }
}
