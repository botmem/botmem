import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StripeWebhookRejectedError, StripeWebhookVerifier } from './stripe-webhook-security.js';

const SECRET = 'whsec_official_fixture_secret';
const NOW_MS = Date.parse('2026-07-13T10:00:00.000Z');
const TIMESTAMP = Math.floor(NOW_MS / 1_000);

describe('StripeWebhookVerifier', () => {
  it('officialShapedHeader_verifiesTheExactRawBodyAndAcceptsRotatingV1Signatures', () => {
    const raw = Buffer.from('{"id":"evt_fixture","object":"event"}', 'utf8');
    const valid = signature(raw, TIMESTAMP);
    const verifier = new StripeWebhookVerifier(SECRET, () => NOW_MS);

    expect(verifier.verify(raw, `t=${TIMESTAMP},v1=${'0'.repeat(64)},v1=${valid}`)).toMatchObject({
      id: 'evt_fixture',
      object: 'event',
    });
  });

  it('changedBodyStaleTimestampOrMalformedHeader_failsClosed', () => {
    const raw = Buffer.from('{"id":"evt_fixture"}', 'utf8');
    const verifier = new StripeWebhookVerifier(SECRET, () => NOW_MS);
    const header = `t=${TIMESTAMP},v1=${signature(raw, TIMESTAMP)}`;

    expect(() => verifier.verify(Buffer.from('{ "id":"evt_fixture"}'), header)).toThrow(
      StripeWebhookRejectedError,
    );
    expect(() =>
      verifier.verify(raw, `t=${TIMESTAMP - 301},v1=${signature(raw, TIMESTAMP - 301)}`),
    ).toThrow(StripeWebhookRejectedError);
    expect(() => verifier.verify(raw, 'v1=invalid')).toThrow(StripeWebhookRejectedError);
  });
});

function signature(raw: Buffer, timestamp: number): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.`, 'utf8').update(raw).digest('hex');
}
