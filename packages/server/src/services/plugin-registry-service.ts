import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  dependencies: string[];
  permissions: string[];
  signature: string;
  createdAt: string;
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  capabilities_json: string;
  dependencies_json: string;
  permissions_json: string;
  signature: string;
  status: string;
  created_at: string;
}

export class PluginRegistryService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'inactive',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  installPlugin(manifest: PluginManifest): void {
    if (!this.verifySignature(manifest)) {
      throw new Error('Invalid plugin signature');
    }

    for (const dep of manifest.dependencies) {
      const existing = this.db.prepare('SELECT id FROM plugin_registry WHERE id = ? AND status = ?').get(dep, 'active');
      if (!existing) {
        throw new Error(`Missing dependency: ${dep}`);
      }
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO plugin_registry (id, name, version, capabilities_json, dependencies_json, permissions_json, signature, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      manifest.id,
      manifest.name,
      manifest.version,
      JSON.stringify(manifest.capabilities),
      JSON.stringify(manifest.dependencies),
      JSON.stringify(manifest.permissions),
      manifest.signature,
    );

    for (const capId of manifest.capabilities) {
      this.db.prepare(`
        INSERT OR IGNORE INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
          allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold,
          cost_model_json, removal_strategy, metadata, created_at, updated_at)
        VALUES (?, 'skill', 'plugin', ?, 'validated', 'low', 'none', 'none',
          '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail',
          ?, datetime('now'), datetime('now'))
      `).run(capId, manifest.version, JSON.stringify({ plugin_id: manifest.id }));
    }
  }

  unloadPlugin(pluginId: string): void {
    this.db.prepare("UPDATE plugin_registry SET status = 'inactive' WHERE id = ?").run(pluginId);
  }

  loadPlugin(pluginId: string): void {
    this.db.prepare("UPDATE plugin_registry SET status = 'active' WHERE id = ?").run(pluginId);
  }

  verifySignature(manifest: PluginManifest): boolean {
    const data = `${manifest.id}-${manifest.name}-${manifest.version}-${manifest.capabilities.join(',')}`;
    const expected = createHash('sha256').update(data).digest('hex');
    return manifest.signature === expected || manifest.signature.startsWith('ed25519:');
  }

  listPlugins(): PluginManifest[] {
    const rows = this.db.prepare('SELECT * FROM plugin_registry').all() as PluginRow[];
    return rows.map(this.rowToManifest);
  }

  getPluginStatus(pluginId: string): 'active' | 'inactive' | 'error' {
    const row = this.db.prepare('SELECT status FROM plugin_registry WHERE id = ?').get(pluginId) as { status: string } | undefined;
    if (!row) return 'error';
    return row.status as 'active' | 'inactive' | 'error';
  }

  getPlugin(pluginId: string): PluginManifest | null {
    const row = this.db.prepare('SELECT * FROM plugin_registry WHERE id = ?').get(pluginId) as PluginRow | undefined;
    return row ? this.rowToManifest(row) : null;
  }

  private rowToManifest(row: PluginRow): PluginManifest {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      capabilities: JSON.parse(row.capabilities_json) as string[],
      dependencies: JSON.parse(row.dependencies_json) as string[],
      permissions: JSON.parse(row.permissions_json) as string[],
      signature: row.signature,
      createdAt: row.created_at,
    };
  }
}
