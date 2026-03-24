/**
 * MCP OAuth 2.1 PKCE e2e tests (MCP-014 → MCP-025)
 *
 * Tests the full OAuth 2.1 flow used by MCP clients:
 * client registration, authorization, PKCE validation,
 * token exchange, refresh, revocation, and error cases.
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

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('MCP OAuth 2.1 PKCE (MCP-014 → MCP-025)', () => {
  let user: TestUser;

  beforeAll(async () => {
    await ensureApiRunning();
    user = await registerUser();
  }, 60_000);

  afterAll(async () => {
    await closeApp();
  });

  // ── Discovery ────────────────────────────────────────────────────

  it('MCP-014: should serve OAuth authorization server metadata', async () => {
    const server = getHttpServer();
    const res = await supertest(server)
      .get('/.well-known/oauth-authorization-server')
      .expect(200);

    expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(res.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(res.body.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
    expect(res.body.response_types_supported).toContain('code');
    expect(res.body.grant_types_supported).toContain('authorization_code');
    expect(res.body.grant_types_supported).toContain('refresh_token');
    expect(res.body.code_challenge_methods_supported).toContain('S256');
  });

  it('MCP-015: should serve protected resource metadata', async () => {
    const server = getHttpServer();
    const res = await supertest(server)
      .get('/.well-known/oauth-protected-resource')
      .expect(200);

    expect(res.body.resource).toMatch(/\/mcp$/);
    expect(res.body.authorization_servers).toBeInstanceOf(Array);
    expect(res.body.authorization_servers.length).toBeGreaterThan(0);
    expect(res.body.bearer_methods_supported).toContain('header');
  });

  // ── Client Registration ──────────────────────────────────────────

  it('MCP-016: should register a new OAuth client', async () => {
    const server = getHttpServer();
    const res = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'test-mcp-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    expect(res.body.client_id).toBeDefined();
    expect(res.body.client_name).toBe('test-mcp-client');
    expect(res.body.redirect_uris).toContain('http://localhost:9999/callback');
    expect(res.body.grant_types).toContain('authorization_code');
    expect(res.body.grant_types).toContain('refresh_token');
  });

  it('MCP-017: should reject client registration without required fields', async () => {
    const server = getHttpServer();

    await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({ client_name: 'incomplete' })
      .expect(400);

    await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({ redirect_uris: ['http://localhost:9999/cb'] })
      .expect(400);
  });

  it('MCP-018: should return client info for registered client', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'info-test-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const infoRes = await supertest(server)
      .get(`/oauth/client-info?client_id=${regRes.body.client_id}`)
      .expect(200);

    expect(infoRes.body.client_id).toBe(regRes.body.client_id);
    expect(infoRes.body.client_name).toBe('info-test-client');
  });

  // ── Authorization Flow ───────────────────────────────────────────

  it('MCP-019: GET /oauth/authorize should redirect to consent page with PKCE params', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'auth-flow-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const { codeChallenge } = generatePKCE();

    const res = await supertest(server)
      .get('/oauth/authorize')
      .query({
        client_id: regRes.body.client_id,
        redirect_uri: 'http://localhost:9999/callback',
        response_type: 'code',
        scope: 'read write',
        state: 'test-state-123',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      .expect(302);

    const location = res.headers.location;
    expect(location).toMatch(/\/oauth\/consent/);
    expect(location).toContain('client_id=');
    expect(location).toContain('code_challenge=');
    expect(location).toContain('state=test-state-123');
  });

  it('MCP-020: should reject authorize without PKCE', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'no-pkce-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    await supertest(server)
      .get('/oauth/authorize')
      .query({
        client_id: regRes.body.client_id,
        redirect_uri: 'http://localhost:9999/callback',
        response_type: 'code',
        scope: 'read write',
      })
      .expect(400);
  });

  it('MCP-021: should complete full PKCE authorization code flow', async () => {
    const server = getHttpServer();

    // 1. Register client
    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'full-flow-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const { codeVerifier, codeChallenge } = generatePKCE();

    // 2. Complete authorization (user approves)
    const authRes = await supertest(server)
      .post('/oauth/authorize/complete')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        clientId,
        scope: 'read write',
        state: 'full-flow-state',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9999/callback',
        recoveryKey: user.recoveryKey,
      })
      .expect(201);

    expect(authRes.body.redirect_uri).toBeDefined();
    const redirectUrl = new URL(authRes.body.redirect_uri);
    expect(redirectUrl.searchParams.get('code')).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe('full-flow-state');

    const code = redirectUrl.searchParams.get('code')!;

    // 3. Exchange code for tokens
    const tokenRes = await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(201);

    expect(tokenRes.body.access_token).toBeTruthy();
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.expires_in).toBe(3600);
    expect(tokenRes.body.refresh_token).toBeTruthy();
    expect(tokenRes.body.scope).toBe('read write');
  });

  it('MCP-022: should reject token exchange with wrong code_verifier', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'wrong-verifier-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const { codeChallenge } = generatePKCE();
    const wrongVerifier = randomBytes(32).toString('base64url');

    const authRes = await supertest(server)
      .post('/oauth/authorize/complete')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        clientId,
        scope: 'read write',
        state: 'wrong-verifier',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9999/callback',
        recoveryKey: user.recoveryKey,
      })
      .expect(201);

    const code = new URL(authRes.body.redirect_uri).searchParams.get('code')!;

    await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: wrongVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(400);
  });

  it('MCP-023: should reject reuse of authorization code', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'code-reuse-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const { codeVerifier, codeChallenge } = generatePKCE();

    const authRes = await supertest(server)
      .post('/oauth/authorize/complete')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        clientId,
        scope: 'read write',
        state: 'code-reuse',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9999/callback',
        recoveryKey: user.recoveryKey,
      })
      .expect(201);

    const code = new URL(authRes.body.redirect_uri).searchParams.get('code')!;

    // First use: success
    await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(201);

    // Second use: should fail
    await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(400);
  });

  // ── Refresh Token ────────────────────────────────────────────────

  it('MCP-024: should refresh access token using refresh_token grant', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'refresh-test-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const { codeVerifier, codeChallenge } = generatePKCE();

    const authRes = await supertest(server)
      .post('/oauth/authorize/complete')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        clientId,
        scope: 'read write',
        state: 'refresh-test',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9999/callback',
        recoveryKey: user.recoveryKey,
      })
      .expect(201);

    const code = new URL(authRes.body.redirect_uri).searchParams.get('code')!;

    const tokenRes = await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(201);

    const refreshToken = tokenRes.body.refresh_token;

    // Refresh
    const refreshRes = await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })
      .expect(201);

    expect(refreshRes.body.access_token).toBeTruthy();
    expect(refreshRes.body.refresh_token).toBeTruthy();
    // New refresh token should be different (rotation)
    expect(refreshRes.body.refresh_token).not.toBe(refreshToken);

    // Old refresh token should be revoked
    await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })
      .expect(401);
  });

  // ── Token Revocation ─────────────────────────────────────────────

  it('MCP-025: should revoke a refresh token', async () => {
    const server = getHttpServer();

    const regRes = await supertest(server)
      .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        client_name: 'revoke-test-client',
        redirect_uris: ['http://localhost:9999/callback'],
      })
      .expect(201);

    const clientId = regRes.body.client_id;
    const { codeVerifier, codeChallenge } = generatePKCE();

    const authRes = await supertest(server)
      .post('/oauth/authorize/complete')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        clientId,
        scope: 'read write',
        state: 'revoke-test',
        codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:9999/callback',
        recoveryKey: user.recoveryKey,
      })
      .expect(201);

    const code = new URL(authRes.body.redirect_uri).searchParams.get('code')!;

    const tokenRes = await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost:9999/callback',
        client_id: clientId,
      })
      .expect(201);

    const refreshToken = tokenRes.body.refresh_token;

    // Revoke
    await supertest(server)
      .post('/oauth/revoke')
      .send({ token: refreshToken })
      .expect(201);

    // Revoked token should not work
    await supertest(server)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })
      .expect(401);
  });

  // ── MCP Auth Integration ─────────────────────────────────────────

  describe('MCP Auth Guard', () => {
    it('MCP-014b: should return 401 with resource_metadata hint when no token', async () => {
      const server = getHttpServer();
      const res = await supertest(server)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        })
        .expect(401);

      expect(res.body.error).toBe('unauthorized');
      expect(res.headers['www-authenticate']).toMatch(/Bearer/);
      expect(res.headers['www-authenticate']).toMatch(/resource_metadata/);
    });

    it('MCP-014c: should reject API keys (bm_sk_) for MCP endpoints', async () => {
      const server = getHttpServer();
      const res = await supertest(server)
        .post('/mcp')
        .set('Authorization', 'Bearer bm_sk_fakekeyvalue12345678')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        })
        .expect(401);

      expect(res.body.error).toBe('unauthorized');
    });

    it('MCP-014d: should reject invalid/expired JWT tokens', async () => {
      const server = getHttpServer();
      const res = await supertest(server)
        .post('/mcp')
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.invalid')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        })
        .expect(401);

      expect(res.body.error).toBe('unauthorized');
    });

    it('MCP-014e: should accept valid OAuth token and create MCP session', async () => {
      const server = getHttpServer();

      // Get a proper OAuth token
      const regRes = await supertest(server)
        .post('/oauth/register').set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          client_name: 'guard-test-client',
          redirect_uris: ['http://localhost:9999/callback'],
        })
        .expect(201);

      const clientId = regRes.body.client_id;
      const { codeVerifier, codeChallenge } = generatePKCE();

      const authRes = await supertest(server)
        .post('/oauth/authorize/complete')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({
          clientId,
          scope: 'read write',
          state: 'guard-test',
          codeChallenge,
          codeChallengeMethod: 'S256',
          redirectUri: 'http://localhost:9999/callback',
          recoveryKey: user.recoveryKey,
        })
        .expect(201);

      const code = new URL(authRes.body.redirect_uri).searchParams.get('code')!;

      const tokenRes = await supertest(server)
        .post('/oauth/token')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: 'http://localhost:9999/callback',
          client_id: clientId,
        })
        .expect(201);

      // Use the OAuth token for MCP — need custom SSE parser since response is text/event-stream
      const sseParser = (res: any, cb: (err: any, body: any) => void) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => cb(null, data));
      };

      const mcpRes = await supertest(server)
        .post('/mcp')
        .set('Authorization', `Bearer ${tokenRes.body.access_token}`)
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .buffer(true)
        .parse(sseParser)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'guard-test', version: '1.0.0' },
          },
        })
        .expect(200);

      expect(mcpRes.headers['mcp-session-id']).toBeDefined();
      // Response is SSE — parse data: line
      const sseText = typeof mcpRes.body === 'string' ? mcpRes.body : '';
      const dataLine = sseText.split('\n').find((l: string) => l.startsWith('data:'));
      const jsonRpc = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
      expect(jsonRpc).toBeDefined();
      expect(jsonRpc.result.serverInfo.name).toBe('Botmem');
    });
  });
});
