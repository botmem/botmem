import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

import type { MigratorConfig } from './config.js';
import type { Migration } from './migrations.js';

const { Client } = pg;
const LOCK_NAMESPACE = 1_116_587_862;
const LOCK_RESOURCE = 2_020_024;
const RUNTIME_ROLES = Object.freeze([
  'botmem_api',
  'botmem_commerce',
  'botmem_identity_admin',
  'botmem_lifecycle',
  'botmem_worker',
  'botmem_dispatcher',
]);

export interface MigrationRunResult {
  readonly discoveredCount: number;
  readonly previouslyAppliedCount: number;
  readonly appliedCount: number;
  readonly importedLegacyCount: number;
}

interface HistoryRow {
  readonly version: string | number;
  readonly script: string;
  readonly checksum_sha256: string;
}

interface LegacyHistoryRow {
  readonly installed_rank: number;
  readonly version: string | null;
  readonly description: string;
  readonly type: string;
  readonly script: string;
  readonly checksum: number | null;
  readonly success: boolean;
}

export async function runMigrations(
  config: MigratorConfig,
  migrations: readonly Migration[],
  log: (event: Readonly<Record<string, unknown>>) => void = () => undefined,
): Promise<MigrationRunResult> {
  const client = await connect(config);
  let locked = false;
  try {
    await verifyRoleBoundary(client, config.expectedLogin);
    locked = await acquireLock(client, config.lockTimeoutMs);
    if (!locked) throw new MigratorRuntimeError('migration_lock_timeout');

    const importedLegacyCount = await prepareAndValidateHistory(client, migrations);
    const history = await readHistoryAsOwner(client);
    validateAppliedHistory(history, migrations);
    const previouslyAppliedCount = history.length;

    let appliedCount = 0;
    for (const migration of migrations.slice(previouslyAppliedCount)) {
      log({ event: 'migration_started', version: migration.version, script: migration.script });
      const startedAt = performance.now();
      await applyMigration(client, migration, config.expectedLogin, startedAt);
      appliedCount += 1;
      log({ event: 'migration_applied', version: migration.version, script: migration.script });
    }

    return Object.freeze({
      discoveredCount: migrations.length,
      previouslyAppliedCount,
      appliedCount,
      importedLegacyCount,
    });
  } finally {
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_RESOURCE])
        .catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function connect(config: MigratorConfig): Promise<pg.Client> {
  for (let attempt = 1; attempt <= config.connectAttempts; attempt += 1) {
    const client = new Client({
      connectionString: config.databaseUrl,
      ...(config.databasePassword ? { password: config.databasePassword } : {}),
      application_name: 'botmem-v2-migrator',
    });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => undefined);
      if (attempt === config.connectAttempts)
        throw new MigratorRuntimeError('database_connect_failed');
      await delay(config.connectRetryMs);
    }
  }
  throw new MigratorRuntimeError('database_connect_failed');
}

