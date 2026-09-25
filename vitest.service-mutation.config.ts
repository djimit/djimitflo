import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: [process.env.MUTATE_TEST ?? 'none'], testTimeout: 30_000 } });
