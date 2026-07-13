-- Hosted search projection for Botmem v2.
--
-- Searchable rows are append-only revisions. A small head table selects the
-- current revision for each provider source identity. This keeps mutations
-- auditable while making the active corpus cheap to query and repair.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RAISE EXCEPTION 'the vector extension must be installed before hosted search';
    END IF;
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- One launch embedding contract. Changing the provider/model is a new profile,
-- never an in-place reinterpretation of stored vectors.
CREATE TABLE botmem.embedding_profile (
    id                  text        PRIMARY KEY,
    dimensions          integer     NOT NULL,
    distance            text        NOT NULL,
    status              text        NOT NULL DEFAULT 'indexing',
    model_revision      text        NOT NULL,
    failure_code        text,
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT embedding_profile_launch_id_ck
        CHECK (id = 'hosted-multilingual-v1'),
    CONSTRAINT embedding_profile_dimensions_ck CHECK (dimensions = 768),
    CONSTRAINT embedding_profile_distance_ck CHECK (distance = 'cosine'),
    CONSTRAINT embedding_profile_status_ck
        CHECK (status IN ('indexing', 'ready', 'error')),
    CONSTRAINT embedding_profile_failure_ck CHECK (
        (status = 'error' AND failure_code IS NOT NULL) OR
        (status <> 'error' AND failure_code IS NULL)
    ),
    CONSTRAINT embedding_profile_model_revision_ck
        CHECK (length(btrim(model_revision)) BETWEEN 1 AND 256),
    CONSTRAINT embedding_profile_failure_code_ck
        CHECK (failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 128)
);

INSERT INTO botmem.embedding_profile (
    id, dimensions, distance, status, model_revision
) VALUES (
    'hosted-multilingual-v1', 768, 'cosine', 'indexing', 'unconfigured'
);

-- Language-neutral normalization keeps English and Arabic tokens in one
-- deterministic index. Arabic combining marks/tatweel are removed and common
-- alif/ya variants are folded. Extracted names may be indexed as text, but may
-- never populate participant_durable_ids.
CREATE FUNCTION botmem.normalize_search_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
RETURN lower(
    translate(
        regexp_replace(input, U&'[\064B-\065F\0670\06D6-\06ED\0640]', '', 'g'),
        U&'\0622\0623\0625\0671\0649\0624\0626',
        U&'\0627\0627\0627\0627\064A\0648\064A'
    )
);

REVOKE ALL ON FUNCTION botmem.normalize_search_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION botmem.normalize_search_text(text) TO botmem_api, botmem_worker;

