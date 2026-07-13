import { isIP } from 'node:net';
import {
  OwnTracksDnsError,
  OwnTracksEndpointRejectedError,
  OwnTracksRedirectError,
} from './errors.js';
import type {
  OwnTracksDnsPort,
  OwnTracksEndpointConfiguration,
  ResolvedAddress,
  ValidatedOwnTracksEndpoint,
} from './ports.js';

const DEFAULT_PORT = 443;
const MAX_ALLOWED_PORTS = 16;
const MAX_RESOLVED_ADDRESSES = 16;
const LOCATIONS_PATH = /\/api\/0\/locations\/?$/;

function parseIpv4(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function ipv4InCidr(bytes: readonly number[], base: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < 4; index += 1) {
    if (remaining <= 0) return true;
    const width = Math.min(remaining, 8);
    const mask = (0xff << (8 - width)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) return false;
    remaining -= width;
  }
  return true;
}

const BLOCKED_IPV4: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 31, 196, 0], 24],
  [[192, 52, 193, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[192, 175, 48, 0], 24],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function parseIpv6(address: string): Uint8Array | null {
  const withoutZone = address.split('%', 1)[0] ?? '';
  if (!withoutZone || withoutZone.includes('.')) return null;
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const output = new Uint8Array(16);
  words.forEach((word, index) => {
    const value = Number.parseInt(word, 16);
    output[index * 2] = value >>> 8;
    output[index * 2 + 1] = value & 0xff;
  });
  return output;
}

function bytesInCidr(bytes: Uint8Array, base: Uint8Array, bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < bytes.length; index += 1) {
    if (remaining <= 0) return true;
    const width = Math.min(remaining, 8);
    const mask = (0xff << (8 - width)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) return false;
    remaining -= width;
  }
  return true;
}

function ipv6Base(value: string): Uint8Array {
  const parsed = parseIpv6(value);
  if (!parsed) throw new Error('invalid static IPv6 prefix');
  return parsed;
}

const GLOBAL_UNICAST = ipv6Base('2000::');
const BLOCKED_IPV6: readonly (readonly [Uint8Array, number])[] = [
  [ipv6Base('2001::'), 23],
  [ipv6Base('2001:db8::'), 32],
  [ipv6Base('2002::'), 16],
  [ipv6Base('2620:4f:8000::'), 48],
  [ipv6Base('3fff::'), 20],
];

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address);
    return Boolean(bytes && !BLOCKED_IPV4.some(([base, bits]) => ipv4InCidr(bytes, base, bits)));
  }
  if (family !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;

  const mappedPrefix = bytes.slice(0, 12);
  const isMapped =
    mappedPrefix.slice(0, 10).every((byte) => byte === 0) &&
    mappedPrefix[10] === 0xff &&
    mappedPrefix[11] === 0xff;
  if (isMapped) {
    const mapped = [...bytes.slice(12)].join('.');
    return isPublicInternetAddress(mapped);
  }

  // Current globally-routable IPv6 unicast space is 2000::/3. Explicitly
  // remove IANA special-purpose allocations contained inside that range.
  if (!bytesInCidr(bytes, GLOBAL_UNICAST, 3)) return false;
  return !BLOCKED_IPV6.some(([base, bits]) => bytesInCidr(bytes, base, bits));
}

function normalizeAllowedPorts(value: readonly number[] | undefined): readonly number[] {
  const ports = value ?? [DEFAULT_PORT];
  if (
    ports.length === 0 ||
    ports.length > MAX_ALLOWED_PORTS ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new OwnTracksEndpointRejectedError();
  }
  return Object.freeze([...new Set(ports)].sort((left, right) => left - right));
}

function parseEndpoint(raw: string, allowedPorts: readonly number[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OwnTracksEndpointRejectedError();
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !LOCATIONS_PATH.test(url.pathname) ||
    !allowedPorts.includes(port)
  ) {
    throw new OwnTracksEndpointRejectedError();
  }
  return url;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export class OwnTracksEndpointPolicy {
  public constructor(
    private readonly dns: OwnTracksDnsPort,
    private readonly options: {
      readonly allowPrivateTestEndpoints?: boolean;
      readonly defaultAllowedPorts?: readonly number[];
    } = {},
  ) {}

  /** Configuration-time validation. Requests repeat the same validation. */
  public async configure(
    input: OwnTracksEndpointConfiguration,
    signal?: AbortSignal,
  ): Promise<ValidatedOwnTracksEndpoint> {
    const allowedPorts = normalizeAllowedPorts(
      input.allowedPorts ?? this.options.defaultAllowedPorts,
    );
    const url = parseEndpoint(input.endpoint, allowedPorts);
    await this.resolveAndPin(url, allowedPorts, signal);
    return Object.freeze({ endpoint: url.toString(), allowedPorts });
  }

  public async resolveAndPin(
    input: string | URL,
    allowedPorts: readonly number[],
    signal?: AbortSignal,
  ): Promise<{ readonly url: URL; readonly addresses: readonly ResolvedAddress[] }> {
    const url = parseEndpoint(input.toString(), normalizeAllowedPorts(allowedPorts));
    const hostname = hostnameWithoutBrackets(url.hostname);
    const literalFamily = isIP(hostname);
    let addresses: readonly ResolvedAddress[];
    if (literalFamily) {
      addresses = [Object.freeze({ address: hostname, family: literalFamily as 4 | 6 })];
    } else {
      try {
        addresses = await this.dns.resolveAll(hostname, signal);
      } catch {
        throw new OwnTracksDnsError();
      }
    }
    if (
      addresses.length === 0 ||
      addresses.length > MAX_RESOLVED_ADDRESSES ||
      addresses.some(
        (entry) =>
          (entry.family !== 4 && entry.family !== 6) ||
          isIP(entry.address) !== entry.family ||
          (!isPublicInternetAddress(entry.address) && !this.options.allowPrivateTestEndpoints),
      )
    ) {
      throw new OwnTracksEndpointRejectedError();
    }
    const unique = new Map<string, ResolvedAddress>();
    for (const address of addresses) unique.set(`${address.family}:${address.address}`, address);
    return Object.freeze({ url, addresses: Object.freeze([...unique.values()]) });
  }

  public redirectLocation(
    current: URL,
    location: string | undefined,
    allowedPorts: readonly number[],
  ): URL {
    if (!location || location.length > 4096) throw new OwnTracksRedirectError();
    let target: URL;
    try {
      target = parseEndpoint(new URL(location, current).toString(), allowedPorts);
    } catch {
      throw new OwnTracksRedirectError();
    }
    if (target.origin !== current.origin) throw new OwnTracksRedirectError();
    return target;
  }
}
