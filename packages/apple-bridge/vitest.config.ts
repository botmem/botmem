import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/local-index/**/*.ts'],
      exclude: [
        'src/local-index/**/__tests__/**',
        'src/local-index/index.ts',
        'src/local-index/types.ts',
      ],
    },
  },
});
