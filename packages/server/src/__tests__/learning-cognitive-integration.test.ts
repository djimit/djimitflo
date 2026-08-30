import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createLearningRoutes } from '../routes/learning';

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
});
