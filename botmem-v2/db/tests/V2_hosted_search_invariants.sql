\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
INSERT INTO botmem.connector_account (
    id, tenant_id, connector, auth_kind, provider_subject_hash, credential_ref, status
) VALUES (
    '21000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'gmail', 'oauth2', repeat('2', 64), 'secret://test/search-account', 'ready'
);

RESET ROLE;
SET LOCAL ROLE botmem_worker;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000001', true);
UPDATE botmem.embedding_profile
   SET status = 'ready', model_revision = 'test-model-1', updated_at = statement_timestamp()
 WHERE id = 'hosted-multilingual-v1';

INSERT INTO botmem.connector_sync (
    id, tenant_id, account_id, state, aggregate_version_at_claim,
    started_at, lease_expires_at, closed_at
) VALUES (
    '31000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'completed', 0, '2026-07-13T09:50:00Z',
    '2026-07-13T10:05:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.connector_checkpoint (
    tenant_id, account_id, cursor_version, cursor,
    last_sync_id, last_committed_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    1, '{"historyId":"10"}'::jsonb,
    '31000000-0000-4000-8000-000000000001', '2026-07-13T10:00:00Z'
);

INSERT INTO botmem.ingest_event_revision (
    id, tenant_id, account_id, source_event_id, source_revision, kind,
    occurred_at, observed_at, content_hash, payload
) VALUES (
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'gmail-message-1', 'history:10', 'email',
    '2026-07-13T09:00:00Z', '2026-07-13T10:00:00Z', repeat('a', 64),
    '{"schema":"gmail.message.v1"}'::jsonb
);
INSERT INTO botmem.ingest_event_head (
    tenant_id, account_id, source_event_id, head_revision_id, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'gmail-message-1', '41000000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.projection_state (
    tenant_id, account_id, projection_name, revision_id, state, attempts,
    output_hash, applied_at, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'hosted_search_v1', '41000000-0000-4000-8000-000000000001',
    'applied', 1, repeat('b', 64),
    '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.hosted_document_revision (
    revision_id, tenant_id, account_id, connector, source_event_id,
    source_revision, kind, occurred_at, title, body,
    authored_by_me, citation, participants, participant_durable_ids,
    media, content_hash, projection_hash, embedding_profile_id, embedding, projected_at
) VALUES (
    '41000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'gmail', 'gmail-message-1', 'history:10', 'email',
    '2026-07-13T09:00:00Z', 'Arabic launch', 'مَرْحَبًا بالفريق release planning',
    true, 'gmail://gmail-message-1',
    '[{"durableId":"email:owner@example.com","displayName":"Owner Name","identifiers":[{"kind":"email","value":"owner@example.com"}]}]'::jsonb,
    ARRAY['email:owner@example.com'],
    '[]'::jsonb, repeat('a', 64), repeat('b', 64), 'hosted-multilingual-v1',
    array_fill(0.01::real, ARRAY[768])::public.vector(768),
    '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.hosted_document_head (
    tenant_id, account_id, source_event_id, revision_id, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    'gmail-message-1', '41000000-0000-4000-8000-000000000001',
    '2026-07-13T10:00:00Z'
);
INSERT INTO botmem.hosted_source_health (
    tenant_id, account_id, searchable, last_probe_at, updated_at
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    true, '2026-07-13T10:01:00Z', '2026-07-13T10:01:00Z'
);

DO $tests$
DECLARE
    operator_class text;
    access_method text;
BEGIN
    IF botmem.normalize_search_text('مَرْحَبًا') <> 'مرحبا' THEN
        RAISE EXCEPTION 'Arabic normalization did not fold combining marks';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_document_revision
         WHERE search_vector @@ websearch_to_tsquery('simple', 'مرحبا')
    ) THEN
        RAISE EXCEPTION 'Arabic lexical search did not match';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_document_revision
         WHERE botmem.normalize_search_text('planing') <% search_text
            OR search_text LIKE '%planing%'
    ) THEN
        RAISE EXCEPTION 'English typo-tolerant lane did not match';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM botmem.hosted_document_revision
         WHERE 'email:owner@example.com' = ANY(participant_durable_ids)
    ) THEN
        RAISE EXCEPTION 'durable participant identifier was not filterable';
    END IF;
    IF EXISTS (
        SELECT 1 FROM botmem.hosted_document_revision
         WHERE 'Owner Name' = ANY(participant_durable_ids)
    ) THEN
        RAISE EXCEPTION 'display name leaked into durable participant identifiers';
    END IF;

    SELECT opc.opcname, am.amname
      INTO operator_class, access_method
      FROM pg_catalog.pg_index idx
      JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
      JOIN pg_catalog.pg_opclass opc ON opc.oid = idx.indclass[0]
      JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
     WHERE index_class.oid = 'botmem.hosted_document_revision_embedding_hnsw'::regclass;
    IF operator_class <> 'vector_cosine_ops' OR access_method <> 'hnsw' THEN
        RAISE EXCEPTION 'semantic index has wrong access method or operator class';
    END IF;

    BEGIN
        UPDATE botmem.hosted_document_revision
           SET body = 'mutated'
         WHERE revision_id = '41000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'immutable hosted revision unexpectedly updated';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE '55000' THEN
        NULL;
    END;

    BEGIN
        INSERT INTO botmem.hosted_document_revision (
            revision_id, tenant_id, account_id, connector, source_event_id,
            source_revision, kind, body, citation, participants,
            participant_durable_ids, media, content_hash, projection_hash,
            embedding_profile_id, embedding, projected_at
        ) VALUES (
            '41000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '21000000-0000-4000-8000-000000000001',
            'gmail', 'invalid-dimension', 'history:11', 'email', '', 'test://invalid',
            '[]'::jsonb, '{}'::text[], '[]'::jsonb, repeat('c', 64), repeat('d', 64),
            'hosted-multilingual-v1', '[1,2,3]'::public.vector,
            '2026-07-13T10:00:00Z'
        );
        RAISE EXCEPTION 'invalid embedding dimensions unexpectedly succeeded';
    EXCEPTION WHEN data_exception THEN
        NULL;
    END;
END
$tests$;

RESET ROLE;
SET LOCAL ROLE botmem_api;
SELECT set_config('botmem.tenant_id', '10000000-0000-4000-8000-000000000002', true);
DO $tenant_isolation$
BEGIN
    IF EXISTS (SELECT 1 FROM botmem.hosted_document_revision) OR
       EXISTS (SELECT 1 FROM botmem.hosted_document_head) OR
       EXISTS (SELECT 1 FROM botmem.hosted_source_health) THEN
        RAISE EXCEPTION 'tenant RLS exposed hosted search state';
    END IF;
END
$tenant_isolation$;

RESET ROLE;
SET LOCAL ROLE botmem_dispatcher;
DO $least_privilege$
BEGIN
    BEGIN
        PERFORM body FROM botmem.hosted_document_revision;
        RAISE EXCEPTION 'dispatcher unexpectedly read hosted document bodies';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
END
$least_privilege$;

ROLLBACK;
