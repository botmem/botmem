import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'src/test-history-media.ts',
        'src/debug-lid.ts',
        'src/browser-auth-state.ts',
      ],
      thresholds: {
        statements: 76,
        branches: 72,
        functions: 78,
        lines: 76,
      },
    },
  },
});
