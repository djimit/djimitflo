import express from 'express';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb } from './helpers/test-db';
import { createLearningRoutes } from '../routes/learning';
import { createRoutes } from '../routes';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';

describe('learning cognitive integration', () => {
  it('extracts cognitive patterns after persisting a learning', () => {
    const db = createTestDb();
    const extractPatterns = vi.fn(() => [{ id: 'pattern-1' }]);
    const router = createLearningRoutes(db, undefined, { extractPatterns } as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === '/' && entry.route.methods.post);
    const handler = layer.route.stack.at(-1).handle;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();

    handler({ body: { title: 'Reusable lesson' } }, { status, json }, vi.fn());

    expect(extractPatterns).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].patterns).toEqual([{ id: 'pattern-1' }]);
    db.close();
  });

  // Regression: createRoutes() used to construct its own, never-started
  // CognitiveLoopClosureService, so /learning's extractPatterns() always
  // read an empty in-memory episode buffer and returned [] in production —
  // a genuine call to a real method, but on a disconnected instance. This
  // is a real end-to-end HTTP test (not a mocked handler) proving createRoutes
  // threads a caller-provided instance through to /learning instead of
  // constructing a fresh, never-started one internally.
  describe('createRoutes cognitiveLoop wiring', () => {
    let server: Server;

    afterEach(() => {
      server?.close();
    });

    it('routes /learning through the CognitiveLoopClosureService instance injected into createRoutes', async () => {
      const db = createTestDb();
      const authService = new AuthService(db);
      const admin = authService.createUser('cognitive-wiring@test.local', 'pass123', 'admin');
      const token = authService.generateToken(admin);
      const auth = createAuthMiddleware(authService);

      const cognitiveLoop = new CognitiveLoopClosureService(db);
      const extractSpy = vi.spyOn(cognitiveLoop, 'extractPatterns');

      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createRoutes(db, undefined, authService, auth, undefined, undefined, undefined, undefined, cognitiveLoop)
      );
      server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
      });
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const res = await fetch(`${baseUrl}/api/learning`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Reusable lesson' }),
      });

      expect(res.status).toBe(201);
      // The spy is on the exact instance passed into createRoutes — if createRoutes
      // had constructed its own, never-started instance instead (the original
      // defect), this spy would never fire.
      expect(extractSpy).toHaveBeenCalledOnce();
      db.close();
    });
  });
});
