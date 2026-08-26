const DEFAULT_MAX_CONCURRENCY = 4;

export function runtimeConcurrencyLimit(): number {
  const raw = process.env.RUNTIME_MAX_CONCURRENCY;
  if (!raw?.trim()) return DEFAULT_MAX_CONCURRENCY;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : DEFAULT_MAX_CONCURRENCY;
}

export class ConcurrencySemaphore {
  private readonly active = new Set<string>();
  private readonly queue: Array<{ id: string; resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly limit: () => number = runtimeConcurrencyLimit) {}

  get activeCount(): number {
    return this.active.size;
  }

  acquire(id: string): Promise<void> {
    if (this.active.has(id)) return Promise.resolve();
    if (this.active.size < this.limit()) {
      this.active.add(id);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.queue.push({ id, resolve, reject }));
  }

  release(id: string): void {
    if (!this.active.delete(id)) {
      const index = this.queue.findIndex((waiter) => waiter.id === id);
      if (index >= 0) this.queue.splice(index, 1);
      return;
    }
    const next = this.queue.shift();
    if (next) {
      this.active.add(next.id);
      next.resolve();
    }
  }

  cancel(id: string): void {
    const index = this.queue.findIndex((waiter) => waiter.id === id);
    if (index < 0) return;
    const [waiter] = this.queue.splice(index, 1);
    waiter.reject(new Error('RUNTIME_PERMIT_CANCELLED'));
  }
}

export const runtimeConcurrencySemaphore = new ConcurrencySemaphore();
