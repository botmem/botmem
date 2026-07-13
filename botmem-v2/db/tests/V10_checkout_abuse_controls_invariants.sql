\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE botmem_api;
DO $no_direct_access$
BEGIN
    BEGIN
        PERFORM * FROM botmem.billing_checkout_rate_window;
        RAISE EXCEPTION 'API unexpectedly read checkout rate state';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$no_direct_access$;

DO $client_limit$
DECLARE
    result record;
    attempt integer;
BEGIN
    FOR attempt IN 1..10 LOOP
        SELECT * INTO result FROM botmem.consume_billing_checkout_attempt(
            decode(repeat('a', 64), 'hex'),
            decode(lpad(to_hex(attempt), 64, '0'), 'hex'),
            '2026-07-13T12:01:00Z'
        );
        IF NOT result.accepted THEN RAISE EXCEPTION 'client rejected before limit'; END IF;
    END LOOP;
    SELECT * INTO result FROM botmem.consume_billing_checkout_attempt(
        decode(repeat('a', 64), 'hex'), decode(repeat('b', 64), 'hex'),
        '2026-07-13T12:01:00Z'
    );
    IF result.accepted OR result.retry_after_seconds < 1 THEN
        RAISE EXCEPTION 'client limit was not enforced';
    END IF;
END
$client_limit$;

DO $email_limit$
DECLARE
    result record;
    attempt integer;
BEGIN
    FOR attempt IN 1..3 LOOP
        SELECT * INTO result FROM botmem.consume_billing_checkout_attempt(
            decode(lpad(to_hex(100 + attempt), 64, '0'), 'hex'),
            decode(repeat('c', 64), 'hex'),
            '2026-07-13T12:16:00Z'
        );
        IF NOT result.accepted THEN RAISE EXCEPTION 'email rejected before limit'; END IF;
    END LOOP;
    SELECT * INTO result FROM botmem.consume_billing_checkout_attempt(
        decode(repeat('d', 64), 'hex'), decode(repeat('c', 64), 'hex'),
        '2026-07-13T12:16:00Z'
    );
    IF result.accepted OR result.retry_after_seconds < 1 THEN
        RAISE EXCEPTION 'email limit was not enforced';
    END IF;
END
$email_limit$;

RESET ROLE;
SET LOCAL ROLE botmem_commerce;
DO $worker_denied$
BEGIN
    BEGIN
        PERFORM * FROM botmem.consume_billing_checkout_attempt(
            decode(repeat('e', 64), 'hex'), decode(repeat('f', 64), 'hex'),
            '2026-07-13T12:31:00Z'
        );
        RAISE EXCEPTION 'commerce worker unexpectedly admitted checkout';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END
$worker_denied$;

ROLLBACK;
