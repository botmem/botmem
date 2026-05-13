import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'path';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@botmem/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.module.ts',
        'src/**/*.controller.ts',
        'src/**/*.guard.ts',
        'src/**/*.strategy.ts',
        'src/**/*.filter.ts',
        'src/**/*.decorator.ts',
        'src/**/dto/**',
        'src/main.ts',
        'src/app.module.ts',
        'src/config/**',
        'src/db/migrations/**',
        'src/db/schema.ts',
        'src/events/**',
        'src/mcp/**',
        'src/plugins/plugin.types.ts',
        'src/user-auth/firebase-auth.service.ts',
        'src/db/db.service.ts',
        'src/db/rls.context.ts',
        'src/db/rls.interceptor.ts',
        'src/db/logging.service.ts',
        'src/analytics/posthog-logger.service.ts',
        'src/demo/demo.service.ts',
        'src/geo/geo.service.ts',
        'src/apple-tunnel/**',
        'src/memory/memory.processor.ts',
        'src/memory/decay.processor.ts',
        'src/memory/pg-search.service.ts',
        'src/plugins/connector-runtime.service.ts',
        'src/startup/**',
        'src/tracing/**',
        'src/utils/**',
        'src/scripts/**',
        'src/billing/**',
      ],
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 65,
        lines: 65,
      },
    },
  },
});
