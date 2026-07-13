#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number.parseInt(process.env['BOTMEM_WEB_FIXTURE_PORT'] ?? '4174', 10);
const host = process.env['BOTMEM_WEB_FIXTURE_HOST'] ?? '127.0.0.1';
const dist = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('BOTMEM_WEB_FIXTURE_PORT must be a valid TCP port');
}
if (host !== '127.0.0.1') {
  throw new Error('The render-only API fixture may bind only to 127.0.0.1');
}
if (!existsSync(resolve(dist, 'index.html'))) {
  throw new Error('apps/web/dist is missing; run pnpm --filter @botmem-v2/web build first');
}

const WORKSPACE_ID = '81000000-0000-4000-8000-000000000001';
const GMAIL_ACCOUNT_ID = '81000000-0000-4000-8000-000000000002';
const OUTLOOK_ACCOUNT_ID = '81000000-0000-4000-8000-000000000003';
const OWNTRACKS_ACCOUNT_ID = '81000000-0000-4000-8000-000000000004';
const DEVICE_ID = '81000000-0000-4000-8000-000000000005';
const TOKEN_ID = '81000000-0000-4000-8000-000000000006';
const EXPORT_ID = '81000000-0000-4000-8000-000000000007';
const NOW = '2026-07-13T12:00:00.000Z';
const EXPIRES = '2026-08-12T12:00:00.000Z';

const ready = (connector, indexedCount, detail) => ({
  connector,
  readiness: 'ready',
  ...(detail ? { detail } : {}),
  searchable: true,
  indexedCount,
  checkpointAt: '2026-07-13T11:59:00.000Z',
  lastProbeAt: NOW,
});

