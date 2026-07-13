import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type { BillingSignup } from './domain.js';
import type { IdentityProvisionerPort } from './ports.js';

interface LoginAuthorityRow {
  readonly safe: boolean;
}

interface ProvisionedIdentityRow {
  readonly user_email: string;
  readonly email_lookup_hash: Buffer;
  readonly user_status: string;
  readonly workspace_name: string;
  readonly workspace_status: string;
  readonly membership_role: string;
  readonly membership_status: string;
}

/** Uses only the dedicated identity-admin pool; runtime API pools are never accepted here. */
export class PostgresIdentityProvisioner implements IdentityProvisionerPort {
  constructor(private readonly identityAdminPool: SqlPoolPort) {}

  async provision(signup: BillingSignup, provisionedAt: string): Promise<void> {
    const client = await this.identityAdminPool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await assertIdentityAdminLogin(client);
      await client.query({ text: 'SET LOCAL ROLE botmem_identity_admin' });
      await client.query({
        text: `INSERT INTO botmem.identity_user (
                 id, tenant_id, email, email_lookup_hash, status, created_at, updated_at
               ) VALUES (
                 $1::uuid, $2::uuid, $3, decode($4, 'hex'), 'active',
                 $5::timestamptz, $5::timestamptz
               ) ON CONFLICT (id) DO NOTHING`,
        values: [
          signup.ownerUserId,
          signup.workspaceId,
          signup.email,
          signup.emailLookupHashHex,
          provisionedAt,
        ],
      });
      await client.query({
        text: `INSERT INTO botmem.workspace (
                 id, tenant_id, display_name, status, created_at, updated_at
               ) VALUES (
                 $1::uuid, $1::uuid, $2, 'active', $3::timestamptz, $3::timestamptz
               ) ON CONFLICT (id) DO NOTHING`,
        values: [signup.workspaceId, signup.workspaceName, provisionedAt],
      });
      await client.query({
        text: `INSERT INTO botmem.workspace_membership (
                 tenant_id, workspace_id, user_id, role, status, created_at, updated_at
               ) VALUES (
                 $1::uuid, $1::uuid, $2::uuid, 'owner', 'active',
                 $3::timestamptz, $3::timestamptz
               ) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        values: [signup.workspaceId, signup.ownerUserId, provisionedAt],
      });
      const verified = await client.query<ProvisionedIdentityRow>({
        text: `SELECT identity_user.email AS user_email,
                      identity_user.email_lookup_hash,
                      identity_user.status AS user_status,
                      workspace.display_name AS workspace_name,
                      workspace.status AS workspace_status,
                      membership.role AS membership_role,
                      membership.status AS membership_status
                 FROM botmem.identity_user identity_user
                 JOIN botmem.workspace workspace
                   ON workspace.tenant_id = identity_user.tenant_id
                  AND workspace.id = $1::uuid
                 JOIN botmem.workspace_membership membership
                   ON membership.tenant_id = workspace.tenant_id
                  AND membership.workspace_id = workspace.id
                  AND membership.user_id = identity_user.id
                WHERE identity_user.tenant_id = $1::uuid
                  AND identity_user.id = $2::uuid`,
        values: [signup.workspaceId, signup.ownerUserId],
      });
      const row = verified.rows[0];
      if (
        !row ||
        row.user_email !== signup.email ||
        row.email_lookup_hash.toString('hex') !== signup.emailLookupHashHex ||
        row.user_status !== 'active' ||
        row.workspace_name !== signup.workspaceName ||
        row.workspace_status !== 'active' ||
        row.membership_role !== 'owner' ||
        row.membership_status !== 'active'
      ) {
        throw new IdentityProvisioningConflictError();
      }
      await client.query({ text: 'COMMIT' });
      open = false;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<boolean> {
    const client = await this.identityAdminPool.connect().catch(() => null);
    if (!client) return false;
    try {
      await assertIdentityAdminLogin(client);
      await client.query({ text: 'BEGIN' });
      await client.query({ text: 'SET LOCAL ROLE botmem_identity_admin' });
      await client.query({ text: 'SELECT 1 FROM botmem.workspace LIMIT 1' });
      await client.query({ text: 'ROLLBACK' });
      return true;
    } catch {
      await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      return false;
    } finally {
      client.release();
    }
  }
}

async function assertIdentityAdminLogin(client: SqlClientPort): Promise<void> {
  const result = await client.query<LoginAuthorityRow>({
    text: `SELECT NOT login.rolsuper
                  AND NOT login.rolbypassrls
                  AND pg_has_role(session_user, 'botmem_identity_admin', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_api', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_commerce', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_lifecycle', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_worker', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_dispatcher', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_migrator', 'SET')
                  AND NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') AS safe
             FROM pg_roles login
            WHERE login.rolname = session_user`,
  });
  if (result.rows[0]?.safe !== true) throw new UnsafeIdentityAdminLoginError();
}

export class UnsafeIdentityAdminLoginError extends Error {
  override readonly name = 'UnsafeIdentityAdminLoginError';
}

export class IdentityProvisioningConflictError extends Error {
  override readonly name = 'IdentityProvisioningConflictError';
}