async function verifyRoleBoundary(client: pg.Client, expectedLogin: string): Promise<void> {
  const identity = await client.query<{ current_user: string; session_user: string }>(
    'SELECT current_user, session_user',
  );
  const row = identity.rows[0];
  if (!row || row.current_user !== expectedLogin || row.session_user !== expectedLogin) {
    throw new MigratorRuntimeError('database_identity_invalid');
  }

  const roles = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolinherit: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY($1::name[])`,
    [[expectedLogin, 'botmem_migrator', 'botmem_schema_owner', ...RUNTIME_ROLES]],
  );
  const byName = new Map(roles.rows.map((role) => [role.rolname, role]));
  const login = byName.get(expectedLogin);
  const migrator = byName.get('botmem_migrator');
  const owner = byName.get('botmem_schema_owner');
  if (!login || !migrator || !owner || roles.rows.length !== 3 + RUNTIME_ROLES.length) {
    throw new MigratorRuntimeError('database_role_boundary_invalid');
  }
  if (
    !login.rolcanlogin ||
    login.rolinherit ||
    dangerous(login) ||
    migrator.rolcanlogin ||
    migrator.rolinherit ||
    dangerous(migrator) ||
    owner.rolcanlogin ||
    owner.rolinherit ||
    dangerous(owner)
  ) {
    throw new MigratorRuntimeError('database_role_boundary_invalid');
  }

  const memberships = await client.query<{
    member_role: string;
    granted_role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT member.rolname AS member_role, granted.rolname AS granted_role,
            edge.admin_option, edge.inherit_option, edge.set_option
       FROM pg_auth_members edge
       JOIN pg_roles member ON member.oid = edge.member
       JOIN pg_roles granted ON granted.oid = edge.roleid
      WHERE member.rolname = ANY($1::name[])
      ORDER BY member.rolname, granted.rolname`,
    [[expectedLogin, 'botmem_migrator']],
  );
  const loginGrants = memberships.rows
    .filter((membership) => membership.member_role === expectedLogin)
    .map((membership) => membership.granted_role);
  const migratorGrants = memberships.rows
    .filter((membership) => membership.member_role === 'botmem_migrator')
    .map((membership) => membership.granted_role);
  if (
    loginGrants.length !== 1 ||
    loginGrants[0] !== 'botmem_migrator' ||
    migratorGrants.length !== 1 ||
    migratorGrants[0] !== 'botmem_schema_owner' ||
    memberships.rows.some(
      (membership) =>
        membership.admin_option || membership.inherit_option || !membership.set_option,
    )
  ) {
    throw new MigratorRuntimeError('database_role_boundary_invalid');
  }

  const reachableRuntime = await client.query<{ unsafe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM unnest($1::name[]) AS role_name
        WHERE pg_has_role(current_user, role_name, 'MEMBER')
     ) AS unsafe`,
    [RUNTIME_ROLES],
  );
  if (reachableRuntime.rows[0]?.unsafe !== false) {
    throw new MigratorRuntimeError('database_role_boundary_invalid');
  }
}

function dangerous(role: {
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}): boolean {
  return (
    role.rolsuper ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls
  );
}

async function acquireLock(client: pg.Client, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [LOCK_NAMESPACE, LOCK_RESOURCE],
    );
    if (result.rows[0]?.locked === true) return true;
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

async function prepareAndValidateHistory(
  client: pg.Client,
  migrations: readonly Migration[],
): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE botmem_schema_owner');
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS botmem_migration AUTHORIZATION botmem_schema_owner;
      REVOKE ALL ON SCHEMA botmem_migration FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS botmem_migration.history (
        version bigint PRIMARY KEY CHECK (version > 0),
        script text NOT NULL UNIQUE,
        description text NOT NULL,
        checksum_sha256 character(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        execution_time_ms integer NOT NULL CHECK (execution_time_ms >= 0),
        applied_by name NOT NULL,
        source text NOT NULL CHECK (source IN ('botmem_node', 'legacy_flyway'))
      );
      ALTER TABLE botmem_migration.history OWNER TO botmem_schema_owner;
      REVOKE ALL ON TABLE botmem_migration.history FROM PUBLIC;
      CREATE OR REPLACE FUNCTION botmem_migration.reject_history_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $ledger$
      BEGIN
        RAISE EXCEPTION 'Botmem migration history is immutable' USING ERRCODE = '55000';
      END
      $ledger$;
      ALTER FUNCTION botmem_migration.reject_history_mutation() OWNER TO botmem_schema_owner;
      DROP TRIGGER IF EXISTS history_is_immutable ON botmem_migration.history;
      CREATE TRIGGER history_is_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON botmem_migration.history
      FOR EACH STATEMENT EXECUTE FUNCTION botmem_migration.reject_history_mutation();
    `);
    await validateLedgerShape(client);

    const existing = await readHistory(client);
    let imported = 0;
    if (existing.length === 0) {
      const legacyExists = await client.query<{ present: boolean }>(
        `SELECT to_regclass('botmem.flyway_schema_history') IS NOT NULL AS present`,
      );
      if (legacyExists.rows[0]?.present === true) {
        const legacy = await client.query<LegacyHistoryRow>(
          `SELECT installed_rank, version, description, type, script, checksum, success
             FROM botmem.flyway_schema_history
            ORDER BY installed_rank`,
        );
        const verified = validateLegacyHistory(legacy.rows, migrations);
        for (const migration of verified) {
          await client.query(
            `INSERT INTO botmem_migration.history
               (version, script, description, checksum_sha256, execution_time_ms, applied_by, source)
             VALUES ($1, $2, $3, $4, 0, session_user, 'legacy_flyway')`,
            [migration.version, migration.script, migration.description, migration.checksumSha256],
          );
        }
        imported = verified.length;
      } else {
        const objects = await client.query<{ object_count: string }>(
          `SELECT (
             (SELECT count(*) FROM pg_class object
               JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
              WHERE namespace.nspname = 'botmem'
                AND object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f'))
             +
             (SELECT count(*) FROM pg_proc routine
               JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
              WHERE namespace.nspname = 'botmem')
             +
             (SELECT count(*) FROM pg_type type_record
               JOIN pg_namespace namespace ON namespace.oid = type_record.typnamespace
              WHERE namespace.nspname = 'botmem'
                AND type_record.typtype IN ('d', 'e', 'r'))
           )::text AS object_count`,
        );
        if (Number(objects.rows[0]?.object_count ?? '0') > 0) {
          throw new MigratorRuntimeError('untracked_schema_rejected');
        }
      }
    }
    await client.query('COMMIT');
    return imported;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MigratorRuntimeError) throw error;
    throw new MigratorRuntimeError('migration_history_invalid', undefined, error);
  }
}

