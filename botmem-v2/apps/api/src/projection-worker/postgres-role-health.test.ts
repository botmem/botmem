import { describe, expect, it, vi } from 'vitest';
import type { SqlClientPort, SqlPoolPort, SqlQueryConfig } from '../search/postgres-ports.js';
import {
  PostgresRuntimeRoleValidator,
  ProjectionDatabaseRoleError,
  type RuntimeDatabaseRole,
} from './postgres-role-health.js';

describe('PostgresRuntimeRoleValidator', () => {
  for (const role of [
    'botmem_api',
    'botmem_worker',
    'botmem_dispatcher',
    'botmem_commerce',
    'botmem_lifecycle',
    'botmem_identity_admin',
  ] satisfies RuntimeDatabaseRole[]) {
    it(`accepts an isolated ${role} login`, async () => {
      const validator = new PostgresRuntimeRoleValidator();
      await expect(
        validator.validate(rolePool(role), role, new AbortController().signal),
      ).resolves.toBeUndefined();
    });
  }

  it('rejects a login with cross-runtime, owner, migrator, superuser, or bypass membership', async () => {
    for (const unsafe of [
      { worker_member: true },
      { commerce_member: true },
      { lifecycle_member: true },
      { owner_member: true },
      { migrator_member: true },
      { is_superuser: true },
      { bypasses_rls: true },
    ]) {
      const validator = new PostgresRuntimeRoleValidator();
      await expect(
        validator.validate(
          rolePool('botmem_dispatcher', unsafe),
          'botmem_dispatcher',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ProjectionDatabaseRoleError);
    }
  });
});

function rolePool(
  role: RuntimeDatabaseRole,
  override: Readonly<Record<string, boolean>> = {},
): SqlPoolPort {
  const membership = {
    session_user: `${role}_login`,
    is_superuser: false,
    bypasses_rls: false,
    dispatcher_member: role === 'botmem_dispatcher',
    worker_member: role === 'botmem_worker',
    api_member: role === 'botmem_api',
    commerce_member: role === 'botmem_commerce',
    lifecycle_member: role === 'botmem_lifecycle',
    owner_member: false,
    identity_admin_member: role === 'botmem_identity_admin',
    migrator_member: false,
    ...override,
  };
  const client: SqlClientPort = {
    query: vi.fn(async (query: SqlQueryConfig) => {
      if (query.text.includes('FROM pg_roles')) return { rows: [membership], rowCount: 1 };
      if (query.text === 'SELECT current_user') {
        return { rows: [{ current_user: role }], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    }) as SqlClientPort['query'],
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client) };
}
