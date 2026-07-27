const DEFAULT_MAX_CONCURRENCY = 4;

const state: {
  active: Set<string>;
  queue: Array<{ id: string; resolve: () => void; reject: (error: Error) => void }>;
} = {
  active: new Set(),
  queue: [],
};

export function runtimeAdmissionLimit(): number {
  const raw = process.env.RUNTIME_MAX_CONCURRENCY;
  if (!raw?.trim()) return DEFAULT_MAX_CONCURRENCY;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : DEFAULT_MAX_CONCURRENCY;
}

export function acquireRuntimeAdmission(id: string): Promise<void> {
  if (state.active.has(id)) return Promise.resolve();
  if (state.active.size < runtimeAdmissionLimit()) {
    state.active.add(id);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    state.queue.push({ id, resolve, reject });
  });
}

export function releaseRuntimeAdmission(id: string): void {
  if (!state.active.delete(id)) {
    const queued = state.queue.findIndex((item) => item.id === id);
    if (queued >= 0) state.queue.splice(queued, 1);
    return;
  }
  const next = state.queue.shift();
  if (next) {
    state.active.add(next.id);
    next.resolve();
  }
}

export function cancelRuntimeAdmission(id: string): void {
  const queued = state.queue.findIndex((item) => item.id === id);
  if (queued >= 0) {
    const [waiter] = state.queue.splice(queued, 1);
    waiter.reject(new Error('RUNTIME_PERMIT_CANCELLED'));
  }
}

export function runtimeAdmissionSnapshot(): { active: string[]; queued: string[] } {
  return {
    active: [...state.active],
    queued: state.queue.map((item) => item.id),
  };
}
