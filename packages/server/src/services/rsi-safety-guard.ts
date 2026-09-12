import type { Database } from 'better-sqlite3';

export interface SafetyStatus {
  enabled: boolean;
  mutationsToday: number;
  mutationsLimit: number;
  lastMutation: string | null;
  frozenComponents: string[];
  auditLogEntries: number;
}

export class RsiSafetyGuard {
  private frozenComponents = ['auth-service', 'authorization-service', 'audit-service', 'rate-limiter', 'security-scanning-agent'];
  private mutationsLimit = 5;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS rsi_audit_log (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, component TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO system_state (key, value) VALUES ('rsi_safety_enabled', 'true');
    `);
  }

  canMutate(component: string): { allowed: boolean; reason?: string } {
    if (!this.isEnabled()) return { allowed: false, reason: 'RSI is disabled via kill switch' };
    if (this.isFrozen(component)) return { allowed: false, reason: `Component "${component}" is frozen (security/audit boundary)` };
    const todayCount = this.getTodayMutationCount();
    if (todayCount >= this.mutationsLimit) return { allowed: false, reason: `Daily mutation budget exhausted (${todayCount}/${this.mutationsLimit})` };
    return { allowed: true };
  }

  getStatus(): SafetyStatus {
    return {
      enabled: this.isEnabled(),
      mutationsToday: this.getTodayMutationCount(),
      mutationsLimit: this.mutationsLimit,
      lastMutation: this.getLastMutation(),
      frozenComponents: [...this.frozenComponents],
      auditLogEntries: this.getAuditLogCount(),
    };
  }

  setEnabled(enabled: boolean): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE system_state SET value = ?, updated_at = datetime('now') WHERE key = 'rsi_safety_enabled'")
        .run(String(enabled));
      this.logAction('kill_switch', 'rsi-safety-guard', { enabled });
    })();
  }

  private isEnabled(): boolean {
    const row = this.db.prepare("SELECT value FROM system_state WHERE key = 'rsi_safety_enabled'").get() as { value: string } | undefined;
    return row?.value === 'true';
  }

  isFrozen(component: string): boolean {
    return this.frozenComponents.some(f => component.includes(f) || f.includes(component));
  }

  logAction(action: string, component: string, details: Record<string, unknown> = {}, actor: string = 'system'): void {
    const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare('INSERT INTO rsi_audit_log (id, action, component, details_json, actor) VALUES (?, ?, ?, ?, ?)').run(id, action, component, JSON.stringify(details), actor);
  }

  getAuditLog(limit: number = 50): Array<{ id: string; action: string; component: string; actor: string; details: Record<string, unknown>; timestamp: string }> {
    const rows = this.db.prepare('SELECT * FROM rsi_audit_log ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string; action: string; component: string; details_json: string; actor: string; created_at: string }>;
    return rows.map(r => ({ id: r.id, action: r.action, component: r.component, actor: r.actor, details: JSON.parse(r.details_json) as Record<string, unknown>, timestamp: r.created_at }));
  }

  private getTodayMutationCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM rsi_audit_log WHERE action = 'mutation' AND created_at > datetime('now', 'start of day')").get() as { c: number };
    return row.c;
  }

  private getLastMutation(): string | null {
    const row = this.db.prepare("SELECT created_at FROM rsi_audit_log WHERE action = 'mutation' ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  private getAuditLogCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM rsi_audit_log').get() as { c: number };
    return row.c;
  }
}
