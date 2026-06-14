import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/connector-sdk',
  'packages/connectors/*',
  'packages/apple-bridge',
  'apps/api',
  'apps/web',
]);
