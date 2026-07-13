-- Distributed, privacy-preserving admission control for unauthenticated Stripe
-- checkout creation. Only keyed hashes are retained; raw email/IP values never
-- enter this table or function arguments.
DO $preflight$
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

CREATE TABLE botmem.billing_checkout_rate_window (
    scope         text        NOT NULL,
    subject_hash  bytea       NOT NULL,
    window_start  timestamptz NOT NULL,
    attempts      integer     NOT NULL,
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (scope, subject_hash, window_start),
    CONSTRAINT billing_checkout_rate_scope_ck
        CHECK (scope IN ('global', 'client', 'email')),
    CONSTRAINT billing_checkout_rate_hash_ck CHECK (octet_length(subject_hash) = 32),
    CONSTRAINT billing_checkout_rate_attempts_ck CHECK (attempts BETWEEN 1 AND 100000),
    CONSTRAINT billing_checkout_rate_expiry_ck CHECK (expires_at > window_start)
);

CREATE INDEX billing_checkout_rate_expiry_idx
    ON botmem.billing_checkout_rate_window (expires_at);

ALTER TABLE botmem.billing_checkout_rate_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE botmem.billing_checkout_rate_window FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_checkout_rate_owner_policy
    ON botmem.billing_checkout_rate_window
    TO botmem_schema_owner USING (true) WITH CHECK (true);

CREATE FUNCTION botmem.consume_billing_checkout_attempt(
    p_client_hash bytea,
    p_email_hash bytea,
    p_now timestamptz
)
RETURNS TABLE (accepted boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = botmem, pg_catalog
AS $consume_checkout$
DECLARE
    global_hash constant bytea := decode(repeat('00', 32), 'hex');
    bucket_count integer;
    global_window timestamptz := date_trunc('minute', p_now);
    long_window timestamptz := date_bin(
        interval '15 minutes', p_now, timestamptz '2000-01-01 00:00:00+00'
    );
    active_until timestamptz;
BEGIN
    IF NOT pg_has_role(session_user, 'botmem_api', 'SET') OR
       octet_length(p_client_hash) <> 32 OR octet_length(p_email_hash) <> 32 OR
       p_now < timestamptz '2024-01-01 00:00:00+00' OR
       p_now > statement_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'checkout admission rejected' USING ERRCODE = '42501';
    END IF;

    -- Bound cleanup work so admission cannot turn into an unbounded sweep.
    DELETE FROM botmem.billing_checkout_rate_window
     WHERE ctid IN (
        SELECT ctid FROM botmem.billing_checkout_rate_window
         WHERE expires_at <= p_now ORDER BY expires_at LIMIT 256
     );
    DELETE FROM botmem.billing_signup
     WHERE ctid IN (
        SELECT signup.ctid
          FROM botmem.billing_signup signup
         WHERE signup.checkout_state IN ('failed', 'expired')
           AND signup.updated_at <= p_now - interval '24 hours'
           AND NOT EXISTS (
               SELECT 1 FROM botmem.billing_subscription subscription
                WHERE subscription.signup_id = signup.id
           )
         ORDER BY signup.updated_at
         LIMIT 64
     );

    INSERT INTO botmem.billing_checkout_rate_window (
        scope, subject_hash, window_start, attempts, expires_at
    ) VALUES ('global', global_hash, global_window, 1, global_window + interval '2 minutes')
    ON CONFLICT (scope, subject_hash, window_start) DO UPDATE
       SET attempts = botmem.billing_checkout_rate_window.attempts + 1
     WHERE botmem.billing_checkout_rate_window.attempts < 200
    RETURNING attempts INTO bucket_count;
    IF bucket_count IS NULL THEN
        RETURN QUERY SELECT false, greatest(1, extract(epoch FROM
            (global_window + interval '1 minute' - p_now))::integer);
        RETURN;
    END IF;

    bucket_count := NULL;
    INSERT INTO botmem.billing_checkout_rate_window (
        scope, subject_hash, window_start, attempts, expires_at
    ) VALUES ('client', p_client_hash, long_window, 1, long_window + interval '30 minutes')
    ON CONFLICT (scope, subject_hash, window_start) DO UPDATE
       SET attempts = botmem.billing_checkout_rate_window.attempts + 1
     WHERE botmem.billing_checkout_rate_window.attempts < 10
    RETURNING attempts INTO bucket_count;
    IF bucket_count IS NULL THEN
        RETURN QUERY SELECT false, greatest(1, extract(epoch FROM
            (long_window + interval '15 minutes' - p_now))::integer);
        RETURN;
    END IF;

    bucket_count := NULL;
    INSERT INTO botmem.billing_checkout_rate_window (
        scope, subject_hash, window_start, attempts, expires_at
    ) VALUES ('email', p_email_hash, long_window, 1, long_window + interval '30 minutes')
    ON CONFLICT (scope, subject_hash, window_start) DO UPDATE
       SET attempts = botmem.billing_checkout_rate_window.attempts + 1
     WHERE botmem.billing_checkout_rate_window.attempts < 3
    RETURNING attempts INTO bucket_count;
    IF bucket_count IS NULL THEN
        RETURN QUERY SELECT false, greatest(1, extract(epoch FROM
            (long_window + interval '15 minutes' - p_now))::integer);
        RETURN;
    END IF;

    SELECT max(signup.expires_at)
      INTO active_until
      FROM botmem.billing_signup signup
     WHERE signup.owner_email_lookup_hash = p_email_hash
       AND signup.checkout_state IN ('pending', 'open', 'complete')
       AND signup.expires_at > p_now
       AND signup.created_at >= p_now - interval '15 minutes';
    IF active_until IS NOT NULL THEN
        RETURN QUERY SELECT false, greatest(1, least(900, extract(epoch FROM
            (active_until - p_now))::integer));
        RETURN;
    END IF;

    RETURN QUERY SELECT true, 0;
END
$consume_checkout$;

REVOKE ALL ON TABLE botmem.billing_checkout_rate_window FROM PUBLIC;
REVOKE ALL ON FUNCTION
    botmem.consume_billing_checkout_attempt(bytea, bytea, timestamptz)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    botmem.consume_billing_checkout_attempt(bytea, bytea, timestamptz)
    TO botmem_api;

RESET ROLE;
