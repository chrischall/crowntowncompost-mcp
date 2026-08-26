import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Forces the session cache off, pins its path into a temp dir, and fails the
    // suite if anything reached the real ~/.crowntowncompost-mcp — see tests/_setup.ts.
    setupFiles: ['./tests/_setup.ts'],
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