const fixtureState = {
  connections: [
    {
      id: GMAIL_ACCOUNT_ID,
      connector: 'gmail',
      authType: 'oauth2',
      label: 'owner@example.test',
      state: 'ready',
      source: ready('gmail', 48_200),
      lastSyncAt: NOW,
    },
    {
      id: OUTLOOK_ACCOUNT_ID,
      connector: 'outlook',
      authType: 'oauth2',
      label: 'owner@work.example',
      state: 'syncing',
      source: {
        connector: 'outlook',
        readiness: 'indexing',
        searchable: false,
        indexedCount: 8_420,
        checkpointAt: '2026-07-13T11:45:00.000Z',
      },
      lastSyncAt: '2026-07-13T11:45:00.000Z',
    },
    {
      id: OWNTRACKS_ACCOUNT_ID,
      connector: 'owntracks',
      authType: 'basic',
      label: 'OwnTracks recorder',
      state: 'ready',
      source: ready('owntracks', 12_044),
      lastSyncAt: NOW,
    },
  ],
  device: {
    deviceId: DEVICE_ID,
    displayName: 'Amr’s MacBook Pro',
    state: 'online',
    connectors: ['imessage', 'whatsapp'],
    clientVersion: '2.0.0',
    lastSeenAt: NOW,
    sources: [
      ready('imessage', 31_712, 'ready'),
      {
        connector: 'whatsapp',
        readiness: 'locked',
        detail: 'permission_required',
        searchable: false,
        reasonCode: 'full_disk_access_required',
        lastProbeAt: NOW,
      },
    ],
  },
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  const method = request.method ?? 'GET';

  try {
    if (url.pathname === '/__fixture__/health') return json(response, 200, { status: 'ok' });
    if (url.pathname === '/__fixture__/login') {
      response.writeHead(302, {
        location: '/',
        'set-cookie': 'botmem-render-session=login; Path=/; HttpOnly; SameSite=Strict',
      });
      return response.end();
    }
    if (url.pathname === '/__fixture__/authenticated') {
      response.writeHead(302, {
        location: '/',
        'set-cookie': 'botmem-render-session=authenticated; Path=/; HttpOnly; SameSite=Strict',
      });
      return response.end();
    }

    if (url.pathname.startsWith('/v2/')) {
      return await api(request, response, url, method);
    }
    return staticAsset(response, url.pathname);
  } catch (error) {
    process.stderr.write(`[web-render-fixture] ${method} ${url.pathname}: ${String(error)}\n`);
    return json(response, 500, { error: { message: 'Render fixture failed closed.' } });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Botmem web render fixture: http://${host}:${port}\n`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());

async function api(request, response, url, method) {
  const path = url.pathname;
  const authenticated = !String(request.headers.cookie ?? '').includes('botmem-render-session=login');

  if (method === 'GET' && path === '/v2/session') {
    return authenticated
      ? json(response, 200, { version: 2, workspaceId: WORKSPACE_ID })
      : json(response, 401, { error: { message: 'Authentication required' } });
  }
  if (method === 'DELETE' && path === '/v2/session') return empty(response, 204);
  if (method === 'POST' && path === '/v2/auth/email/start') {
    return json(response, 202, {
      version: 2,
      status: 'accepted',
      message: 'If the account exists, a sign-in link has been sent',
    });
  }
  if (method === 'POST' && path === '/v2/auth/email/complete') return empty(response, 204);
  if (method === 'GET' && path === '/v2/public/releases') {
    return json(response, 200, {
      version: 2,
      apiBaseUrl: `http://${host}:${port}/`,
      macos: {
        available: true,
        url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.0.0/Botmem-v2.0.0.dmg',
        releaseVersion: '2.0.0',
        sha256: 'a'.repeat(64),
      },
      cli: {
        available: true,
        url: 'https://github.com/botmem/botmem/releases/download/botmem-v2-v2.0.0/botmem-v2.0.0.tgz',
        releaseVersion: '2.0.0',
        sha256: 'b'.repeat(64),
      },
    });
  }
  if (method === 'GET' && path === '/v2/billing/price') {
    return json(response, 200, {
      version: 2,
      currency: 'usd',
      unitAmountMinor: 1_900,
      interval: 'month',
      intervalCount: 1,
      checkoutAvailable: false,
      unavailableReason: 'legal_review_pending',
    });
  }
  if (method === 'POST' && path === '/v2/billing/checkout') {
    return json(response, 409, { error: { code: 'checkout_unavailable', message: 'Checkout is unavailable.' } });
  }
  if (method === 'POST' && path === '/v2/billing/checkout/status') {
    return json(response, 200, { version: 2, status: 'active', workspaceId: WORKSPACE_ID });
  }

  const workspacePrefix = `/v2/workspaces/${WORKSPACE_ID}`;
  if (method === 'GET' && path === `${workspacePrefix}/sources`) {
    return json(response, 200, [
      fixtureState.connections[0].source,
      fixtureState.connections[1].source,
      fixtureState.connections[2].source,
      ...fixtureState.device.sources,
    ]);
  }
  if (method === 'POST' && path === `${workspacePrefix}/search`) {
    const body = await requestBody(request);
    return json(response, 200, searchResponse(String(body?.query ?? '')));
  }
  if (method === 'GET' && path === `${workspacePrefix}/connections`) {
    return json(response, 200, { version: 2, items: fixtureState.connections });
  }
  if (method === 'POST' && path === `${workspacePrefix}/connections/oauth`) {
    const body = await requestBody(request);
    const connector = body?.connector === 'outlook' ? 'outlook' : 'gmail';
    return json(response, 200, {
      version: 2,
      connector,
      accountId: connector === 'gmail' ? GMAIL_ACCOUNT_ID : OUTLOOK_ACCOUNT_ID,
      authorizationUrl: `https://accounts.example.test/oauth/${connector}`,
      expiresAt: EXPIRES,
    });
  }
  if (method === 'POST' && path === `${workspacePrefix}/connections/owntracks`) {
    return json(response, 200, { version: 2, connection: fixtureState.connections[2] });
  }
  if (method === 'POST' && /^\/v2\/workspaces\/[^/]+\/connections\/[^/]+\/actions$/u.test(path)) {
    return json(response, 200, { version: 2, connection: fixtureState.connections[0] });
  }
  if (method === 'GET' && path === `${workspacePrefix}/devices`) {
    return json(response, 200, { version: 2, items: [fixtureState.device] });
  }
  if (method === 'POST' && path === `${workspacePrefix}/devices/pairing-codes`) {
    return json(response, 201, { code: 'BM2-abcdefghijklmnopqrstuvwx', expiresAt: EXPIRES });
  }
  if (method === 'GET' && path === `${workspacePrefix}/billing`) {
    return json(response, 200, {
      version: 2,
      workspaceId: WORKSPACE_ID,
      subscriptionStatus: 'active',
      entitled: true,
      currentPeriodEnd: EXPIRES,
    });
  }
  if (method === 'POST' && path === `${workspacePrefix}/billing/portal`) {
    return json(response, 201, {
      version: 2,
      portalUrl: 'https://billing.stripe.com/p/session/render_fixture',
    });
  }
  if (method === 'GET' && path === `${workspacePrefix}/pats`) {
    return json(response, 200, {
      version: 2,
      items: [{
        version: 2,
        credentialId: TOKEN_ID,
        label: 'Codex release gate',
        tokenPrefix: 'bmp_v2.render',
        scopes: ['botmem:search', 'botmem:connections:read', 'botmem:devices:read'],
        createdAt: NOW,
        expiresAt: EXPIRES,
        lastUsedAt: NOW,
      }],
    });
  }
  if (method === 'POST' && path === `${workspacePrefix}/pats`) {
    return json(response, 201, {
      version: 2,
      credentialId: TOKEN_ID,
      accessToken: `bmp_v2.${'A'.repeat(43)}`,
      expiresAt: EXPIRES,
    });
  }
  if (method === 'DELETE' && /^\/v2\/workspaces\/[^/]+\/pats\/[^/]+$/u.test(path)) {
    return empty(response, 204);
  }
  if (method === 'GET' && path === `${workspacePrefix}/lifecycle/jobs`) {
    return json(response, 200, { version: 2, items: [exportJob()] });
  }
  if (method === 'POST' && path === `${workspacePrefix}/lifecycle/exports`) {
    return json(response, 202, { version: 2, job: exportJob() });
  }
  if (method === 'POST' && path === `${workspacePrefix}/lifecycle/deletion`) {
    return json(response, 202, {
      version: 2,
      job: {
        version: 2,
        jobId: '81000000-0000-4000-8000-000000000008',
        kind: 'deletion',
        state: 'queued',
        requestedAt: NOW,
        attempts: 0,
        availableUntil: null,
        completedAt: null,
        failureCode: null,
        localDelete: { delivered: 0, unreachable: 0, pending: 1 },
      },
    });
  }
  if (method === 'GET' && path === `${workspacePrefix}/lifecycle/exports/${EXPORT_ID}/download`) {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson',
    });
    return response.end('{"fixture":true}\n');
  }
  return json(response, 404, { error: { message: `No fixture for ${method} ${path}` } });
}

