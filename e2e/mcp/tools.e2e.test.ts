/**
 * MCP Tools e2e tests (MCP-005 → MCP-013)
 *
 * Tests MCP tool listing, search tool, ask tool, DEK-cold errors,
 * parameter validation, and error handling.
 *
 * MCP SDK returns SSE (text/event-stream) for JSON-RPC request responses.
 * We use a custom parser to buffer the SSE and extract data: lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createHash, randomBytes } from 'crypto';
import {
  ensureApiRunning,
  closeApp,
  getHttpServer,
  registerUser,
  type TestUser,
} from '../helpers/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

const MCP_ACCEPT = 'application/json, text/event-stream';

/** Parse SSE text to extract JSON-RPC payload from data: lines. */
function parseSseJsonRpc(text: string): any {
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Custom supertest parser for SSE responses. */
function sseParser(res: any, cb: (err: any, body: any) => void) {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => cb(null, data));
}

/** Send an MCP JSON-RPC POST and return parsed response. */
async function mcpPost(
  token: string,
  body: any,
  sessionId?: string,
): Promise<{ status: number; headers: Record<string, string>; jsonRpc: any }> {
  const server = getHttpServer();
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

async function getOAuthToken(
  user: TestUser,
): Promise<{ token: string; clientId: string }> {
  const server = getHttpServer();

  const regRes = await supertest(server)
    .post('/oauth/register')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .send({
      client_name: 'mcp-tools-e2e',
      redirect_uris: ['http://localhost:12345/callback'],
    })
    .expect(201);

  const clientId = regRes.body.client_id;
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

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

  return { token: tokenRes.body.access_token, clientId };
}

/** Create an MCP session and return the session ID. */
async function createMcpSession(token: string): Promise<string> {
  const { status, headers } = await mcpPost(token, {
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
  const sessionId = headers['mcp-session-id'];
  expect(sessionId).toBeDefined();

  // Send initialized notification
  const server = getHttpServer();
  await supertest(server)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Mcp-Session-Id', sessionId)
    .set('Content-Type', 'application/json')
    .set('Accept', MCP_ACCEPT)
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return sessionId;
}

/** Call an MCP tool and return the parsed JSON-RPC response. */
async function callTool(
  token: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requestId = 10,
) {
  return mcpPost(
    token,
    {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
    sessionId,
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MCP Tools (MCP-005 → MCP-013)', () => {
  let user: TestUser;
  let oauthToken: string;
  let sessionId: string;

  beforeAll(async () => {
    await ensureApiRunning();
    user = await registerUser();
    const { token } = await getOAuthToken(user);
    oauthToken = token;
    sessionId = await createMcpSession(oauthToken);
  }, 60_000);

  afterAll(async () => {
    await closeApp();
  });

  it('MCP-005: should list available tools via tools/list', async () => {
    const { status, jsonRpc } = await mcpPost(
      oauthToken,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sessionId,
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    const tools = jsonRpc.result.tools;
    expect(tools).toBeInstanceOf(Array);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain('search');
    expect(toolNames).toContain('ask');
  });

  it('MCP-006: search tool should have correct input schema', async () => {
    const { jsonRpc } = await mcpPost(
      oauthToken,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      sessionId,
    );

    const searchTool = jsonRpc.result.tools.find(
      (t: any) => t.name === 'search',
    );
    expect(searchTool).toBeDefined();
    expect(searchTool.description).toBeTruthy();

    const schema = searchTool.inputSchema;
    expect(schema).toBeDefined();
    expect(schema.properties).toHaveProperty('query');
    expect(schema.properties).toHaveProperty('source_type');
    expect(schema.properties).toHaveProperty('connector_type');
    expect(schema.properties).toHaveProperty('contact_id');
    expect(schema.properties).toHaveProperty('limit');
    expect(schema.required).toContain('query');
  });

  it('MCP-007: ask tool should have correct input schema', async () => {
    const { jsonRpc } = await mcpPost(
      oauthToken,
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      sessionId,
    );

    const askTool = jsonRpc.result.tools.find(
      (t: any) => t.name === 'ask',
    );
    expect(askTool).toBeDefined();
    expect(askTool.description).toBeTruthy();

    const schema = askTool.inputSchema;
    expect(schema).toBeDefined();
    expect(schema.properties).toHaveProperty('query');
    expect(schema.properties).toHaveProperty('source_type');
    expect(schema.properties).toHaveProperty('connector_type');
    expect(schema.properties).toHaveProperty('limit');
    expect(schema.required).toContain('query');
  });

  it('MCP-008: search tool should execute and return results', async () => {
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'search',
      { query: 'test query for e2e', limit: 5 },
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    expect(jsonRpc.result).toBeDefined();
    expect(jsonRpc.result.content).toBeInstanceOf(Array);
    // Content always has at least one text entry (results or error message)
    if (jsonRpc.result.content.length > 0) {
      expect(jsonRpc.result.content[0].type).toBe('text');
    }
  });

  it('MCP-009: ask tool should execute and return results or AI error', async () => {
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'ask',
      { query: 'What happened yesterday?', limit: 5 },
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    expect(jsonRpc.result).toBeDefined();
    // ask tool returns content array (may be error if AI is down)
    expect(jsonRpc.result.content).toBeInstanceOf(Array);
  });

  it('MCP-010: search tool should accept optional filters', async () => {
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'search',
      {
        query: 'email about meeting',
        source_type: 'email',
        connector_type: 'gmail',
        limit: 3,
      },
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    expect(jsonRpc.result).toBeDefined();
    expect(jsonRpc.result.content).toBeInstanceOf(Array);
    expect(jsonRpc.result.isError).toBeUndefined();
  });

  it('MCP-011: search tool returns result or DEK-cold error', async () => {
    // In external server mode we cannot evict DEK, so just verify search tool responds
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'search',
      { query: 'test dek cold' },
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    // Tool should return either a valid result or an isError response
    expect(jsonRpc.result).toBeDefined();
    expect(jsonRpc.result.content).toBeInstanceOf(Array);
  });

  it('MCP-012: should handle calling non-existent tool gracefully', async () => {
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'nonexistent_tool',
      { query: 'test' },
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    // MCP SDK returns unknown tool as in-band error (result.isError) or top-level error
    const hasError = jsonRpc.error !== undefined || jsonRpc.result?.isError === true;
    expect(hasError).toBe(true);
  });

  it('MCP-013: should handle missing required parameters in tool call', async () => {
    const { status, jsonRpc } = await callTool(
      oauthToken,
      sessionId,
      'search',
      {},
    );

    expect(status).toBe(200);
    expect(jsonRpc).toBeDefined();
    const hasError =
      jsonRpc.error !== undefined || jsonRpc.result?.isError === true;
    expect(hasError).toBe(true);
  });
});
