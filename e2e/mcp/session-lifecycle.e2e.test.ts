/**
 * MCP Session Lifecycle e2e tests (MCP-001 → MCP-004)
 *
 * Tests MCP session creation, reuse, termination, and expiry behavior.
 *
 * The MCP SDK uses StreamableHTTPServerTransport which requires:
 * - Accept: application/json, text/event-stream (for POST requests)
 * - Responses for JSON-RPC requests come as SSE (text/event-stream)
 * - Responses for notifications come as 202
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { ensureApiRunning,

  closeApp,
  getHttpServer,
  registerUser,
  type TestUser,
} from '../helpers/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

const MCP_ACCEPT = 'application/json, text/event-stream';

/** Parse SSE response text to extract JSON-RPC payload from data: lines. */
function parseSseJsonRpc(text: string): any {
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* next */ }
    }
  }
  return null;
}

/**
 * Custom supertest parser that buffers SSE (text/event-stream) as raw text.
 * Without this, supertest's default parser may hang on chunked SSE responses.
 */
function sseParser(res: any, cb: (err: any, body: any) => void) {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => { data += chunk; });
  res.on('end', () => cb(null, data));
}

/** Register an OAuth client and get an MCP access token for the user. */
async function getOAuthToken(user: TestUser): Promise<string> {
  const server = getHttpServer();

  // 1. Register OAuth client (requires auth)
  const regRes = await supertest(server)
    .post('/oauth/register')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({
      client_name: 'mcp-e2e-test',
      redirect_uris: ['http://localhost:12345/callback'],
    })
    .expect(201);

  const clientId = regRes.body.client_id;

  // 2. Generate PKCE pair
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // 3. Complete authorization (skip consent redirect, use direct endpoint)
  const authRes = await supertest(server)
    .post('/oauth/authorize/complete')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({
      clientId,
      scope: 'read write',
      state: 'test-state',
      codeChallenge,
      codeChallengeMethod: 'S256',
      redirectUri: 'http://localhost:12345/callback',
      recoveryKey: user.recoveryKey,
    })
    .expect(201);

  const redirectUrl = new URL(authRes.body.redirect_uri);
  const code = redirectUrl.searchParams.get('code')!;

  // 4. Exchange code for tokens
  const tokenRes = await supertest(server)
    .post('/oauth/token')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: 'http://localhost:12345/callback',
      client_id: clientId,
    })
    .expect(201);

  return tokenRes.body.access_token;
}

/** Send an MCP JSON-RPC POST request and return parsed SSE data. */
async function mcpPost(
  server: any,
  token: string,
  body: any,
  sessionId?: string,
): Promise<{ status: number; headers: Record<string, string>; jsonRpc: any }> {
  const req = supertest(server)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', MCP_ACCEPT)
    .buffer(true)
    .parse(sseParser);

  if (sessionId) {
    req.set('Mcp-Session-Id', sessionId);
  }

  const res = await req.send(body);
  const text = typeof res.body === 'string' ? res.body : '';
  const jsonRpc = parseSseJsonRpc(text);

  return { status: res.status, headers: res.headers, jsonRpc };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MCP Session Lifecycle (MCP-001 → MCP-004)', () => {
  let user: TestUser;
  let oauthToken: string;

  beforeAll(async () => {
    await ensureApiRunning();
    user = await registerUser();
    oauthToken = await getOAuthToken(user);
  }, 60_000);

  afterAll(async () => {
    await closeApp();
  });

  it('MCP-001: should create a new session via POST /mcp initialize', async () => {
    const server = getHttpServer();
    const { status, headers, jsonRpc } = await mcpPost(server, oauthToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    });

    expect(status).toBe(200);

    // Should return a session ID header
    const sessionId = headers['mcp-session-id'];
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    // Response should be valid JSON-RPC with server info
    expect(jsonRpc).toBeDefined();
    expect(jsonRpc.jsonrpc).toBe('2.0');
    expect(jsonRpc.id).toBe(1);
    expect(jsonRpc.result).toBeDefined();
    expect(jsonRpc.result.serverInfo).toBeDefined();
    expect(jsonRpc.result.serverInfo.name).toBe('Botmem');
  });

  it('MCP-002: should reuse an existing session with session ID header', async () => {
    const server = getHttpServer();

    // Create session
    const { status: initStatus, headers: initHeaders } = await mcpPost(server, oauthToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    });
    expect(initStatus).toBe(200);
    const sessionId = initHeaders['mcp-session-id'];
    expect(sessionId).toBeDefined();

    // Send initialized notification (no id = notification, gets 202)
    const notifRes = await supertest(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${oauthToken}`)
      .set('Mcp-Session-Id', sessionId)
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect([200, 202, 204]).toContain(notifRes.status);

    // List tools on the same session
    const { status: toolsStatus, jsonRpc: toolsJson } = await mcpPost(
      server, oauthToken,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sessionId,
    );

    expect(toolsStatus).toBe(200);
    expect(toolsJson).toBeDefined();
    expect(toolsJson.result).toBeDefined();
    expect(toolsJson.result.tools).toBeInstanceOf(Array);
    expect(toolsJson.result.tools.length).toBeGreaterThan(0);
  });

  it('MCP-003: should terminate a session via DELETE /mcp', async () => {
    const server = getHttpServer();

    // Create session
    const { headers: initHeaders } = await mcpPost(server, oauthToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    });
    const sessionId = initHeaders['mcp-session-id'];
    expect(sessionId).toBeDefined();

    // Terminate — DELETE goes through our controller which returns JSON directly
    const delRes = await supertest(server)
      .delete('/mcp')
      .set('Authorization', `Bearer ${oauthToken}`)
      .set('Mcp-Session-Id', sessionId);

    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // Subsequent request to terminated session should fail
    // SDK returns 404 for unknown sessions after transport.close()
    const afterRes = await supertest(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${oauthToken}`)
      .set('Mcp-Session-Id', sessionId)
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });

    expect([400, 404]).toContain(afterRes.status);
  });

  it('MCP-004: should reject requests with invalid/expired session ID', async () => {
    const server = getHttpServer();

    const res = await supertest(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${oauthToken}`)
      .set('Mcp-Session-Id', 'non-existent-session-id')
      .set('Content-Type', 'application/json')
      .set('Accept', MCP_ACCEPT)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

    // SDK returns 404 for sessions it doesn't know about
    expect([400, 404]).toContain(res.status);
  });
});
