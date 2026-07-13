import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_SIGNATURE_HEADER_BYTES = 8_192;

export class StripeWebhookVerifier {
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  constructor(
    secret: string,
    private readonly nowMs: () => number = Date.now,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  ) {
    this.secret = secret.trim();
    this.toleranceSeconds = toleranceSeconds;
    if (!/^whsec_[A-Za-z0-9_-]{8,}$/u.test(this.secret)) {
      throw new Error('Stripe webhook secret is malformed');
    }
    if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 900) {
      throw new RangeError('Stripe webhook tolerance must be between 1 and 900 seconds');
    }
  }

  verify(rawBody: Buffer, signatureHeader: string | undefined): unknown {
    if (rawBody.byteLength < 2 || rawBody.byteLength > MAX_PAYLOAD_BYTES) {
      throw new StripeWebhookRejectedError();
    }
    if (!signatureHeader || signatureHeader.length > MAX_SIGNATURE_HEADER_BYTES) {
      throw new StripeWebhookRejectedError();
    }
    const parsed = parseStripeSignature(signatureHeader);
    const nowSeconds = Math.floor(this.nowMs() / 1_000);
    if (Math.abs(nowSeconds - parsed.timestamp) > this.toleranceSeconds) {
      throw new StripeWebhookRejectedError();
    }
    const expected = createHmac('sha256', this.secret)
      .update(`${parsed.timestamp}.`, 'utf8')
      .update(rawBody)
      .digest();
    const matched = parsed.signatures.some((candidate) => {
      const bytes = Buffer.from(candidate, 'hex');
      return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
    });
    if (!matched) throw new StripeWebhookRejectedError();
    try {
      return JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new StripeWebhookRejectedError();
    }
  }
}

function parseStripeSignature(value: string): {
  readonly timestamp: number;
  readonly signatures: readonly string[];
} {
  const fields = value.split(',').map((part) => part.trim());
  const timestamps = fields.filter((part) => part.startsWith('t=')).map((part) => part.slice(2));
  const signatures = fields
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3))
    .filter((signature) => /^[0-9a-f]{64}$/u.test(signature));
  if (
    timestamps.length !== 1 ||
    !/^\d{1,16}$/u.test(timestamps[0] ?? '') ||
    signatures.length < 1
  ) {
    throw new StripeWebhookRejectedError();
  }
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new StripeWebhookRejectedError();
  return { timestamp, signatures: Object.freeze(signatures) };
}

export class StripeWebhookRejectedError extends Error {
  override readonly name = 'StripeWebhookRejectedError';
}
