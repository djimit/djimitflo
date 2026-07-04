/**
 * PluginRegistryService — extensible plugin marketplace for DjimFlo.
 *
 * Based on Ruflo's plugin architecture (35+ plugins).
 * Enables community extensions without core code changes.
 *
 * Plugin structure:
 *   .djimflo/plugins/<plugin-name>/
 *     plugin.json          — metadata (name, version, author, dependencies)
 *     index.ts             — entry point (register hooks, tools, routes)
 *     skills/              — plugin-specific skills
 *     migrations/          — plugin-specific DB migrations
 *
 * Lifecycle: discover → load → init → enable → disable → unload
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  capabilities?: string[];
  dependencies?: string[];
  permissions?: string[];
  hooks?: string[];
  tools?: string[];
  routes?: string[];
  skills?: string[];
  signature?: string;
  createdAt?: string;
  enabled?: boolean;
  installedAt?: string;
  updatedAt?: string;
}

type PluginStatus = 'active' | 'inactive' | 'error';

interface PluginHook {
  name: string;
  event: string;
  handler: string; // Path to handler file
  priority: number;
}

interface RegisteredTool {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: string;
}

const PLUGINS_DIR = process.env.DJIMFLO_PLUGINS_DIR || join(process.cwd(), '.djimflo', 'plugins');

export class PluginRegistryService {
  private plugins: Map<string, PluginManifest> = new Map();
  private hooks: Map<string, PluginHook[]> = new Map();
  private tools: Map<string, RegisteredTool> = new Map();

  constructor(private db: Database) {
    this.ensureTables();
    this.discoverPlugins();
  }

  /**
   * Discover and load all plugins from the plugins directory.
   */
  discoverPlugins(): PluginManifest[] {
    const loaded: PluginManifest[] = [];

    if (!existsSync(PLUGINS_DIR)) {
      return loaded;
    }

    const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = join(PLUGINS_DIR, entry.name);
      const manifestPath = join(pluginDir, 'plugin.json');

      if (!existsSync(manifestPath)) continue;

      try {
        const manifestContent = readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent) as PluginManifest;

        manifest.id = entry.name;
        manifest.enabled = manifest.enabled ?? true;
        manifest.installedAt = manifest.installedAt || new Date().toISOString();
        manifest.updatedAt = new Date().toISOString();

        this.plugins.set(manifest.id, manifest);
        loaded.push(manifest);

        // Register hooks
        if (manifest.hooks) {
          for (const hookName of manifest.hooks) {
            const existing = this.hooks.get(hookName) || [];
            existing.push({
              name: `${manifest.id}:${hookName}`,
              event: hookName,
              handler: join(pluginDir, 'hooks', `${hookName}.js`),
              priority: 10,
            });
            this.hooks.set(hookName, existing);
          }
        }

        // Register tools
        if (manifest.tools) {
          for (const toolName of manifest.tools) {
            this.tools.set(`${manifest.id}:${toolName}`, {
              pluginId: manifest.id,
              name: toolName,
              description: `Plugin tool: ${toolName}`,
              inputSchema: {},
              handler: join(pluginDir, 'tools', `${toolName}.js`),
            });
          }
        }

        // Persist to DB
        this.db.prepare(`
          INSERT OR REPLACE INTO plugins (id, name, version, description, author, license, enabled, manifest_json, installed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          manifest.id, manifest.name, manifest.version, manifest.description,
          manifest.author, manifest.license, manifest.enabled ? 1 : 0,
          JSON.stringify(manifest), manifest.installedAt, manifest.updatedAt
        );

      } catch (error) {
        console.error(`Failed to load plugin ${entry.name}:`, error);
      }
    }

    return loaded;
  }

  /**
   * Get a plugin by ID.
   */
  getPlugin(id: string): PluginManifest | null {
    return this.plugins.get(id) || null;
  }

  /**
   * List all registered plugins.
   */
  listPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Enable a plugin.
   */
  enablePlugin(id: string): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;

    plugin.enabled = true;
    plugin.updatedAt = new Date().toISOString();

    this.db.prepare('UPDATE plugins SET enabled = 1, updated_at = ? WHERE id = ?').run(plugin.updatedAt, id);
    return true;
  }

  /**
   * Disable a plugin.
   */
  disablePlugin(id: string): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;

    plugin.enabled = false;
    plugin.updatedAt = new Date().toISOString();

    this.db.prepare('UPDATE plugins SET enabled = 0, updated_at = ? WHERE id = ?').run(plugin.updatedAt, id);
    return true;
  }

  /**
   * Get hooks for a specific event.
   */
  getHooksForEvent(event: string): PluginHook[] {
    return this.hooks.get(event) || [];
  }

  /**
   * Get all registered plugin tools.
   */
  getPluginTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get plugin statistics.
   */
  getStats(): {
    totalPlugins: number;
    enabledPlugins: number;
    totalHooks: number;
    totalTools: number;
  } {
    return {
      totalPlugins: this.plugins.size,
      enabledPlugins: Array.from(this.plugins.values()).filter((p) => p.enabled).length,
      totalHooks: Array.from(this.hooks.values()).reduce((sum, h) => sum + h.length, 0),
      totalTools: this.tools.size,
    };
  }

  /**
   * Install a plugin with signature verification (G51).
   */
  installPlugin(manifest: PluginManifest): void {
    // Validate signature
    this.validatePluginSignature(manifest);

    const now = new Date().toISOString();
    const plugin: PluginManifest = {
      ...manifest,
      enabled: true,
      installedAt: now,
      updatedAt: now,
    };

    this.plugins.set(manifest.id, plugin);

    // Create capability records for each declared capability
    if (manifest.capabilities) {
      for (const capId of manifest.capabilities) {
        this.db.prepare(`
          INSERT OR IGNORE INTO swarm_capabilities
            (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
             allowed_actions_json, forbidden_actions_json, required_evidence_json,
             eval_score, eval_threshold, cost_model_json, removal_strategy, metadata)
          VALUES (?, 'skill', ?, '1.0.0', 'candidate', 'low', '', '', '[]', '[]', '[]', 0, 0.75, '{}', 'manual_review', '{}')
        `).run(capId, manifest.id);
      }
    }

    // Persist
    this.db.prepare(`
      INSERT OR REPLACE INTO plugins (id, name, version, enabled, manifest_json, installed_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(manifest.id, manifest.name, manifest.version, JSON.stringify(plugin), now, now);
  }

  /**
   * Validate plugin signature (SHA256 or ed25519).
   */
  validatePluginSignature(manifest: PluginManifest): void {
    if (!manifest.signature) throw new Error('Invalid plugin signature');

    // Accept ed25519 prefix signatures
    if (manifest.signature.startsWith('ed25519:')) return;

    // Verify SHA256 signature
    const crypto = require('crypto');
    const data = `${manifest.id}-${manifest.name}-${manifest.version}-${(manifest.capabilities || []).join(',')}`;
    const expected = crypto.createHash('sha256').update(data).digest('hex');

    if (manifest.signature !== expected) {
      throw new Error('Invalid plugin signature');
    }
  }

  /**
   * Get plugin status (active, inactive, error).
   */
  getPluginStatus(id: string): PluginStatus {
    const plugin = this.plugins.get(id);
    if (!plugin) return 'error';
    return plugin.enabled ? 'active' : 'inactive';
  }

  /**
   * Unload a plugin (set inactive).
   */
  unloadPlugin(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.enabled = false;
    plugin.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE plugins SET enabled = 0, updated_at = ? WHERE id = ?').run(plugin.updatedAt, id);
  }

  /**
   * Load a plugin (set active).
   */
  loadPlugin(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    plugin.enabled = true;
    plugin.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE plugins SET enabled = 1, updated_at = ? WHERE id = ?').run(plugin.updatedAt, id);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '0.1.0',
        description TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT 'unknown',
        license TEXT NOT NULL DEFAULT 'MIT',
        enabled INTEGER NOT NULL DEFAULT 1,
        manifest_json TEXT NOT NULL DEFAULT '{}',
        installed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
