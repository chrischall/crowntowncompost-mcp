import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The Worker connector suite runs under the Cloudflare Workers pool
    // (`vitest.workers.config.ts` / `npm run worker:test`), NOT the Node pool —
    // it imports `cloudflare:test`, which cannot load under Node.
    exclude: ['tests/worker.test.ts', 'node_modules/**'],
    coverage: {
      // src/worker.ts imports `agents`/`cloudflare:workers` and is exercised
      // only by the Workers-pool suite.
      exclude: ['src/worker.ts'],
    },
  },
});
