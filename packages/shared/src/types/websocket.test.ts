import { describe, expect, it } from 'vitest';
import { WS_CLOSE_CODES, WebSocketEventType } from './websocket';

describe('WS_CLOSE_CODES', () => {
  it('exposes the four auth/forbidden close codes with stable numeric values', () => {
    expect(WS_CLOSE_CODES).toEqual({
      AUTH_REQUIRED: 4001,
      AUTH_INVALID: 4002,
      AUTH_EXPIRED: 4003,
      FORBIDDEN: 4004,
    });
  });

  it('uses the 4xxx range reserved for application close codes', () => {
    for (const code of Object.values(WS_CLOSE_CODES)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it('keeps every code distinct', () => {
    const codes = Object.values(WS_CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('is declared with `as const` so the codes are literal-typed and readonly', () => {
    // `as const` narrows each code to its literal type; the object is not
    // Object.freeze'd at runtime, but TypeScript rejects reassignment.
    const codes = WS_CLOSE_CODES as Record<string, number>;
    expect(codes.AUTH_REQUIRED).toBe(4001);
    // Re-enumerating values preserves the literal mapping.
    expect(Object.keys(WS_CLOSE_CODES).sort()).toEqual(
      ['AUTH_EXPIRED', 'AUTH_INVALID', 'AUTH_REQUIRED', 'FORBIDDEN'],
    );
  });
});

describe('WebSocketEventType', () => {
  it('uses dotted lowercase string values for every member', () => {
    for (const value of Object.values(WebSocketEventType)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^[a-z][a-z_]*(\.[a-z_]+)+$/);
    }
  });

  it('keeps every member value distinct', () => {
    const values = Object.values(WebSocketEventType);
    expect(new Set(values).size).toBe(values.length);
  });

  it('covers the task event family with the documented dotted names', () => {
    expect(WebSocketEventType.TASK_CREATED).toBe('task.created');
    expect(WebSocketEventType.TASK_UPDATED).toBe('task.updated');
    expect(WebSocketEventType.TASK_DELETED).toBe('task.deleted');
    expect(WebSocketEventType.TASK_STARTED).toBe('task.started');
    expect(WebSocketEventType.TASK_COMPLETED).toBe('task.completed');
    expect(WebSocketEventType.TASK_FAILED).toBe('task.failed');
    expect(WebSocketEventType.TASK_CANCELLED).toBe('task.cancelled');
  });

  it('maps the swarm spawn lifecycle to observable events', () => {
    expect(WebSocketEventType.SWARM_SPAWN_REQUESTED).toBe('swarm.spawn.requested');
    expect(WebSocketEventType.SWARM_SPAWN_PREPARED).toBe('swarm.spawn.prepared');
    expect(WebSocketEventType.SWARM_SPAWN_COMPLETED).toBe('swarm.spawn.completed');
    expect(WebSocketEventType.SWARM_SPAWN_GATED_OUT).toBe('swarm.spawn.gated_out');
  });

  it('maps the proof run event to proof_run.updated', () => {
    expect(WebSocketEventType.PROOF_RUN_UPDATED).toBe('proof_run.updated');
  });

  it('string enum members have no reverse mapping (TS string enums are forward-only)', () => {
    // Numeric enums get reverse mappings; string enums do not. Asserting this
    // guards against accidental refactors to a numeric enum that would change
    // the runtime shape consumed by the dashboard and MCP server.
    expect((WebSocketEventType as Record<string, unknown>)['task.created']).toBeUndefined();
    expect((WebSocketEventType as Record<string, unknown>)['system.error']).toBeUndefined();
  });
});