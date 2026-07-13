-- Stripe-backed subscription commerce. Stripe secrets and raw webhook payloads
-- are deliberately absent; the database stores only verified routing IDs and
-- canonical subscription state retrieved from Stripe's API.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_identity_admin') THEN
        RAISE EXCEPTION 'required Botmem role botmem_identity_admin has not been provisioned';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_commerce') THEN
        RAISE EXCEPTION 'required Botmem role botmem_commerce has not been provisioned';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname IN ('botmem_commerce', 'botmem_identity_admin')
           AND (rolsuper OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION 'commerce runtime roles must be NOSUPERUSER NOBYPASSRLS';
    END IF;
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE FUNCTION botmem.current_billing_signup_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $signup_id$
DECLARE
    value text := current_setting('botmem.billing_signup_id', true);
BEGIN
    IF value IS NULL OR value !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;
    RETURN value::uuid;
END
$signup_id$;

CREATE FUNCTION botmem.current_stripe_checkout_session_id()
RETURNS text
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $checkout_id$
DECLARE
    value text := current_setting('botmem.stripe_checkout_session_id', true);
BEGIN
    IF value IS NULL OR value !~ '^cs_(test_|live_)?[A-Za-z0-9]{6,255}$' THEN
        RETURN NULL;
    END IF;
    RETURN value;
END
$checkout_id$;

CREATE FUNCTION botmem.current_stripe_event_id()
RETURNS text
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $event_id$
DECLARE
    value text := current_setting('botmem.stripe_event_id', true);
BEGIN
    IF value IS NULL OR value !~ '^evt_[A-Za-z0-9_]{6,255}$' THEN
        RETURN NULL;
    END IF;
    RETURN value;
END
$event_id$;

REVOKE ALL ON FUNCTION botmem.current_billing_signup_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.current_stripe_checkout_session_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION botmem.current_stripe_event_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.current_billing_signup_id(),
    botmem.current_stripe_checkout_session_id(),
    botmem.current_stripe_event_id()
    TO botmem_api, botmem_commerce;

CREATE TABLE botmem.billing_signup (
    id                          uuid        PRIMARY KEY,
    tenant_id                   uuid        NOT NULL,
    workspace_id                uuid        NOT NULL,
    owner_user_id               uuid        NOT NULL,
    owner_email                 text        NOT NULL,
    owner_email_lookup_hash     bytea       NOT NULL,
    workspace_name              text        NOT NULL,
    stripe_checkout_session_id  text        UNIQUE,
    checkout_state              text        NOT NULL DEFAULT 'pending',
    created_at                  timestamptz NOT NULL,
    expires_at                  timestamptz NOT NULL,
    updated_at                  timestamptz NOT NULL,
    CONSTRAINT billing_signup_owner_tuple_uq
        UNIQUE (id, tenant_id, workspace_id, owner_user_id),
    CONSTRAINT billing_signup_launch_identity_ck CHECK (
        id = tenant_id AND id = workspace_id
    ),
    CONSTRAINT billing_signup_owner_email_ck CHECK (
        owner_email = lower(btrim(owner_email)) AND
        owner_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND
        length(owner_email) <= 320
    ),
    CONSTRAINT billing_signup_email_hash_ck CHECK (octet_length(owner_email_lookup_hash) = 32),
    CONSTRAINT billing_signup_workspace_name_ck
        CHECK (length(btrim(workspace_name)) BETWEEN 1 AND 128),
    CONSTRAINT billing_signup_checkout_id_ck CHECK (
        stripe_checkout_session_id IS NULL OR
        stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT billing_signup_state_ck
        CHECK (checkout_state IN ('pending', 'open', 'complete', 'expired', 'failed')),
    CONSTRAINT billing_signup_time_ck CHECK (
        expires_at > created_at AND updated_at >= created_at
    )
);

CREATE INDEX billing_signup_email_cooldown_idx
    ON botmem.billing_signup (owner_email_lookup_hash, created_at DESC);

CREATE TABLE botmem.billing_subscription (
    signup_id                   uuid        PRIMARY KEY,
    tenant_id                   uuid        NOT NULL UNIQUE,
    workspace_id                uuid        NOT NULL UNIQUE,
    owner_user_id               uuid        NOT NULL,
    stripe_checkout_session_id  text        NOT NULL UNIQUE,
    stripe_customer_id          text        NOT NULL UNIQUE,
    stripe_subscription_id      text        NOT NULL UNIQUE,
    stripe_price_id             text        NOT NULL,
    quantity                    integer     NOT NULL,
    stripe_status               text        NOT NULL,
    price_matches               boolean     NOT NULL,
    stripe_observed_at          timestamptz NOT NULL,
    last_event_created_at       timestamptz NOT NULL,
    last_event_id               text        NOT NULL,
    current_period_end          timestamptz,
    provisioned_at              timestamptz,
    created_at                  timestamptz NOT NULL,
    updated_at                  timestamptz NOT NULL,
    CONSTRAINT billing_subscription_signup_fk FOREIGN KEY (signup_id)
        REFERENCES botmem.billing_signup (id),
    CONSTRAINT billing_subscription_signup_owner_fk
        FOREIGN KEY (signup_id, tenant_id, workspace_id, owner_user_id)
        REFERENCES botmem.billing_signup (id, tenant_id, workspace_id, owner_user_id),
    CONSTRAINT billing_subscription_checkout_id_ck CHECK (
        stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT billing_subscription_customer_id_ck
        CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,255}$'),
    CONSTRAINT billing_subscription_id_ck
        CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,255}$'),
    CONSTRAINT billing_subscription_price_id_ck
        CHECK (stripe_price_id ~ '^price_[A-Za-z0-9]{6,255}$'),
    CONSTRAINT billing_subscription_quantity_ck CHECK (quantity = 1),
    CONSTRAINT billing_subscription_status_ck CHECK (
        stripe_status IN (
            'incomplete', 'incomplete_expired', 'trialing', 'active',
            'past_due', 'canceled', 'unpaid', 'paused'
        )
    ),
    CONSTRAINT billing_subscription_event_id_ck
        CHECK (last_event_id ~ '^evt_[A-Za-z0-9_]{6,255}$'),
    CONSTRAINT billing_subscription_time_ck CHECK (
        updated_at >= created_at AND stripe_observed_at >= created_at AND
        last_event_created_at >= created_at AND
        (provisioned_at IS NULL OR provisioned_at >= created_at)
    )
);

CREATE INDEX billing_subscription_entitlement_idx
    ON botmem.billing_subscription (tenant_id, workspace_id, stripe_status, stripe_price_id)
    WHERE provisioned_at IS NOT NULL AND price_matches;

CREATE TABLE botmem.stripe_webhook_event (
    id                          text        PRIMARY KEY,
    event_type                  text        NOT NULL,
    event_created_at            timestamptz NOT NULL,
    object_id                   text        NOT NULL,
    supported                   boolean     NOT NULL,
    signup_id                   uuid,
    stripe_checkout_session_id  text,
    stripe_subscription_id      text,
    stripe_customer_id          text,
    state                       text        NOT NULL DEFAULT 'pending',
    attempts                    integer     NOT NULL DEFAULT 0,
    received_at                 timestamptz NOT NULL,
    available_at                timestamptz NOT NULL,
    worker_id                   text,
    claimed_at                  timestamptz,
    lease_expires_at            timestamptz,
    processed_at                timestamptz,
    failure_code                text,
    CONSTRAINT stripe_webhook_event_id_ck CHECK (id ~ '^evt_[A-Za-z0-9_]{6,255}$'),
    CONSTRAINT stripe_webhook_event_type_ck CHECK (length(event_type) BETWEEN 1 AND 256),
    CONSTRAINT stripe_webhook_object_id_ck CHECK (length(object_id) BETWEEN 3 AND 256),
    CONSTRAINT stripe_webhook_checkout_id_ck CHECK (
        stripe_checkout_session_id IS NULL OR
        stripe_checkout_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT stripe_webhook_subscription_id_ck CHECK (
        stripe_subscription_id IS NULL OR
        stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT stripe_webhook_customer_id_ck CHECK (
        stripe_customer_id IS NULL OR
        stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,255}$'
    ),
    CONSTRAINT stripe_webhook_state_ck
        CHECK (state IN ('pending', 'processing', 'processed', 'ignored', 'dead_letter')),
    CONSTRAINT stripe_webhook_attempts_ck CHECK (attempts BETWEEN 0 AND 100),
    CONSTRAINT stripe_webhook_worker_id_ck CHECK (
        worker_id IS NULL OR worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT stripe_webhook_terminal_ck CHECK (
        (state = 'pending' AND worker_id IS NULL AND claimed_at IS NULL AND
         lease_expires_at IS NULL AND processed_at IS NULL) OR
        (state = 'processing' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL AND
         lease_expires_at > claimed_at AND processed_at IS NULL AND failure_code IS NULL) OR
        (state IN ('processed', 'ignored') AND worker_id IS NULL AND claimed_at IS NULL AND
         lease_expires_at IS NULL AND processed_at IS NOT NULL AND failure_code IS NULL) OR
        (state = 'dead_letter' AND worker_id IS NULL AND claimed_at IS NULL AND
         lease_expires_at IS NULL AND processed_at IS NOT NULL AND failure_code IS NOT NULL)
    ),
    CONSTRAINT stripe_webhook_failure_ck CHECK (
        failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,128}$'
    ),
    CONSTRAINT stripe_webhook_time_ck CHECK (
        available_at >= received_at AND
        (processed_at IS NULL OR processed_at >= received_at)
    )
);

CREATE INDEX stripe_webhook_recovery_idx
    ON botmem.stripe_webhook_event (available_at, received_at, id)
    WHERE state = 'pending';
CREATE INDEX stripe_webhook_expired_lease_idx
    ON botmem.stripe_webhook_event (lease_expires_at, id)
    WHERE state = 'processing';

CREATE TABLE botmem.commerce_reconciler_heartbeat (
    worker_id    text        PRIMARY KEY,
    started_at  timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    CONSTRAINT commerce_reconciler_worker_id_ck
        CHECK (worker_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT commerce_reconciler_heartbeat_time_ck CHECK (last_seen_at >= started_at)
);

CREATE FUNCTION botmem.enforce_billing_ownership_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $billing_updates$
BEGIN
    IF TG_TABLE_NAME = 'billing_signup' THEN
        IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR
           NEW.workspace_id <> OLD.workspace_id OR NEW.owner_user_id <> OLD.owner_user_id OR
           NEW.owner_email <> OLD.owner_email OR
           NEW.owner_email_lookup_hash <> OLD.owner_email_lookup_hash OR
           NEW.workspace_name <> OLD.workspace_name OR NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'billing signup ownership is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.stripe_checkout_session_id IS NOT NULL AND
           NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id THEN
            RAISE EXCEPTION 'checkout session binding is immutable' USING ERRCODE = '55000';
        END IF;
    ELSIF TG_TABLE_NAME = 'billing_subscription' THEN
        IF NEW.signup_id <> OLD.signup_id OR NEW.tenant_id <> OLD.tenant_id OR
           NEW.workspace_id <> OLD.workspace_id OR NEW.owner_user_id <> OLD.owner_user_id OR
           NEW.stripe_checkout_session_id <> OLD.stripe_checkout_session_id OR
           NEW.stripe_customer_id <> OLD.stripe_customer_id OR
           NEW.stripe_subscription_id <> OLD.stripe_subscription_id OR
           NEW.created_at <> OLD.created_at THEN
            RAISE EXCEPTION 'billing subscription ownership is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.provisioned_at IS NOT NULL AND NEW.provisioned_at IS NULL THEN
            RAISE EXCEPTION 'provisioning history cannot be removed' USING ERRCODE = '55000';
        END IF;
        IF NEW.stripe_observed_at < OLD.stripe_observed_at THEN
            RAISE EXCEPTION 'canonical Stripe observation cannot move backwards'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'billing update time cannot move backwards' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$billing_updates$;

REVOKE ALL ON FUNCTION botmem.enforce_billing_ownership_updates() FROM PUBLIC;
CREATE TRIGGER billing_signup_update_invariants
BEFORE UPDATE ON botmem.billing_signup
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_billing_ownership_updates();
CREATE TRIGGER billing_subscription_update_invariants
BEFORE UPDATE ON botmem.billing_subscription
FOR EACH ROW EXECUTE FUNCTION botmem.enforce_billing_ownership_updates();

CREATE FUNCTION botmem.claim_stripe_webhook(
    p_worker_id text,
    p_claimed_at timestamptz,
    p_lease_expires_at timestamptz,
    p_max_attempts integer
)
RETURNS TABLE (
    event_id text,
    event_type text,
    event_created_at timestamptz,
    object_id text,
    supported boolean,
    signup_id uuid,
    stripe_checkout_session_id text,
    stripe_subscription_id text,
    stripe_customer_id text,
    attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $claim_webhook$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_max_attempts NOT BETWEEN 1 AND 100 OR
       p_lease_expires_at <= p_claimed_at THEN
        RAISE EXCEPTION 'commerce reconciler claim rejected' USING ERRCODE = '42501';
    END IF;

    UPDATE botmem.stripe_webhook_event event
       SET state = 'dead_letter', worker_id = NULL, claimed_at = NULL,
           lease_expires_at = NULL, processed_at = p_claimed_at,
           failure_code = 'LEASE_ATTEMPTS_EXHAUSTED'
     WHERE event.state = 'processing'
       AND event.lease_expires_at <= p_claimed_at
       AND event.attempts >= p_max_attempts;

    RETURN QUERY
    WITH candidate AS (
        SELECT queued.id
          FROM botmem.stripe_webhook_event queued
         WHERE (
             (queued.state = 'pending' AND queued.available_at <= p_claimed_at) OR
             (queued.state = 'processing' AND queued.lease_expires_at <= p_claimed_at)
         )
           AND queued.attempts < p_max_attempts
         ORDER BY queued.available_at, queued.received_at, queued.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    )
    UPDATE botmem.stripe_webhook_event queued
       SET state = 'processing', attempts = queued.attempts + 1,
           worker_id = p_worker_id, claimed_at = p_claimed_at,
           lease_expires_at = p_lease_expires_at,
           processed_at = NULL, failure_code = NULL
      FROM candidate
     WHERE queued.id = candidate.id
    RETURNING queued.id, queued.event_type, queued.event_created_at,
              queued.object_id, queued.supported, queued.signup_id,
              queued.stripe_checkout_session_id, queued.stripe_subscription_id,
              queued.stripe_customer_id, queued.attempts;
END
$claim_webhook$;

CREATE FUNCTION botmem.heartbeat_commerce_reconciler(
    p_worker_id text,
    p_started_at timestamptz,
    p_seen_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $heartbeat_reconciler$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_commerce', 'SET') OR
       p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' OR
       p_seen_at < p_started_at THEN
        RAISE EXCEPTION 'commerce reconciler heartbeat rejected' USING ERRCODE = '42501';
    END IF;
    INSERT INTO botmem.commerce_reconciler_heartbeat (worker_id, started_at, last_seen_at)
    VALUES (p_worker_id, p_started_at, p_seen_at)
    ON CONFLICT (worker_id) DO UPDATE
       SET started_at = LEAST(
               botmem.commerce_reconciler_heartbeat.started_at,
               EXCLUDED.started_at
           ),
           last_seen_at = GREATEST(
               botmem.commerce_reconciler_heartbeat.last_seen_at,
               EXCLUDED.last_seen_at
           );
END
$heartbeat_reconciler$;

CREATE FUNCTION botmem.commerce_reconciler_ready(
    p_now timestamptz,
    p_maximum_age_seconds integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = botmem, pg_catalog
RETURN p_maximum_age_seconds BETWEEN 1 AND 3600 AND EXISTS (
    SELECT 1
      FROM botmem.commerce_reconciler_heartbeat heartbeat
     WHERE heartbeat.last_seen_at >=
           p_now - make_interval(secs => p_maximum_age_seconds)
       AND heartbeat.last_seen_at <= p_now + interval '30 seconds'
);

REVOKE ALL ON FUNCTION
    botmem.claim_stripe_webhook(text, timestamptz, timestamptz, integer),
    botmem.heartbeat_commerce_reconciler(text, timestamptz, timestamptz),
    botmem.commerce_reconciler_ready(timestamptz, integer)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.claim_stripe_webhook(text, timestamptz, timestamptz, integer),
    botmem.heartbeat_commerce_reconciler(text, timestamptz, timestamptz)
    TO botmem_commerce;
GRANT EXECUTE ON FUNCTION
    botmem.commerce_reconciler_ready(timestamptz, integer)
    TO botmem_api, botmem_commerce;

ALTER TABLE botmem.billing_signup ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.billing_signup FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.billing_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.billing_subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.stripe_webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.stripe_webhook_event FORCE ROW LEVEL SECURITY;
ALTER TABLE botmem.commerce_reconciler_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.commerce_reconciler_heartbeat FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_signup_capability_policy ON botmem.billing_signup
    TO botmem_api
    USING (
        id = botmem.current_billing_signup_id() OR
        stripe_checkout_session_id = botmem.current_stripe_checkout_session_id() OR
        (tenant_id = botmem.current_tenant_id() AND
         workspace_id = botmem.current_workspace_id())
    )
    WITH CHECK (id = botmem.current_billing_signup_id());

CREATE POLICY billing_signup_commerce_policy ON botmem.billing_signup
    TO botmem_commerce
    USING (id = botmem.current_billing_signup_id())
    WITH CHECK (id = botmem.current_billing_signup_id());

CREATE POLICY billing_subscription_capability_policy ON botmem.billing_subscription
    TO botmem_api
    USING (
        signup_id = botmem.current_billing_signup_id() OR
        stripe_checkout_session_id = botmem.current_stripe_checkout_session_id() OR
        (tenant_id = botmem.current_tenant_id() AND
         workspace_id = botmem.current_workspace_id())
    )
    WITH CHECK (signup_id = botmem.current_billing_signup_id());

CREATE POLICY billing_subscription_commerce_policy ON botmem.billing_subscription
    TO botmem_commerce
    USING (signup_id = botmem.current_billing_signup_id())
    WITH CHECK (signup_id = botmem.current_billing_signup_id());

CREATE POLICY stripe_webhook_event_exact_policy ON botmem.stripe_webhook_event
    TO botmem_api
    USING (id = botmem.current_stripe_event_id())
    WITH CHECK (id = botmem.current_stripe_event_id());

CREATE POLICY stripe_webhook_event_commerce_policy ON botmem.stripe_webhook_event
    TO botmem_commerce
    USING (id = botmem.current_stripe_event_id())
    WITH CHECK (id = botmem.current_stripe_event_id());

-- The SECURITY DEFINER queue functions execute as the non-login schema owner;
-- runtime callers never receive this policy or direct heartbeat table grants.
CREATE POLICY stripe_webhook_event_owner_worker_policy ON botmem.stripe_webhook_event
    TO botmem_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY commerce_reconciler_heartbeat_owner_policy
    ON botmem.commerce_reconciler_heartbeat
    TO botmem_schema_owner USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA botmem TO botmem_commerce;
GRANT SELECT, INSERT ON botmem.billing_signup TO botmem_api;
GRANT UPDATE (stripe_checkout_session_id, checkout_state, expires_at, updated_at)
    ON botmem.billing_signup TO botmem_api;
GRANT SELECT ON botmem.billing_subscription TO botmem_api;
GRANT SELECT, UPDATE ON botmem.billing_signup TO botmem_commerce;
GRANT SELECT, INSERT ON botmem.billing_subscription TO botmem_commerce;
GRANT UPDATE (
    stripe_price_id, quantity, stripe_status, price_matches, stripe_observed_at,
    last_event_created_at, last_event_id, current_period_end, provisioned_at, updated_at
) ON botmem.billing_subscription TO botmem_commerce;
GRANT SELECT, INSERT ON botmem.stripe_webhook_event TO botmem_api;
GRANT SELECT ON botmem.stripe_webhook_event TO botmem_commerce;
GRANT UPDATE (
    state, attempts, available_at, worker_id, claimed_at, lease_expires_at,
    processed_at, failure_code
) ON botmem.stripe_webhook_event TO botmem_commerce;

RESET ROLE;
