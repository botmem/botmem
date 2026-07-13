import type { LoginDeliveryPort } from './ports.js';

export interface ResendLoginDeliveryOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/** Production magic-link delivery over Resend's bounded HTTPS API. */
export class ResendLoginDelivery implements LoginDeliveryPort {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: ResendLoginDeliveryOptions) {
    this.apiKey = options.apiKey.trim();
    this.from = options.from.trim();
    this.endpoint = options.endpoint ?? 'https://api.resend.com/emails';
    this.timeoutMs = options.timeoutMs ?? 5_000;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) throw new Error('global fetch is unavailable');
    this.fetch = fetchImplementation.bind(globalThis);
    if (!/^re_[A-Za-z0-9_-]{8,}$/u.test(this.apiKey)) {
      throw new Error('Resend API key is malformed');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(addressPart(this.from))) {
      throw new Error('Resend sender is malformed');
    }
    const endpoint = new URL(this.endpoint);
    const loopbackTestEndpoint = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
    if (
      (endpoint.protocol !== 'https:' && !loopbackTestEndpoint) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    ) {
      throw new Error('Resend endpoint must use credential-free HTTPS');
    }
    if (this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new RangeError('Resend timeout must be between 100 and 30000 milliseconds');
    }
  }

  async readiness(): Promise<boolean> {
    return true;
  }

  async deliverSignInLink(input: {
    readonly email: string;
    readonly url: string;
    readonly expiresAt: string;
  }): Promise<void> {
    const url = new URL(input.url);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') {
      throw new Error('sign-in URL must use HTTPS');
    }
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.valueOf())) throw new Error('sign-in expiry is invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [input.email],
          subject: 'Your Botmem sign-in link',
          text: textBody(url.toString(), expiresAt),
          html: htmlBody(url.toString(), expiresAt),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('login email provider rejected the request');
    } finally {
      clearTimeout(timer);
    }
  }
}

function addressPart(value: string): string {
  const match = /<([^<>]+)>$/u.exec(value);
  return (match?.[1] ?? value).trim();
}

function textBody(url: string, expiresAt: Date): string {
  return [
    'Open Botmem with this single-use sign-in link:',
    '',
    url,
    '',
    `This link expires at ${expiresAt.toISOString()}. If you did not request it, ignore this email.`,
  ].join('\n');
}

function htmlBody(url: string, expiresAt: Date): string {
  const safeUrl = escapeHtml(url);
  return `<p>Open Botmem with this single-use sign-in link:</p><p><a href="${safeUrl}">Sign in to Botmem</a></p><p>This link expires at ${escapeHtml(expiresAt.toISOString())}. If you did not request it, ignore this email.</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
