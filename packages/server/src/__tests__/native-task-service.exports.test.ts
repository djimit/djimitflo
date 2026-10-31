import { describe, expect, it, vi } from 'vitest';
import { WebSocketEventType } from '@djimitflo/shared';
import { parseNativeTask, notifyNativeTaskCreated } from '../services/native-task-service';

describe('native-task-service exports', () => {
  describe('parseNativeTask', () => {
    it('parses tags and metadata JSON and passes through scalar columns', () => {
      const row = {
        id: 't-1',
        title: 'Do a thing',
        tags: '["alpha","beta"]',
        metadata: '{"k":"v"}',
        status: 'pending',
      };
      const task = parseNativeTask(row);
      expect(task.id).toBe('t-1');
      expect(task.title).toBe('Do a thing');
      expect(task.status).toBe('pending');
      expect(task.tags).toEqual(['alpha', 'beta']);
      expect(task.metadata).toEqual({ k: 'v' });
    });

    it('defaults tags to an empty array when missing or blank', () => {
      expect(parseNativeTask({ id: 't-2', tags: '' }).tags).toEqual([]);
      expect(parseNativeTask({ id: 't-3' }).tags).toEqual([]);
    });

    it('defaults metadata to an empty object when missing or blank', () => {
      expect(parseNativeTask({ id: 't-4', metadata: '' }).metadata).toEqual({});
      expect(parseNativeTask({ id: 't-5' }).metadata).toEqual({});
    });

    it('defaults created_by, owner_user_id and updated_by to null when absent', () => {
      const task = parseNativeTask({ id: 't-6' });
      expect(task.created_by).toBeNull();
      expect(task.owner_user_id).toBeNull();
      expect(task.updated_by).toBeNull();
    });

    it('preserves provided created_by, owner_user_id and updated_by', () => {
      const task = parseNativeTask({ id: 't-7', created_by: 'u-1', owner_user_id: 'u-2', updated_by: 'u-3' });
      expect(task.created_by).toBe('u-1');
      expect(task.owner_user_id).toBe('u-2');
      expect(task.updated_by).toBe('u-3');
    });
  });

  describe('notifyNativeTaskCreated', () => {
    const task = { id: 't-1', title: 'Hi' } as any;

    it('broadcasts a TASK_CREATED event with the task and a timestamp when ws is given', () => {
      const broadcastTaskEvent = vi.fn();
      const ws = { broadcastTaskEvent } as any;
      const now = '2026-10-31T00:00:00.000Z';
      notifyNativeTaskCreated(task, ws, now);
      expect(broadcastTaskEvent).toHaveBeenCalledOnce();
      expect(broadcastTaskEvent).toHaveBeenCalledWith(task, {
        type: WebSocketEventType.TASK_CREATED,
        payload: { task },
        timestamp: now,
      });
    });

    it('uses the current time when no timestamp is supplied', () => {
      const broadcastTaskEvent = vi.fn();
      const ws = { broadcastTaskEvent } as any;
      const before = Date.now();
      notifyNativeTaskCreated(task, ws);
      const after = Date.now();
      expect(broadcastTaskEvent).toHaveBeenCalledOnce();
      const ts = broadcastTaskEvent.mock.calls[0][1].timestamp;
      const t = Date.parse(ts);
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(after + 1000);
    });

    it('is a no-op when no websocket service is provided', () => {
      expect(() => notifyNativeTaskCreated(task)).not.toThrow();
      expect(() => notifyNativeTaskCreated(task, undefined)).not.toThrow();
    });
  });
});