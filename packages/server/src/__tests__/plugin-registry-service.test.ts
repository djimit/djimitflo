import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PluginRegistryService } from '../services/plugin-registry-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createHash } from 'crypto';

let db: Database.Database;
let registry: PluginRegistryService;

function makeSignature(id: string, name: string, version: string, capabilities: string[]): string {
  const data = `${id}-${name}-${version}-${capabilities.join(',')}`;
  return createHash('sha256').update(data).digest('hex');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  registry = new PluginRegistryService(db);
});

afterEach(() => {
  db?.close();
});

describe('G51: Plugin Registry', () => {
  it('installs plugin with valid signature as inactive (quarantine first)', () => {
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      capabilities: ['test-cap'],
      dependencies: [],
      permissions: ['spawn_runtime_worker'],
      signature: makeSignature('test-plugin', 'Test Plugin', '1.0.0', ['test-cap']),
      createdAt: new Date().toISOString(),
    };
    registry.installPlugin(manifest);
    // SECURITY: plugins are installed as inactive — explicit enable required
    expect(registry.getPluginStatus('test-plugin')).toBe('inactive');
    registry.enablePlugin('test-plugin');
    expect(registry.getPluginStatus('test-plugin')).toBe('active');
  });

  it('rejects plugin with invalid signature', () => {
    const manifest = {
      id: 'bad-plugin',
      name: 'Bad Plugin',
      version: '1.0.0',
      capabilities: ['bad-cap'],
      dependencies: [],
      permissions: [],
      signature: 'invalid-signature',
      createdAt: new Date().toISOString(),
    };
    expect(() => registry.installPlugin(manifest)).toThrow('Invalid plugin signature');
  });

  it('unloadPlugin sets status to inactive', () => {
    const manifest = {
      id: 'unload-plugin',
      name: 'Unload Plugin',
      version: '1.0.0',
      capabilities: ['unload-cap'],
      dependencies: [],
      permissions: [],
      signature: makeSignature('unload-plugin', 'Unload Plugin', '1.0.0', ['unload-cap']),
      createdAt: new Date().toISOString(),
    };
    registry.installPlugin(manifest);
    registry.unloadPlugin('unload-plugin');
    expect(registry.getPluginStatus('unload-plugin')).toBe('inactive');
  });

  it('loadPlugin sets status to active', () => {
    const manifest = {
      id: 'load-plugin',
      name: 'Load Plugin',
      version: '1.0.0',
      capabilities: ['load-cap'],
      dependencies: [],
      permissions: [],
      signature: makeSignature('load-plugin', 'Load Plugin', '1.0.0', ['load-cap']),
      createdAt: new Date().toISOString(),
    };
    registry.installPlugin(manifest);
    registry.unloadPlugin('load-plugin');
    registry.loadPlugin('load-plugin');
    expect(registry.getPluginStatus('load-plugin')).toBe('active');
  });

  it('listPlugins returns all plugins', () => {
    const m1 = { id: 'p1', name: 'P1', version: '1.0', capabilities: ['c1'], dependencies: [], permissions: [], signature: makeSignature('p1', 'P1', '1.0', ['c1']), createdAt: '' };
    const m2 = { id: 'p2', name: 'P2', version: '1.0', capabilities: ['c2'], dependencies: [], permissions: [], signature: makeSignature('p2', 'P2', '1.0', ['c2']), createdAt: '' };
    registry.installPlugin(m1);
    registry.installPlugin(m2);
    const plugins = registry.listPlugins();
    expect(plugins.length).toBe(2);
  });

  it('getPlugin returns plugin details', () => {
    const manifest = {
      id: 'detail-plugin',
      name: 'Detail Plugin',
      version: '2.0.0',
      capabilities: ['detail-cap'],
      dependencies: [],
      permissions: ['spawn_runtime_worker'],
      signature: makeSignature('detail-plugin', 'Detail Plugin', '2.0.0', ['detail-cap']),
      createdAt: new Date().toISOString(),
    };
    registry.installPlugin(manifest);
    const plugin = registry.getPlugin('detail-plugin');
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('Detail Plugin');
    expect(plugin!.version).toBe('2.0.0');
  });

  it('getPluginStatus returns error for unknown', () => {
    expect(registry.getPluginStatus('nonexistent')).toBe('error');
  });

  it('rejects ed25519 signature without trusted keys configured', () => {
    const manifest = {
      id: 'ed25519-plugin',
      name: 'Ed25519 Plugin',
      version: '1.0.0',
      capabilities: ['ed-cap'],
      dependencies: [],
      permissions: [],
      signature: 'ed25519:abc123',
      createdAt: '',
    };
    // SECURITY: bare ed25519: prefix without trusted keys must be rejected
    expect(() => registry.installPlugin(manifest)).toThrow('Invalid plugin signature');
  });

  it('installPlugin creates capabilities in swarm_capabilities', () => {
    const manifest = {
      id: 'cap-plugin',
      name: 'Cap Plugin',
      version: '1.0.0',
      capabilities: ['new-cap-1', 'new-cap-2'],
      dependencies: [],
      permissions: [],
      signature: makeSignature('cap-plugin', 'Cap Plugin', '1.0.0', ['new-cap-1', 'new-cap-2']),
      createdAt: new Date().toISOString(),
    };
    registry.installPlugin(manifest);
    const cap = db.prepare("SELECT id FROM swarm_capabilities WHERE id = 'new-cap-1'").get();
    expect(cap).toBeDefined();
  });
});
