import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/connector-sdk',
  'packages/connectors/*',
  'apps/api',
  'apps/web',
]);
