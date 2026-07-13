import { z } from 'zod';
import {
  MacReleaseArtifactSchema,
  CliReleaseArtifactSchema,
  type PublicReleaseConfiguration,
} from '@botmem-v2/contracts';

const rawConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(12_412),
  DATABASE_URL: z.string().trim().min(1),
  PUBLIC_BASE_URL: z.string().trim().min(1),
  PUBLIC_WEB_URL: z.string().trim().min(1),
  AUTH_TOKEN_PEPPER: z.string().trim().min(1),
  RESEND_API_KEY: z.string().trim().min(1).optional(),
  LOGIN_EMAIL_FROM: z.string().trim().min(3).optional(),
  TRUSTED_ORIGINS: z.string().default(''),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_678_400).default(604_800),
  PAT_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(31_622_400).default(7_776_000),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  BOTMEM_MAC_DMG_URL: z.string().trim().min(1).optional(),
  BOTMEM_MAC_DMG_VERSION: z.string().trim().min(1).optional(),
  BOTMEM_MAC_DMG_SHA256: z.string().trim().min(1).optional(),
  BOTMEM_CLI_TGZ_URL: z.string().trim().min(1).optional(),
  BOTMEM_CLI_TGZ_VERSION: z.string().trim().min(1).optional(),
  BOTMEM_CLI_TGZ_SHA256: z.string().trim().min(1).optional(),
});

export interface RuntimeConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly publicBaseUrl: string;
  readonly publicWebBaseUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly tokenPepper: Uint8Array;
  readonly sessionCookieName: string;
  readonly secureCookies: boolean;
  readonly sessionTtlMs: number;
  readonly patMaxTtlMs: number;
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly publicReleases: PublicReleaseConfiguration;
  readonly resendLogin?: {
    readonly apiKey: string;
    readonly from: string;
  };
}

export function parseRuntimeConfig(environment: Record<string, string | undefined>): RuntimeConfig {
  const raw = rawConfigSchema.parse(defined(environment));
  const publicBase = origin(raw.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL');
  const publicWeb = origin(raw.PUBLIC_WEB_URL, 'PUBLIC_WEB_URL');
  const production = raw.NODE_ENV === 'production';
  if (production && publicBase.protocol !== 'https:') {
    throw new RuntimeConfigError('PUBLIC_BASE_URL must use HTTPS in production');
  }
  if (production && publicWeb.protocol !== 'https:') {
    throw new RuntimeConfigError('PUBLIC_WEB_URL must use HTTPS in production');
  }
  const database = url(raw.DATABASE_URL, 'DATABASE_URL');
  if (database.protocol !== 'postgres:' && database.protocol !== 'postgresql:') {
    throw new RuntimeConfigError('DATABASE_URL must use postgres or postgresql');
  }
  if (production && database.hostname === 'localhost') {
    throw new RuntimeConfigError('production DATABASE_URL cannot target localhost');
  }
  const sslMode = database.searchParams.get('sslmode');
  if (production && !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) {
    throw new RuntimeConfigError('production DATABASE_URL must require TLS with sslmode');
  }
  const pepper = decodePepper(raw.AUTH_TOKEN_PEPPER);
  if (Boolean(raw.RESEND_API_KEY) !== Boolean(raw.LOGIN_EMAIL_FROM)) {
    throw new RuntimeConfigError('RESEND_API_KEY and LOGIN_EMAIL_FROM must be configured together');
  }
  const trustedOrigins = uniqueOrigins(raw.TRUSTED_ORIGINS, publicBase.origin, publicWeb.origin);
  if (production && trustedOrigins.some((trusted) => !trusted.startsWith('https://'))) {
    throw new RuntimeConfigError('TRUSTED_ORIGINS must use HTTPS in production');
  }
  const publicReleases = Object.freeze({
    version: 2 as const,
    apiBaseUrl: `${publicBase.origin}/`,
    macos: releaseArtifact(
      'BOTMEM_MAC_DMG',
      raw.BOTMEM_MAC_DMG_URL,
      raw.BOTMEM_MAC_DMG_VERSION,
      raw.BOTMEM_MAC_DMG_SHA256,
      MacReleaseArtifactSchema,
    ),
    cli: releaseArtifact(
      'BOTMEM_CLI_TGZ',
      raw.BOTMEM_CLI_TGZ_URL,
      raw.BOTMEM_CLI_TGZ_VERSION,
      raw.BOTMEM_CLI_TGZ_SHA256,
      CliReleaseArtifactSchema,
    ),
  });
  return Object.freeze({
    environment: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    databaseUrl: raw.DATABASE_URL,
    publicBaseUrl: publicBase.origin,
    publicWebBaseUrl: publicWeb.origin,
    trustedOrigins,
    tokenPepper: pepper,
    sessionCookieName: production ? '__Host-botmem_session' : 'botmem_session',
    secureCookies: production || publicBase.protocol === 'https:',
    sessionTtlMs: raw.SESSION_TTL_SECONDS * 1_000,
    patMaxTtlMs: raw.PAT_MAX_TTL_SECONDS * 1_000,
    databasePoolMax: raw.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: raw.DATABASE_CONNECT_TIMEOUT_MS,
    publicReleases,
    ...(raw.RESEND_API_KEY && raw.LOGIN_EMAIL_FROM
      ? { resendLogin: { apiKey: raw.RESEND_API_KEY, from: raw.LOGIN_EMAIL_FROM } }
      : {}),
  });
}

function releaseArtifact<T>(
  field: string,
  releaseUrl: string | undefined,
  releaseVersion: string | undefined,
  sha256: string | undefined,
  schema: z.ZodType<T>,
): T {
  const configured = [releaseUrl, releaseVersion, sha256].filter(Boolean).length;
  if (configured === 0) return schema.parse({ available: false });
  if (configured !== 3) {
    throw new RuntimeConfigError(
      `${field}_URL, ${field}_VERSION, and ${field}_SHA256 must be configured together`,
    );
  }
  const parsed = schema.safeParse({
    available: true,
    url: releaseUrl,
    releaseVersion,
    sha256,
  });
  if (!parsed.success) {
    throw new RuntimeConfigError(`${field} release metadata is invalid or mutable`);
  }
  return parsed.data;
}

export class RuntimeConfigError extends Error {
  override readonly name = 'RuntimeConfigError';
}

function defined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function origin(value: string, field: string): URL {
  const parsed = url(value, field);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RuntimeConfigError(`${field} must be an HTTP(S) origin without credentials or path`);
  }
  return parsed;
}

function url(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    // URL parser errors retain the original input, which may contain a database
    // password. Collapse them into a field-only startup error before logging.
    throw new RuntimeConfigError(`${field} must be a valid URL`);
  }
}

function uniqueOrigins(value: string, ...requiredOrigins: readonly string[]): readonly string[] {
  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => origin(entry, 'TRUSTED_ORIGINS').origin);
  return Object.freeze([...new Set([...requiredOrigins, ...values])]);
}

function decodePepper(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new RuntimeConfigError('AUTH_TOKEN_PEPPER must be 32 bytes encoded as base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 32) {
    throw new RuntimeConfigError('AUTH_TOKEN_PEPPER must decode to exactly 32 bytes');
  }
  return new Uint8Array(bytes);
}