CREATE TABLE botmem.hosted_document_revision (
    revision_id                uuid        PRIMARY KEY,
    tenant_id                  uuid        NOT NULL,
    account_id                 uuid        NOT NULL,
    connector                  text        NOT NULL,
    source_event_id            text        NOT NULL,
    source_revision            text        NOT NULL,
    kind                       text        NOT NULL,
    occurred_at                timestamptz,
    title                      text,
    body                       text        NOT NULL,
    thread_durable_id          text,
    thread_title               text,
    authored_by_me             boolean,
    citation                   text        NOT NULL,
    participants               jsonb       NOT NULL DEFAULT '[]'::jsonb,
    participant_durable_ids    text[]      NOT NULL DEFAULT '{}'::text[],
    media                      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    content_hash               text        NOT NULL,
    projection_hash            text        NOT NULL,
    embedding_profile_id       text,
    embedding                  public.halfvec(768),
    projected_at               timestamptz NOT NULL,
    search_text                text GENERATED ALWAYS AS (
        botmem.normalize_search_text(
            coalesce(title, '') || ' ' || body || ' ' || coalesce(thread_title, '')
        )
    ) STORED,
    search_vector              tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', botmem.normalize_search_text(coalesce(title, ''))), 'A') ||
        setweight(to_tsvector('simple', botmem.normalize_search_text(body)), 'B') ||
        setweight(to_tsvector('simple', botmem.normalize_search_text(coalesce(thread_title, ''))), 'C')
    ) STORED,
    CONSTRAINT hosted_document_revision_ingest_fk
        FOREIGN KEY (tenant_id, account_id, revision_id)
        REFERENCES botmem.ingest_event_revision (tenant_id, account_id, id),
    CONSTRAINT hosted_document_revision_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT hosted_document_revision_profile_fk
        FOREIGN KEY (embedding_profile_id)
        REFERENCES botmem.embedding_profile (id),
    CONSTRAINT hosted_document_revision_identity_uq
        UNIQUE (tenant_id, account_id, source_event_id, revision_id),
    CONSTRAINT hosted_document_revision_connector_ck
        CHECK (connector IN ('gmail', 'outlook', 'owntracks')),
    CONSTRAINT hosted_document_revision_kind_ck CHECK (kind IN ('email', 'location')),
    CONSTRAINT hosted_document_revision_connector_kind_ck CHECK (
        (connector IN ('gmail', 'outlook') AND kind = 'email') OR
        (connector = 'owntracks' AND kind = 'location')
    ),
    CONSTRAINT hosted_document_revision_source_event_id_ck
        CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 2048),
    CONSTRAINT hosted_document_revision_source_revision_ck
        CHECK (length(btrim(source_revision)) BETWEEN 1 AND 512),
    CONSTRAINT hosted_document_revision_title_ck
        CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 2048),
    CONSTRAINT hosted_document_revision_body_ck CHECK (length(body) <= 20000),
    CONSTRAINT hosted_document_revision_thread_id_ck
        CHECK (thread_durable_id IS NULL OR length(btrim(thread_durable_id)) BETWEEN 1 AND 1024),
    CONSTRAINT hosted_document_revision_thread_title_ck
        CHECK (thread_title IS NULL OR length(btrim(thread_title)) BETWEEN 1 AND 1024),
    CONSTRAINT hosted_document_revision_citation_ck
        CHECK (length(btrim(citation)) BETWEEN 1 AND 4096),
    CONSTRAINT hosted_document_revision_participants_ck
        CHECK (jsonb_typeof(participants) = 'array' AND jsonb_array_length(participants) <= 256),
    CONSTRAINT hosted_document_revision_media_ck
        CHECK (jsonb_typeof(media) = 'array' AND jsonb_array_length(media) <= 128),
    CONSTRAINT hosted_document_revision_participant_ids_ck CHECK (
        cardinality(participant_durable_ids) <= 4096 AND
        array_position(participant_durable_ids, NULL) IS NULL
    ),
    CONSTRAINT hosted_document_revision_content_hash_ck
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT hosted_document_revision_projection_hash_ck
        CHECK (projection_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT hosted_document_revision_embedding_pair_ck CHECK (
        (embedding IS NULL AND embedding_profile_id IS NULL) OR
        (embedding IS NOT NULL AND embedding_profile_id = 'hosted-multilingual-v1')
    )
);

CREATE TABLE botmem.hosted_document_head (
    tenant_id           uuid        NOT NULL,
    account_id          uuid        NOT NULL,
    source_event_id     text        NOT NULL,
    revision_id         uuid        NOT NULL,
    updated_at          timestamptz NOT NULL,
    PRIMARY KEY (account_id, source_event_id),
    CONSTRAINT hosted_document_head_revision_fk
        FOREIGN KEY (tenant_id, account_id, source_event_id, revision_id)
        REFERENCES botmem.hosted_document_revision (
            tenant_id, account_id, source_event_id, revision_id
        ),
    CONSTRAINT hosted_document_head_identity_uq
        UNIQUE (tenant_id, account_id, source_event_id)
);

-- A source is not "ready" merely because rows exist. Workers update this only
-- after an actual search probe succeeds against the active projection.
CREATE TABLE botmem.hosted_source_health (
    tenant_id           uuid        NOT NULL,
    account_id          uuid        PRIMARY KEY,
    searchable          boolean     NOT NULL DEFAULT false,
    last_probe_at       timestamptz,
    reason_code         text,
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT hosted_source_health_account_fk
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES botmem.connector_account (tenant_id, id),
    CONSTRAINT hosted_source_health_probe_ck CHECK (
        (searchable AND last_probe_at IS NOT NULL AND reason_code IS NULL) OR
        (NOT searchable)
    ),
    CONSTRAINT hosted_source_health_reason_ck
        CHECK (reason_code IS NULL OR length(btrim(reason_code)) BETWEEN 1 AND 128)
);

CREATE INDEX hosted_document_revision_lexical_gin
    ON botmem.hosted_document_revision USING gin (search_vector);
CREATE INDEX hosted_document_revision_trigram_gin
    ON botmem.hosted_document_revision USING gin (search_text public.gin_trgm_ops);
