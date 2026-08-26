export class ConcurrencySemaphore {
  private readonly active = new Set<string>();
  private readonly queue: Array<{ leaseId: string; resolve: () => void; reject: (error: Error) => void }> = [];

  has(id: string): boolean {
    return this.active.has(id) || this.queue.some((waiter) => waiter.leaseId === id);
  }

  activeCount(): number {
    return this.active.size;
  }

  acquire(id: string, limit: number): Promise<void> {
    if (this.active.has(id)) return Promise.resolve();
    if (this.active.size < limit) {
      this.active.add(id);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.queue.push({ leaseId: id, resolve, reject }));
  }

  release(id: string): void {
    if (!this.active.delete(id)) return;
    const next = this.queue.shift();
    if (next) {
      this.active.add(next.leaseId);
      next.resolve();
    }
  }

  cancel(id: string, message = 'CONCURRENCY_PERMIT_CANCELLED'): void {
    const index = this.queue.findIndex((waiter) => waiter.leaseId === id);
    if (index < 0) return;
    const [waiter] = this.queue.splice(index, 1);
    waiter.reject(new Error(message));
  }
}
