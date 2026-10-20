import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@league/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@league/io': new URL('./packages/io/src/index.ts', import.meta.url).pathname,
      '@league/engine': new URL('./packages/engine/src/index.ts', import.meta.url).pathname,
    },
  },
});
