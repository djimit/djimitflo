import os from 'os';

export interface WorkerTaskInput<T> {
  id: string;
  input: T;
}

export interface WorkerTaskResult<T, R> {
  id: string;
  input: T;
  result?: R;
  error?: Error;
  attempts: number;
}

export interface WorkerPoolOptions {
  concurrency?: number;
  taskTimeoutMs?: number;
  maxRetries?: number;
}

interface QueueItem<T> {
  task: WorkerTaskInput<T>;
  attempts: number;
}

export class WorkerPool {
  private concurrency: number;
  private taskTimeoutMs: number;
  private maxRetries: number;
  private stats = { completed: 0, failed: 0, retried: 0 };

  constructor(options: WorkerPoolOptions = {}) {
    this.concurrency = Math.min(options.concurrency ?? os.cpus().length * 2, 10);
    this.taskTimeoutMs = options.taskTimeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async execute<T, R>(
    tasks: WorkerTaskInput<T>[],
    fn: (input: T) => Promise<R>
  ): Promise<WorkerTaskResult<T, R>[]> {
    if (tasks.length === 0) return [];

    const results = new Map<string, WorkerTaskResult<T, R>>();
    const queue: QueueItem<T>[] = tasks.map(t => ({ task: t, attempts: 1 }));
    let activeCount = 0;
    let settled = 0;
    const total = tasks.length;

    return new Promise((resolve) => {
      const startNext = () => {
        while (activeCount < this.concurrency && queue.length > 0) {
          const item = queue.shift()!;
          activeCount++;
          runTask(item);
        }
      };

      const runTask = async (item: QueueItem<T>) => {
        try {
          const result = await Promise.race([
            fn(item.task.input),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('TIMEOUT')), this.taskTimeoutMs)
            ),
          ]);

          results.set(item.task.id, { id: item.task.id, input: item.task.input, result, attempts: item.attempts });
          this.stats.completed++;
        } catch (error) {
          if (item.attempts <= this.maxRetries) {
            this.stats.retried++;
            queue.push({ task: item.task, attempts: item.attempts + 1 });
            activeCount--;
            startNext();
            return;
          }

          results.set(item.task.id, {
            id: item.task.id,
            input: item.task.input,
            error: error instanceof Error ? error : new Error(String(error)),
            attempts: item.attempts,
          });
          this.stats.failed++;
        }

        activeCount--;
        settled++;
        if (settled >= total) {
          resolve(Array.from(results.values()));
        } else {
          startNext();
        }
      };

      startNext();
    });
  }

  getStats(): { completed: number; failed: number; retried: number } {
    return { ...this.stats };
  }

  shutdown(): void {
    this.stats = { completed: 0, failed: 0, retried: 0 };
  }
}
