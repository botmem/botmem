/**
 * Shared SSRF guard — validates URLs before server-side fetch.
 * Blocks private IPs, localhost, and non-HTTP protocols.
 */

const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe80'];

export function validateUrlForFetch(url: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { valid: false, reason: `Blocked protocol: ${protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // Block localhost
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return { valid: false, reason: 'Blocked: localhost' };
  }

  // Block IPv6 loopback and private ranges
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') {
    return { valid: false, reason: 'Blocked: IPv6 loopback' };
  }
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (bare.startsWith(prefix)) {
      return { valid: false, reason: `Blocked: private IPv6 (${prefix})` };
    }
  }

  // Block IPv4 private/link-local/loopback
  const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      return { valid: false, reason: 'Blocked: private IPv4' };
    }
  }

  return { valid: true };
}