CREATE INDEX hosted_document_revision_embedding_hnsw
    ON botmem.hosted_document_revision USING hnsw (embedding public.halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding_profile_id = 'hosted-multilingual-v1';
CREATE INDEX hosted_document_revision_tenant_filter_idx
    ON botmem.hosted_document_revision (
        tenant_id, connector, account_id, kind, occurred_at DESC, revision_id
    );
CREATE INDEX hosted_document_revision_participant_gin
    ON botmem.hosted_document_revision USING gin (participant_durable_ids);
CREATE INDEX hosted_document_head_tenant_revision_idx
    ON botmem.hosted_document_head (tenant_id, revision_id);

CREATE TRIGGER hosted_document_revision_is_immutable
BEFORE UPDATE OR DELETE ON botmem.hosted_document_revision
FOR EACH ROW EXECUTE FUNCTION botmem.reject_immutable_revision_mutation();

ALTER TABLE botmem.embedding_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.embedding_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_document_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_document_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_document_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_document_head FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_source_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.hosted_source_health FORCE ROW LEVEL SECURITY;

-- Profile metadata contains no tenant data and is readable by runtime roles.
CREATE POLICY embedding_profile_api_read_policy ON botmem.embedding_profile
    FOR SELECT TO botmem_api USING (true);
CREATE POLICY embedding_profile_worker_policy ON botmem.embedding_profile
    TO botmem_worker USING (true) WITH CHECK (true);
CREATE POLICY hosted_document_revision_tenant_policy ON botmem.hosted_document_revision
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY hosted_document_head_tenant_policy ON botmem.hosted_document_head
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());
CREATE POLICY hosted_source_health_tenant_policy ON botmem.hosted_source_health
    TO botmem_api, botmem_worker
    USING (tenant_id = botmem.current_tenant_id())
    WITH CHECK (tenant_id = botmem.current_tenant_id());

GRANT SELECT ON botmem.embedding_profile TO botmem_api, botmem_worker;
GRANT UPDATE (status, model_revision, failure_code, updated_at)
    ON botmem.embedding_profile TO botmem_worker;

GRANT SELECT (
    revision_id, tenant_id, account_id, connector, source_event_id,
    source_revision, kind, occurred_at, title, body, thread_durable_id,
    thread_title, authored_by_me, citation, participants,
    participant_durable_ids, media, embedding_profile_id, embedding,
    projected_at, search_text, search_vector
) ON botmem.hosted_document_revision TO botmem_api;
GRANT SELECT ON botmem.hosted_document_head TO botmem_api;

GRANT SELECT, INSERT ON botmem.hosted_document_revision TO botmem_worker;
GRANT SELECT, INSERT ON botmem.hosted_document_head TO botmem_worker;
GRANT UPDATE (revision_id, updated_at) ON botmem.hosted_document_head TO botmem_worker;
GRANT DELETE ON botmem.hosted_document_head TO botmem_worker;
GRANT SELECT ON botmem.hosted_source_health TO botmem_api;
GRANT SELECT, INSERT ON botmem.hosted_source_health TO botmem_worker;
GRANT UPDATE (searchable, last_probe_at, reason_code, updated_at)
    ON botmem.hosted_source_health TO botmem_worker;

-- Connector and checkpoint metadata form the authenticated source-status read
-- model. Credential references and provider subjects remain inaccessible to
-- this read path through column-scoped grants.
GRANT SELECT (id, tenant_id, connector, status)
    ON botmem.connector_account TO botmem_api;
GRANT SELECT (tenant_id, account_id, cursor_version, last_committed_at)
    ON botmem.connector_checkpoint TO botmem_api;
GRANT SELECT (tenant_id, account_id, projection_name, state, applied_at, updated_at)
    ON botmem.projection_state TO botmem_api;
CREATE POLICY projection_state_api_read_policy ON botmem.projection_state
    FOR SELECT TO botmem_api
    USING (tenant_id = botmem.current_tenant_id());
GRANT SELECT (tenant_id, account_id, source_event_id, head_revision_id, updated_at)
    ON botmem.ingest_event_head TO botmem_api;
CREATE POLICY ingest_event_head_api_read_policy ON botmem.ingest_event_head
    FOR SELECT TO botmem_api
    USING (tenant_id = botmem.current_tenant_id());

-- Verify the physical ANN contract during migration rather than discovering a
-- wrong operator class in production traffic.
DO $index_contract$
DECLARE
    operator_class text;
    access_method text;
BEGIN
    SELECT opc.opcname, am.amname
      INTO operator_class, access_method
      FROM pg_catalog.pg_index idx
      JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
      JOIN pg_catalog.pg_opclass opc ON opc.oid = idx.indclass[0]
      JOIN pg_catalog.pg_am am ON am.oid = index_class.relam
     WHERE index_class.oid = 'botmem.hosted_document_revision_embedding_hnsw'::regclass;

    IF operator_class IS DISTINCT FROM 'halfvec_cosine_ops' OR access_method IS DISTINCT FROM 'hnsw' THEN
        RAISE EXCEPTION 'hosted semantic index contract is %, expected hnsw/halfvec_cosine_ops',
            concat_ws('/', access_method, operator_class);
    END IF;
END
$index_contract$;

RESET ROLE;
