import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/__tests__/**',
        'src/pages/**',
        'src/components/**',
        'src/mock/**',
        'src/main.tsx',
        'src/App.tsx',
        'src/router.tsx',
        'src/vite-env.d.ts',
        'src/lib/firebase.ts',
        'src/lib/posthog.ts',
        'src/lib/ws.ts',
      ],
      thresholds: {
        statements: 76,
        branches: 75,
        functions: 80,
        lines: 76,
      },
    },
  },
});
