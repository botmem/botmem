import type { CorsOptions, CorsOptionsDelegate } from 'cors';
import type { Request } from 'express';

function parseOrigins(frontendUrl: string): string[] {
  return frontendUrl
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function canonicalMcpOrigins(): string[] {
  return ['https://botmem.xyz', 'https://api.botmem.xyz'];
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isMcpCorsPath(path: string): boolean {
  return (
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/.well-known' ||
    path.startsWith('/.well-known/')
  );
}

export function isCorsOriginAllowed(params: {
  frontendUrl: string;
  origin?: string;
  path?: string;
  nodeEnv?: string;
}): boolean {
  const { frontendUrl, origin, path = '', nodeEnv = process.env.NODE_ENV } = params;
  if (!origin || origin === 'null') return true;

  const allowed = parseOrigins(frontendUrl);
  if (allowed.includes(origin)) return true;

  if (isMcpCorsPath(path)) {
    if (canonicalMcpOrigins().includes(origin)) return true;
    if (nodeEnv !== 'production' && isLocalhostOrigin(origin)) return true;
  }

  return false;
}

export function createCorsOriginChecker(frontendUrl: string) {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (isCorsOriginAllowed({ frontendUrl, origin })) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  };
}

export function createCorsOptionsDelegate(frontendUrl: string): CorsOptionsDelegate<Request> {
  return (req, callback) => {
    const origin = req.headers.origin;
    const allowed = isCorsOriginAllowed({
      frontendUrl,
      origin,
      path: req.path || req.originalUrl || req.url,
    });

    const options: CorsOptions = {
      origin: allowed,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    };

    callback(null, options);
  };
}