async function validateLedgerShape(client: pg.Client): Promise<void> {
  const metadata = await client.query<{
    owner: string;
    columns: string;
    applied_at_default: string;
    constraints: string[];
    primary_columns: string[];
    unique_columns: string[];
    immutable_trigger_count: string;
  }>(`
    SELECT owner.rolname AS owner,
           (SELECT string_agg(attribute.attname || ':' ||
                              format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
                              attribute.attnotnull::text, ',' ORDER BY attribute.attnum)
              FROM pg_attribute attribute
             WHERE attribute.attrelid = 'botmem_migration.history'::regclass
               AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
           (SELECT pg_get_expr(default_record.adbin, default_record.adrelid)
              FROM pg_attrdef default_record
              JOIN pg_attribute attribute ON attribute.attrelid = default_record.adrelid
                                         AND attribute.attnum = default_record.adnum
             WHERE default_record.adrelid = 'botmem_migration.history'::regclass
               AND attribute.attname = 'applied_at') AS applied_at_default,
           ARRAY(SELECT pg_get_constraintdef(constraint_record.oid)
                   FROM pg_constraint constraint_record
                  WHERE constraint_record.conrelid = 'botmem_migration.history'::regclass
                  ORDER BY constraint_record.contype,
                           pg_get_constraintdef(constraint_record.oid))::text[] AS constraints,
           ARRAY(SELECT attribute.attname::text
                   FROM pg_constraint constraint_record
                   CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key(number, position)
                   JOIN pg_attribute attribute ON attribute.attrelid = constraint_record.conrelid
                                              AND attribute.attnum = key.number
                  WHERE constraint_record.conrelid = 'botmem_migration.history'::regclass
                    AND constraint_record.contype = 'p'
                  ORDER BY key.position)::text[] AS primary_columns,
           ARRAY(SELECT attribute.attname::text
                   FROM pg_constraint constraint_record
                   CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key(number, position)
                   JOIN pg_attribute attribute ON attribute.attrelid = constraint_record.conrelid
                                              AND attribute.attnum = key.number
                  WHERE constraint_record.conrelid = 'botmem_migration.history'::regclass
                    AND constraint_record.contype = 'u'
                  ORDER BY key.position)::text[] AS unique_columns,
           (SELECT count(*)::text FROM pg_trigger trigger_record
             WHERE trigger_record.tgrelid = 'botmem_migration.history'::regclass
               AND NOT trigger_record.tgisinternal
               AND trigger_record.tgname = 'history_is_immutable') AS immutable_trigger_count
      FROM pg_class table_record
      JOIN pg_roles owner ON owner.oid = table_record.relowner
     WHERE table_record.oid = 'botmem_migration.history'::regclass
  `);
  const row = metadata.rows[0];
  const expectedColumns = [
    'version:bigint:true',
    'script:text:true',
    'description:text:true',
    'checksum_sha256:character(64):true',
    'applied_at:timestamp with time zone:true',
    'execution_time_ms:integer:true',
    'applied_by:name:true',
    'source:text:true',
  ].join(',');
  const expectedConstraints = [
    "CHECK ((checksum_sha256 ~ '^[0-9a-f]{64}$'::text))",
    'CHECK ((execution_time_ms >= 0))',
    "CHECK ((source = ANY (ARRAY['botmem_node'::text, 'legacy_flyway'::text])))",
    'CHECK ((version > 0))',
    'PRIMARY KEY (version)',
    'UNIQUE (script)',
  ];
  if (
    !row ||
    row.owner !== 'botmem_schema_owner' ||
    row.columns !== expectedColumns ||
    row.applied_at_default !== 'clock_timestamp()' ||
    row.constraints.join('\n') !== expectedConstraints.join('\n') ||
    row.primary_columns.join(',') !== 'version' ||
    row.unique_columns.join(',') !== 'script' ||
    row.immutable_trigger_count !== '1'
  ) {
    throw new MigratorRuntimeError('migration_ledger_invalid');
  }

  const unsafePrivileges = await client.query<{ unsafe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM unnest($1::name[]) role_name
        WHERE has_schema_privilege(role_name, 'botmem_migration', 'USAGE')
           OR has_table_privilege(role_name, 'botmem_migration.history',
                                  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     ) AS unsafe`,
    [RUNTIME_ROLES],
  );
  if (unsafePrivileges.rows[0]?.unsafe !== false) {
    throw new MigratorRuntimeError('migration_ledger_privilege_invalid');
  }
}

async function readHistory(client: pg.Client): Promise<readonly HistoryRow[]> {
  const history = await client.query<HistoryRow>(
    `SELECT version, script, checksum_sha256
       FROM botmem_migration.history
      ORDER BY version`,
  );
  return history.rows;
}

async function readHistoryAsOwner(client: pg.Client): Promise<readonly HistoryRow[]> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE botmem_schema_owner');
    const history = await readHistory(client);
    await client.query('COMMIT');
    return history;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigratorRuntimeError('migration_history_invalid', undefined, error);
  }
}

export function validateAppliedHistory(
  history: readonly HistoryRow[],
  migrations: readonly Migration[],
): void {
  if (history.length > migrations.length) throw new MigratorRuntimeError('database_ahead_rejected');
  history.forEach((row, index) => {
    const migration = migrations[index];
    if (Number(row.version) !== index + 1 || !migration) {
      throw new MigratorRuntimeError('migration_order_rejected');
    }
    if (row.script !== migration.script || row.checksum_sha256 !== migration.checksumSha256) {
      throw new MigratorRuntimeError('migration_checksum_drift');
    }
  });
}

export function validateLegacyHistory(
  rows: readonly LegacyHistoryRow[],
  migrations: readonly Migration[],
): readonly Migration[] {
  if (rows.some((row) => row.success === false)) {
    throw new MigratorRuntimeError('legacy_failed_migration_rejected');
  }
  if (rows.length > migrations.length)
    throw new MigratorRuntimeError('legacy_database_ahead_rejected');
  const verified: Migration[] = [];
  rows.forEach((row, index) => {
    const migration = migrations[index];
    if (
      !migration ||
      row.success !== true ||
      row.type !== 'SQL' ||
      row.version !== String(index + 1) ||
      row.installed_rank !== index + 1 ||
      row.script !== migration.script ||
      row.description !== migration.description ||
      row.checksum !== migration.flywayChecksum
    ) {
      throw new MigratorRuntimeError(
        row.success === false ? 'legacy_failed_migration_rejected' : 'legacy_history_rejected',
      );
    }
    verified.push(migration);
  });
  return Object.freeze(verified);
}

async function applyMigration(
  client: pg.Client,
  migration: Migration,
  expectedLogin: string,
  startedAt: number,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE botmem_schema_owner');
    await client.query(migration.sql);
    await client.query('SET LOCAL ROLE botmem_schema_owner');
    const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
    await client.query(
      `INSERT INTO botmem_migration.history
         (version, script, description, checksum_sha256, execution_time_ms, applied_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'botmem_node')`,
      [
        migration.version,
        migration.script,
        migration.description,
        migration.checksumSha256,
        elapsed,
        expectedLogin,
      ],
    );
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigratorRuntimeError('migration_failed', migration.script);
  }
}

export class MigratorRuntimeError extends Error {
  override readonly name = 'MigratorRuntimeError';
  constructor(
    readonly code: string,
    readonly script?: string,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
