import type { Database } from 'better-sqlite3';

/**
 * Pull-only mirror of the Djimit agent registry (`AGENT_REGISTRY_URL`, e.g. http://100.86.47.122:8088) into
 * `registry_agents`, so Djimitflo can show the ecosystem's nodes/agents and their deployed versions.
 * Deliberately separate from the `agents` table (those are Djimitflo's own workers). Default off: unset URL.
 */
export const registryUrl = (): string | undefined => process.env.AGENT_REGISTRY_URL?.replace(/\/$/, '') || undefined;

export class AgentRegistrySyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database, private readonly fetchFn: typeof fetch = fetch) {}

  start(intervalMs = 5 * 60_000): void {
    if (this.timer || !registryUrl()) return;
    void this.sync().catch(() => undefined);
    this.timer = setInterval(() => void this.sync().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async sync(): Promise<{ synced: number; status: 'DISABLED' | 'OK' | 'ERROR'; error?: string }> {
    const base = registryUrl();
    if (!base) return { synced: 0, status: 'DISABLED' };
    try {
      const response = await this.fetchFn(`${base}/agents`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`registry returned ${response.status}`);
      const list = await response.json();
      if (!Array.isArray(list)) throw new Error('registry did not return a list');
      const upsert = this.db.prepare(`INSERT INTO registry_agents (name, host, runtime, framework, version, capabilities_json, api_endpoint, raw_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET host=excluded.host, runtime=excluded.runtime, framework=excluded.framework, version=excluded.version,
          capabilities_json=excluded.capabilities_json, api_endpoint=excluded.api_endpoint, raw_json=excluded.raw_json, synced_at=excluded.synced_at`);
      const now = new Date().toISOString();
      let synced = 0;
      this.db.transaction(() => {
        for (const a of list as Array<Record<string, unknown>>) {
          if (!a || typeof a.name !== 'string' || !a.name) continue;
          upsert.run(a.name, String(a.host ?? ''), String(a.runtime ?? ''), String(a.framework ?? ''), String(a.version ?? ''),
            JSON.stringify(Array.isArray(a.capabilities) ? a.capabilities : []), String(a.api_endpoint ?? ''), JSON.stringify(a).slice(0, 20_000), now);
          synced++;
        }
      })();
      return { synced, status: 'OK' };
    } catch (err) {
      return { synced: 0, status: 'ERROR', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
  }

  list(): unknown[] { return this.db.prepare('SELECT name, host, runtime, framework, version, capabilities_json, api_endpoint, synced_at FROM registry_agents ORDER BY name').all(); }
}
