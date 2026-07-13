-- Run once as a PostgreSQL cluster administrator, outside the migration runner.
-- These are NOLOGIN group roles. Deployment-specific LOGIN roles receive one
-- membership each; passwords and cloud identities never belong in migrations.
DO $bootstrap$
DECLARE
    role_name text;
BEGIN
    FOREACH role_name IN ARRAY ARRAY[
        'botmem_schema_owner',
        'botmem_migrator',
        'botmem_api',
        'botmem_commerce',
        'botmem_identity_admin',
        'botmem_lifecycle',
        'botmem_worker',
        'botmem_dispatcher'
    ]
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I', role_name);
        END IF;
    END LOOP;
END
$bootstrap$;

ALTER ROLE botmem_schema_owner NOINHERIT NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_migrator NOINHERIT NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_api NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_commerce NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_identity_admin NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_lifecycle NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_worker NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;
ALTER ROLE botmem_dispatcher NOSUPERUSER NOBYPASSRLS NOLOGIN NOREPLICATION;

GRANT botmem_schema_owner TO botmem_migrator;

-- The cluster administrator must also:
--   GRANT botmem_migrator TO <deployment_migrator_login>;
--   GRANT CREATE ON DATABASE <botmem_database> TO botmem_schema_owner;
-- Runtime logins receive exactly one of botmem_api, botmem_commerce,
-- botmem_lifecycle, botmem_worker, or botmem_dispatcher and must SET ROLE to it on checkout. A separate tightly
-- controlled provisioning login may receive only botmem_identity_admin.
