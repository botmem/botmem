-- Stripe Event.created is an integer Unix timestamp. A webhook emitted in the
-- same wall-clock second as a signup can therefore sort up to 999ms before the
-- database's higher-precision signup timestamp without actually predating it.
DO $preflight$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botmem_schema_owner') OR
       NOT pg_has_role(session_user, 'botmem_schema_owner', 'SET') THEN
        RAISE EXCEPTION 'migration login must be allowed to SET ROLE botmem_schema_owner';
    END IF;
END
$preflight$;

SET ROLE botmem_schema_owner;
SET search_path = botmem, pg_catalog;

ALTER TABLE botmem.billing_subscription
    DROP CONSTRAINT billing_subscription_time_ck,
    ADD CONSTRAINT billing_subscription_time_ck CHECK (
        updated_at >= created_at AND stripe_observed_at >= created_at AND
        last_event_created_at >= date_trunc('second', created_at) AND
        (provisioned_at IS NULL OR provisioned_at >= created_at)
    );

RESET ROLE;
