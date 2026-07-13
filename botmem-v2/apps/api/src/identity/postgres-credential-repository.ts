import type { SqlClientPort, SqlPoolPort } from '../search/postgres-ports.js';
import type {
  AuthenticatedPrincipal,
  CredentialKind,
  CredentialSnapshot,
  PersonalAccessTokenMetadata,
} from './domain.js';
import type {
  CredentialRepositoryPort,
  LoginChallengePrincipal,
  LoginChallengeRepositoryPort,
} from './ports.js';

interface CredentialRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly kind: CredentialKind;
  readonly scopes: readonly string[];
  readonly expires_at: Date | string;
}

interface MembershipRow {
  readonly role: 'owner' | 'member';
}

interface LoginChallengeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly workspace_id: string;
  readonly user_id: string;
}

interface PatMetadataRow {
  readonly id: string;
  readonly label: string;
  readonly token_prefix: string;
  readonly scopes: readonly string[];
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly last_used_at: Date | string | null;
}

interface BooleanRow {
  readonly accepted?: boolean;
  readonly allowed?: boolean;
}

export class PostgresCredentialRepository
  implements CredentialRepositoryPort, LoginChallengeRepositoryPort
{
  constructor(private readonly pool: SqlPoolPort) {}

  async authenticate(input: {
    readonly secretHashHex: string;
    readonly expectedKind: CredentialKind;
    readonly now: string;
  }): Promise<AuthenticatedPrincipal | null> {
    try {
      return await this.transaction(async (client) => {
        const credential = await this.findCredential(client, input);
        if (!credential) return null;
        const membershipRole = await this.requireActiveMembership(client, credential);
        await client.query({
          text: `UPDATE botmem.identity_credential
                    SET last_used_at = $2::timestamptz
                  WHERE id = $1::uuid
                    AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '5 minutes')`,
          values: [credential.id, input.now],
        });
        return principal(credential, membershipRole);
      });
    } catch (error) {
      if (error instanceof CredentialMembershipRevokedError) return null;
      throw error;
    }
  }

  async issue(credential: CredentialSnapshot): Promise<void> {
    await this.transaction(async (client) => {
      await this.setOwnerContext(client, credential);
      await this.requireActiveMembership(client, credential);
      await this.insert(client, credential);
    });
  }

  async rotate(input: {
    readonly currentSecretHashHex: string;
    readonly currentKind: CredentialKind;
    readonly replacement: CredentialSnapshot;
    readonly rotatedAt: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const current = await this.findCredential(
        client,
        {
          secretHashHex: input.currentSecretHashHex,
          expectedKind: input.currentKind,
          now: input.rotatedAt,
        },
        true,
      );
      if (!current) throw new CredentialPersistenceConflictError();
      await this.requireActiveMembership(client, current);
      if (
        input.replacement.rotatedFromCredentialId !== current.id ||
        input.replacement.tenantId !== current.tenant_id ||
        input.replacement.workspaceId !== current.workspace_id ||
        input.replacement.userId !== current.user_id ||
        input.replacement.kind !== current.kind
      ) {
        throw new CredentialPersistenceConflictError();
      }
      await this.insert(client, input.replacement);
      const revoked = await client.query({
        text: `UPDATE botmem.identity_credential
                  SET revoked_at = $2::timestamptz,
                      revocation_reason = 'rotated'
                WHERE id = $1::uuid AND revoked_at IS NULL`,
        values: [current.id, input.rotatedAt],
      });
      if (revoked.rowCount !== 1) throw new CredentialPersistenceConflictError();
    });
  }

  async revoke(input: {
    readonly secretHashHex: string;
    readonly expectedKind: CredentialKind;
    readonly revokedAt: string;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await this.findCredential(client, {
        secretHashHex: input.secretHashHex,
        expectedKind: input.expectedKind,
        now: input.revokedAt,
      });
      if (!current) return false;
      await this.requireActiveMembership(client, current);
      const result = await client.query({
        text: `UPDATE botmem.identity_credential
                  SET revoked_at = $2::timestamptz,
                      revocation_reason = 'user_revoked'
                WHERE id = $1::uuid AND revoked_at IS NULL`,
        values: [current.id, input.revokedAt],
      });
      return result.rowCount === 1;
    });
  }

  async listPersonalAccessTokens(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly now: string;
  }): Promise<readonly PersonalAccessTokenMetadata[]> {
    return this.transaction(async (client) => {
      await this.setOwnerContext(client, input.principal);
      await this.requireActiveMembership(client, input.principal);
      const result = await client.query<PatMetadataRow>({
        text: `SELECT id, label, token_prefix, scopes, created_at, expires_at, last_used_at
                 FROM botmem.identity_credential
                WHERE tenant_id = $1::uuid
                  AND workspace_id = $2::uuid
                  AND user_id = $3::uuid
                  AND kind = 'personal_access_token'
                  AND revoked_at IS NULL
                  AND expires_at > $4::timestamptz
                ORDER BY created_at DESC, id DESC`,
        values: [
          input.principal.tenantId,
          input.principal.workspaceId,
          input.principal.userId,
          input.now,
        ],
      });
      return result.rows.map(patMetadata);
    });
  }

  async revokePersonalAccessToken(input: {
    readonly principal: AuthenticatedPrincipal;
    readonly credentialId: string;
    readonly revokedAt: string;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.setOwnerContext(client, input.principal);
      await this.requireActiveMembership(client, input.principal);
      const result = await client.query<{ readonly revoked: boolean }>({
        text: `SELECT botmem.revoke_owned_personal_access_token(
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz
               ) AS revoked`,
        values: [
          input.principal.credentialId,
          input.principal.tenantId,
          input.principal.workspaceId,
          input.principal.userId,
          input.credentialId,
          input.revokedAt,
        ],
      });
      return result.rows[0]?.revoked === true;
    });
  }

  async begin(input: {
    readonly emailLookupHashHex: string;
    readonly challengeId: string;
    readonly secretHashHex: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.begin_identity_login_challenge(
                 decode($1, 'hex'), $2::uuid, decode($3, 'hex'),
                 $4::timestamptz, $5::timestamptz
               ) AS accepted`,
        values: [
          input.emailLookupHashHex,
          input.challengeId,
          input.secretHashHex,
          input.createdAt,
          input.expiresAt,
        ],
      });
      return result.rows[0]?.accepted === true;
    });
  }

  async consumeRateLimit(input: {
    readonly bucketHashHex: string;
    readonly now: string;
    readonly maximumAttempts: number;
    readonly windowSeconds: number;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query<BooleanRow>({
        text: `SELECT botmem.consume_identity_login_rate_limit(
                 decode($1, 'hex'), $2::timestamptz, $3::integer, $4::integer
               ) AS allowed`,
        values: [input.bucketHashHex, input.now, input.maximumAttempts, input.windowSeconds],
      });
      return result.rows[0]?.allowed === true;
    });
  }

  async consume(input: {
    readonly secretHashHex: string;
    readonly consumedAt: string;
  }): Promise<LoginChallengePrincipal | null> {
    return this.transaction(async (client) => {
      await client.query({
        text: "SELECT set_config('botmem.login_challenge_hash', $1, true)",
        values: [input.secretHashHex],
      });
      const result = await client.query<LoginChallengeRow>({
        text: `SELECT id, tenant_id, workspace_id, user_id
                 FROM botmem.identity_login_challenge
                WHERE secret_hash = decode($1, 'hex')
                  AND consumed_at IS NULL
                  AND cancelled_at IS NULL
                  AND expires_at > $2::timestamptz
                FOR UPDATE`,
        values: [input.secretHashHex, input.consumedAt],
      });
      const challenge = result.rows[0];
      if (!challenge) return null;
      const owner = {
        tenantId: challenge.tenant_id,
        workspaceId: challenge.workspace_id,
        userId: challenge.user_id,
      };
      await this.setOwnerContext(client, owner);
      const membershipRole = await this.requireActiveMembership(client, owner);
      const consumed = await client.query({
        text: `UPDATE botmem.identity_login_challenge
                  SET consumed_at = $2::timestamptz
                WHERE id = $1::uuid
                  AND consumed_at IS NULL AND cancelled_at IS NULL`,
        values: [challenge.id, input.consumedAt],
      });
      if (consumed.rowCount !== 1) return null;
      return { ...owner, membershipRole, challengeId: challenge.id };
    }).catch((error) => {
      if (error instanceof CredentialMembershipRevokedError) return null;
      throw error;
    });
  }

  async cancel(input: {
    readonly secretHashHex: string;
    readonly cancelledAt: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query({
        text: "SELECT set_config('botmem.login_challenge_hash', $1, true)",
        values: [input.secretHashHex],
      });
      await client.query({
        text: `UPDATE botmem.identity_login_challenge
                  SET cancelled_at = $2::timestamptz
                WHERE secret_hash = decode($1, 'hex')
                  AND consumed_at IS NULL AND cancelled_at IS NULL`,
        values: [input.secretHashHex, input.cancelledAt],
      });
    });
  }

  private async transaction<Result>(
    operation: (client: SqlClientPort) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query({ text: 'BEGIN' });
      open = true;
      await client.query({ text: 'SET LOCAL ROLE botmem_api' });
      const result = await operation(client);
      await client.query({ text: 'COMMIT' });
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query({ text: 'ROLLBACK' }).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findCredential(
    client: SqlClientPort,
    input: {
      readonly secretHashHex: string;
      readonly expectedKind: CredentialKind;
      readonly now: string;
    },
    lock = false,
  ): Promise<CredentialRow | null> {
    await client.query({
      text: "SELECT set_config('botmem.credential_hash', $1, true)",
      values: [input.secretHashHex],
    });
    const result = await client.query<CredentialRow>({
      text: `SELECT id, tenant_id, workspace_id, user_id, kind, scopes, expires_at
               FROM botmem.identity_credential
              WHERE secret_hash = decode($1, 'hex')
                AND kind = $2
                AND revoked_at IS NULL
                AND expires_at > $3::timestamptz
              ${lock ? 'FOR UPDATE' : ''}`,
      values: [input.secretHashHex, input.expectedKind, input.now],
    });
    const credential = result.rows[0] ?? null;
    if (credential) await this.setOwnerContext(client, rowOwner(credential));
    return credential;
  }

  private async setOwnerContext(
    client: SqlClientPort,
    owner: { readonly tenantId: string; readonly workspaceId: string; readonly userId: string },
  ): Promise<void> {
    await client.query({
      text: `SELECT set_config('botmem.tenant_id', $1, true),
                    set_config('botmem.workspace_id', $2, true),
                    set_config('botmem.user_id', $3, true)`,
      values: [owner.tenantId, owner.workspaceId, owner.userId],
    });
  }

  private async requireActiveMembership(
    client: SqlClientPort,
    owner: {
      readonly tenant_id?: string;
      readonly workspace_id?: string;
      readonly user_id?: string;
      readonly tenantId?: string;
      readonly workspaceId?: string;
      readonly userId?: string;
    },
  ): Promise<'owner' | 'member'> {
    const tenantId = owner.tenant_id ?? owner.tenantId;
    const workspaceId = owner.workspace_id ?? owner.workspaceId;
    const userId = owner.user_id ?? owner.userId;
    const result = await client.query<MembershipRow>({
      text: `SELECT membership.role
               FROM botmem.workspace_membership membership
               JOIN botmem.workspace workspace
                 ON workspace.tenant_id = membership.tenant_id
                AND workspace.id = membership.workspace_id
                AND workspace.status = 'active'
               JOIN botmem.identity_user identity_user
                 ON identity_user.tenant_id = membership.tenant_id
                AND identity_user.id = membership.user_id
                AND identity_user.status = 'active'
              WHERE membership.tenant_id = $1::uuid
                AND membership.workspace_id = $2::uuid
                AND membership.user_id = $3::uuid
                AND membership.status = 'active'`,
      values: [tenantId, workspaceId, userId],
    });
    const role = result.rows[0]?.role;
    if (!role) throw new CredentialMembershipRevokedError();
    return role;
  }

  private async insert(client: SqlClientPort, credential: CredentialSnapshot): Promise<void> {
    await client.query({
      text: `INSERT INTO botmem.identity_credential (
               id, tenant_id, workspace_id, user_id, kind, secret_hash,
               token_prefix, label, scopes, created_at, expires_at, rotated_from_id
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
               decode($6, 'hex'), $7, $8, $9::text[], $10::timestamptz,
               $11::timestamptz, $12::uuid
             )`,
      values: [
        credential.credentialId,
        credential.tenantId,
        credential.workspaceId,
        credential.userId,
        credential.kind,
        credential.secretHashHex,
        credential.tokenPrefix,
        credential.label,
        credential.scopes,
        credential.createdAt,
        credential.expiresAt,
        credential.rotatedFromCredentialId ?? null,
      ],
    });
  }
}

export class CredentialMembershipRevokedError extends Error {
  override readonly name = 'CredentialMembershipRevokedError';
}

export class CredentialPersistenceConflictError extends Error {
  override readonly name = 'CredentialPersistenceConflictError';
}

function rowOwner(row: CredentialRow): {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
} {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
  };
}

function principal(row: CredentialRow, membershipRole: 'owner' | 'member'): AuthenticatedPrincipal {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    membershipRole,
    credentialId: row.id,
    credentialKind: row.kind,
    scopes: Object.freeze([...row.scopes]),
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : new Date(row.expires_at).toISOString(),
  };
}

function patMetadata(row: PatMetadataRow): PersonalAccessTokenMetadata {
  const allowed = new Set(['botmem:search', 'botmem:connections:read', 'botmem:devices:read']);
  if (
    row.scopes.length < 1 ||
    row.scopes.length > 3 ||
    !row.scopes.includes('botmem:search') ||
    new Set(row.scopes).size !== row.scopes.length ||
    row.scopes.some((scope) => !allowed.has(scope))
  ) {
    throw new CredentialPersistenceConflictError();
  }
  return {
    credentialId: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes as PersonalAccessTokenMetadata['scopes'],
    createdAt: asIso(row.created_at),
    expiresAt: asIso(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : asIso(row.last_used_at),
  };
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
