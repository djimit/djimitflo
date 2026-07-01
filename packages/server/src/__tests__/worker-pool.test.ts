import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../services/worker-pool';

describe('G98: Worker Pool', () => {
  it('executes tasks in parallel', async () => {
    const pool = new WorkerPool({ concurrency: 3, taskTimeoutMs: 5000 });
    const tasks = [
      { id: '1', input: 1 },
      { id: '2', input: 2 },
      { id: '3', input: 3 },
    ];

    const results = await pool.execute(tasks, async (n) => n * 2);

    expect(results.length).toBe(3);
    expect(results.find(r => r.id === '1')?.result).toBe(2);
    expect(results.find(r => r.id === '2')?.result).toBe(4);
    expect(results.find(r => r.id === '3')?.result).toBe(6);
  });

  it('respects concurrency limit', async () => {
    const pool = new WorkerPool({ concurrency: 2, taskTimeoutMs: 5000 });
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, (_, i) => ({ id: String(i), input: i }));

    await pool.execute(tasks, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return n;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  }, 10000);

  it('retries failed tasks', async () => {
    const pool = new WorkerPool({ concurrency: 1, taskTimeoutMs: 5000, maxRetries: 2 });
    let attempts = 0;

    const tasks = [{ id: '1', input: 'test' }];
    const results = await pool.execute(tasks, async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'success';
    });

    expect(results[0].result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('marks task as failed after max retries', async () => {
    const pool = new WorkerPool({ concurrency: 1, taskTimeoutMs: 5000, maxRetries: 1 });

    const tasks = [{ id: '1', input: 'test' }];
    const results = await pool.execute(tasks, async () => {
      throw new Error('always fails');
    });

    expect(results[0].error).toBeDefined();
    expect(results[0].attempts).toBe(2);
  });

  it('handles timeout', async () => {
    const pool = new WorkerPool({ concurrency: 1, taskTimeoutMs: 100 });

    const tasks = [{ id: '1', input: 'test' }];
    const results = await pool.execute(tasks, async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return 'done';
    });

    expect(results[0].error).toBeDefined();
    expect(results[0].error?.message).toBe('TIMEOUT');
  });

  it('returns empty for empty tasks', async () => {
    const pool = new WorkerPool({ concurrency: 3 });
    const results = await pool.execute([], async (n) => n);
    expect(results).toEqual([]);
  });

  it('tracks stats', async () => {
    const pool = new WorkerPool({ concurrency: 2, taskTimeoutMs: 5000 });

    const tasks = [
      { id: '1', input: 1 },
      { id: '2', input: 2 },
    ];

    await pool.execute(tasks, async (n) => n * 2);

    const stats = pool.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
  });

  it('reports stats', () => {
    const pool = new WorkerPool({ concurrency: 2 });
    const stats = pool.getStats();
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.retried).toBe(0);
  });

  it('handles mixed success and failure', async () => {
    const pool = new WorkerPool({ concurrency: 2, taskTimeoutMs: 5000, maxRetries: 0 });

    const tasks = [
      { id: 'ok', input: 'good' },
      { id: 'fail', input: 'bad' },
    ];

    const results = await pool.execute(tasks, async (input) => {
      if (input === 'bad') throw new Error('fail');
      return 'success';
    });

    expect(results.find(r => r.id === 'ok')?.result).toBe('success');
    expect(results.find(r => r.id === 'fail')?.error).toBeDefined();
  });
});
