import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRuntimeProfile,
  runtimeProfileEnablesAutonomy,
  runtimeProfileEnablesOperator,
} from '../config/runtime-profile';
import { createMetaOrchestrationRoutes } from '../routes/meta-orchestration';

describe('runtime profile', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  async function metaStats(
    metaOrchestration?: Parameters<typeof createMetaOrchestrationRoutes>[2],
  ): Promise<Response> {
    const app = express();
    app.use('/meta', createMetaOrchestrationRoutes(undefined, undefined, metaOrchestration));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const port = (server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}/meta/stats`);
  }

  it('defaults to api', () => {
    expect(resolveRuntimeProfile({})).toBe('api');
  });

  it('falls back to api for invalid values', () => {
    expect(resolveRuntimeProfile({ DJIMITFLO_RUNTIME_PROFILE: 'full-send' })).toBe('api');
  });

  it('enables operator and autonomous levels explicitly', () => {
    expect(runtimeProfileEnablesOperator('api')).toBe(false);
    expect(runtimeProfileEnablesOperator('operator')).toBe(true);
    expect(runtimeProfileEnablesOperator('autonomous')).toBe(true);
    expect(runtimeProfileEnablesAutonomy('operator')).toBe(false);
    expect(runtimeProfileEnablesAutonomy('autonomous')).toBe(true);
  });

  it('keeps profile-independent routes mounted but reports autonomous capability as disabled', async () => {
    const response = await metaStats();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });

  it('reports injected autonomous capability as enabled', async () => {
    const meta = {
      getStats: () => ({ outcomes: 3 }),
    } as unknown as NonNullable<Parameters<typeof createMetaOrchestrationRoutes>[2]>;
    const response = await metaStats(meta);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: true, outcomes: 3 });
  });
});