function searchResponse(query) {
  const partial = query.toLowerCase().includes('partial');
  const hosted = {
    ref: 'gmail:render-fixture',
    sourceId: 'render-fixture',
    revision: '1',
    origin: { placement: 'hosted', connector: 'gmail', accountId: GMAIL_ACCOUNT_ID },
    kind: 'email',
    occurredAt: '2026-07-13T10:30:00.000Z',
    title: 'Production launch decision',
    text: `Hosted evidence matching “${query}” with explicit provenance.`,
    participants: [],
    media: [],
    citation: 'botmem://memory/gmail:render-fixture',
    ranking: { rank: 1, score: 0.92, matchedLanes: ['hosted'] },
  };
  const local = {
    ref: 'imessage:render-fixture',
    sourceId: 'render-fixture',
    revision: '1',
    origin: { placement: 'device', connector: 'imessage', deviceId: DEVICE_ID },
    kind: 'message',
    occurredAt: '2026-07-13T09:45:00.000Z',
    title: 'Thread from the Mac',
    text: `On-device evidence matching “${query}”; only this bounded result crossed the relay.`,
    participants: [],
    media: [],
    citation: 'botmem://memory/imessage:render-fixture',
    ranking: { rank: 2, score: 0.81, matchedLanes: [`device:${DEVICE_ID}`] },
  };
  return {
    version: 2,
    queryId: '81000000-0000-4000-8000-000000000009',
    items: partial ? [hosted] : [hosted, local],
    coverage: {
      partial,
      lanes: [
        { laneId: 'hosted', placement: 'hosted', status: 'complete', retryable: false, returned: 1, tookMs: 18 },
        partial
          ? {
              laneId: `device:${DEVICE_ID}`,
              placement: 'device',
              deviceId: DEVICE_ID,
              status: 'offline',
              retryable: true,
              returned: 0,
              tookMs: 0,
              reasonCode: 'device_disconnected',
            }
          : {
              laneId: `device:${DEVICE_ID}`,
              placement: 'device',
              deviceId: DEVICE_ID,
              status: 'complete',
              retryable: false,
              returned: 1,
              tookMs: 31,
            },
      ],
    },
    found: partial ? 1 : 2,
    tookMs: partial ? 21 : 37,
  };
}

function exportJob() {
  return {
    version: 2,
    jobId: EXPORT_ID,
    kind: 'export',
    state: 'ready',
    requestedAt: NOW,
    attempts: 1,
    availableUntil: EXPIRES,
    completedAt: NOW,
    failureCode: null,
    localDelete: null,
  };
}

async function requestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
}

function staticAsset(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let candidate = resolve(dist, relative);
  if (!candidate.startsWith(`${resolve(dist)}${sep}`) && candidate !== resolve(dist)) {
    return json(response, 404, { error: { message: 'Not found' } });
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = resolve(dist, 'index.html');
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType(candidate),
    'x-content-type-options': 'nosniff',
  });
  return createReadStream(candidate).pipe(response);
}

function contentType(path) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  })[extname(path)] ?? 'application/octet-stream';
}

function json(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function empty(response, status) {
  response.writeHead(status, { 'cache-control': 'no-store' });
  response.end();
}
