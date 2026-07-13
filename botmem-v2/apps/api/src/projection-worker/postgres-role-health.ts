import type { SqlPoolPort } from '../search/postgres-ports.js';
import type { RuntimeDatabaseHealthPort } from './ports.js';

export type RuntimeDatabaseRole =
  | 'botmem_api'
  | 'botmem_worker'
  | 'botmem_dispatcher'
  | 'botmem_commerce'
  | 'botmem_lifecycle'
  | 'botmem_identity_admin';

export type ProjectionDatabaseRole = Extract<
  RuntimeDatabaseRole,
  'botmem_dispatcher' | 'botmem_worker'
>;

interface RoleRow {
  readonly session_user: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
  readonly dispatcher_member: boolean;
  readonly worker_member: boolean;
  readonly api_member: boolean;
  readonly commerce_member: boolean;
  readonly lifecycle_member: boolean;
  readonly owner_member: boolean;
  readonly identity_admin_member: boolean;
  readonly migrator_member: boolean;
}

/** Fails closed if either runtime login can assume any unintended Botmem role. */
export class PostgresRuntimeRoleValidator {
  constructor(private readonly statementTimeoutMs = 3_000) {}

  async validate(
    pool: SqlPoolPort,
    expectedRole: RuntimeDatabaseRole,
    signal: AbortSignal,
  ): Promise<void> {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN', signal });
      open = true;
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [`${this.statementTimeoutMs}ms`],
        signal,
      });
      const result = await client.query<RoleRow>({ text: ROLE_QUERY, signal });
      const role = result.rows[0];
      if (!role || !validMembership(role, expectedRole)) throw new ProjectionDatabaseRoleError();
      await client.query({ text: `SET LOCAL ROLE ${expectedRole}`, signal });
      const current = await client.query<{ current_user: string }>({
        text: 'SELECT current_user',
        signal,
      });
      if (current.rows[0]?.current_user !== expectedRole) throw new ProjectionDatabaseRoleError();
      await client.query({ text: 'ROLLBACK', signal });
      open = false;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      if (error instanceof ProjectionDatabaseRoleError) throw error;
      throw new ProjectionDatabaseRoleError();
    } finally {
      client.release();
    }
  }
}

export class ProjectionDatabaseHealth implements RuntimeDatabaseHealthPort {
  constructor(
    private readonly dispatcherPool: SqlPoolPort,
    private readonly workerPool: SqlPoolPort,
    private readonly statementTimeoutMs = 1_000,
  ) {}

  async probe(signal: AbortSignal): Promise<void> {
    await Promise.all([
      probeRole(this.dispatcherPool, 'botmem_dispatcher', this.statementTimeoutMs, signal),
      probeRole(this.workerPool, 'botmem_worker', this.statementTimeoutMs, signal),
    ]);
  }
}

const ROLE_QUERY = `
SELECT session_user,
       role.rolsuper AS is_superuser,
       role.rolbypassrls AS bypasses_rls,
       coalesce(pg_has_role(session_user, to_regrole('botmem_dispatcher'), 'MEMBER'), false) AS dispatcher_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_worker'), 'MEMBER'), false) AS worker_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_api'), 'MEMBER'), false) AS api_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_commerce'), 'MEMBER'), false) AS commerce_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_lifecycle'), 'MEMBER'), false) AS lifecycle_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_schema_owner'), 'MEMBER'), false) AS owner_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_identity_admin'), 'MEMBER'), false) AS identity_admin_member,
       coalesce(pg_has_role(session_user, to_regrole('botmem_migrator'), 'MEMBER'), false) AS migrator_member
  FROM pg_roles role
 WHERE role.rolname = session_user
`;

function validMembership(role: RoleRow, expected: RuntimeDatabaseRole): boolean {
  return (
    !role.is_superuser &&
    !role.bypasses_rls &&
    role.dispatcher_member === (expected === 'botmem_dispatcher') &&
    role.worker_member === (expected === 'botmem_worker') &&
    role.api_member === (expected === 'botmem_api') &&
    role.commerce_member === (expected === 'botmem_commerce') &&
    role.lifecycle_member === (expected === 'botmem_lifecycle') &&
    !role.owner_member &&
    role.identity_admin_member === (expected === 'botmem_identity_admin') &&
    !role.migrator_member
  );
}

async function probeRole(
  pool: SqlPoolPort,
  role: ProjectionDatabaseRole,
  statementTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query({ text: 'BEGIN', signal });
    open = true;
    await client.query({ text: `SET LOCAL ROLE ${role}`, signal });
    await client.query({
      text: "SELECT set_config('statement_timeout', $1, true)",
      values: [`${statementTimeoutMs}ms`],
      signal,
    });
    await client.query({ text: 'SELECT 1', signal });
    await client.query({ text: 'ROLLBACK', signal });
    open = false;
  } catch (error) {
    if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class ProjectionDatabaseRoleError extends Error {
  override readonly name = 'ProjectionDatabaseRoleError';
}
