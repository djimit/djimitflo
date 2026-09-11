import { defineConfig } from 'vitest/config';

// Run maintained sources, not the stale tracked JavaScript compilation beside them.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
