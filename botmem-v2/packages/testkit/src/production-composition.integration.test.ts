import {
  IdentityEmailLookupHasher,
  NodePostgresPoolAdapter,
  NodeTokenSecurity,
  PostgresCommerceRepository,
  PostgresIdentityProvisioner,
  PostgresRuntimeRoleValidator,
  commerceApiExtensionFactory,
  composeCommerceReconcilerWorker,
  composeHostedSyncWorker,
  composeProjectionWorker,
  createLifecycleWorkerRunner,
  lifecycleApiExtensionFactory,
  startProductionApiFromEnvironment,
} from '@botmem-v2/api';
import { GMAIL_OAUTH_SCOPE } from '../../../apps/api/src/connectors/gmail/index.js';
import { OUTLOOK_SCOPE } from '../../../apps/api/src/connectors/outlook/index.js';
import { authenticationMessage } from '../../../apps/api/src/devices/authentication-service.js';
import { BrowserBotmemClient, WebApiError } from '../../../apps/web/src/data-client.js';
import { parseSearchResponse, type SearchResponse } from '@botmem-v2/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { request as requestHttp } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import {
  createServer as createNetServer,
  connect as connectNet,
  type Server as NetServer,
} from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env['BOTMEM_V2_PRODUCTION_E2E'] === '1';
const ADMIN_DATABASE_URL = process.env['BOTMEM_E2E_ADMIN_DATABASE_URL'] ?? '';
const API_DATABASE_URL = process.env['BOTMEM_E2E_API_DATABASE_URL'] ?? '';
const WORKER_DATABASE_URL = process.env['BOTMEM_E2E_WORKER_DATABASE_URL'] ?? '';
const DISPATCHER_DATABASE_URL = process.env['BOTMEM_E2E_DISPATCHER_DATABASE_URL'] ?? '';
const COMMERCE_DATABASE_URL = process.env['BOTMEM_E2E_COMMERCE_DATABASE_URL'] ?? '';
const IDENTITY_DATABASE_URL = process.env['BOTMEM_E2E_IDENTITY_DATABASE_URL'] ?? '';
const LIFECYCLE_DATABASE_URL = process.env['BOTMEM_E2E_LIFECYCLE_DATABASE_URL'] ?? '';
const REDIS_URL = process.env['BOTMEM_E2E_REDIS_URL'] ?? '';
const TLS_CERT_PATH = process.env['BOTMEM_E2E_TLS_CERT_PATH'] ?? '';
const TLS_KEY_PATH = process.env['BOTMEM_E2E_TLS_KEY_PATH'] ?? '';
const TLS_CA_PATH = process.env['BOTMEM_E2E_TLS_CA_PATH'] ?? '';
const TUNNEL_BINARY = resolve(
  process.env['BOTMEM_TUNNEL_TEST_BINARY'] ?? 'target/debug/botmem-tunnel',
);
const SEED_BINARY = resolve(
  process.env['BOTMEM_PRODUCTION_E2E_SEED_BINARY'] ??
    'target/debug/examples/seed_production_e2e_index',
);
const CLI_BINARY = resolve(
  process.env['BOTMEM_PRODUCTION_E2E_CLI_BINARY'] ?? 'packages/cli/dist/bin.js',
);
const QUERY = 'production handoff nexus';
const HOSTED_SEMANTIC_QUERY = 'conceptual recollection';
const DEVICE_TYPO_QUERY = 'production handoff nexis';
const PRICE_ID = 'price_productione2e123456';
const STRIPE_WEBHOOK_SECRET = 'whsec_productione2e123456';
const CHECKOUT_SESSION_ID = 'cs_test_productione2eowner123456';
const STRIPE_CUSTOMER_ID = 'cus_productione2eowner123456';
const STRIPE_SUBSCRIPTION_ID = 'sub_productione2eowner123456';
const PEPPER = new Uint8Array(32).fill(91);
const PEPPER_TEXT = Buffer.from(PEPPER).toString('base64url');
const VAULT_KEY = `1:${Buffer.alloc(32, 73).toString('base64url')}`;
const execFileAsync = promisify(execFile);

interface WorkspaceFixture {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly email: string;
}

interface RunningHelper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

interface StripeFixture {
  signupId?: string;
  readonly sessionId: string;
  subscriptionCanceled?: boolean;
}

describe.runIf(enabled)('production composition end-to-end gate', () => {
  let workspace: WorkspaceFixture = {
    workspaceId: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    email: `owner-${crypto.randomUUID()}@example.test`,
  };
  const outsider: WorkspaceFixture = {
    workspaceId: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    email: `outsider-${crypto.randomUUID()}@example.test`,
  };
  const adminPool = new NodePostgresPoolAdapter({ connectionString: ADMIN_DATABASE_URL, max: 2 });
  const apiPool = new NodePostgresPoolAdapter({ connectionString: API_DATABASE_URL, max: 8 });
  const workerPool = new NodePostgresPoolAdapter({ connectionString: WORKER_DATABASE_URL, max: 8 });
  const commercePool = new NodePostgresPoolAdapter({
    connectionString: COMMERCE_DATABASE_URL,
    max: 4,
  });
  const identityPool = new NodePostgresPoolAdapter({
    connectionString: IDENTITY_DATABASE_URL,
    max: 4,
  });
  const lifecyclePool = new NodePostgresPoolAdapter({
    connectionString: LIFECYCLE_DATABASE_URL,
    max: 4,
  });
  const deliveredLoginTokens = new Map<string, string>();
  const providerRequests: string[] = [];
  const commerceEvents: string[] = [];
  const stripeFixture: StripeFixture = { sessionId: CHECKOUT_SESSION_ID };
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const providerFetch = createProviderFetch(
    nativeFetch,
    deliveredLoginTokens,
    providerRequests,
    stripeFixture,
  );
  let api: Awaited<ReturnType<typeof startProductionApiFromEnvironment>>;
  let projection: Awaited<ReturnType<typeof composeProjectionWorker>>;
  let commerceWorker: ReturnType<typeof composeCommerceReconcilerWorker>;
  let commerceAbort: AbortController;
  let commerceTask: Promise<void>;
  let lifecycleWorker: ReturnType<typeof createLifecycleWorkerRunner>;
  let ownTracksServer: HttpsServer;
  let tlsProxy: HttpsServer;
  let signer: NetServer;
  let helper: RunningHelper;
  let root = '';
  let artifactRoot = '';
  let artifactKeyPath = '';
  let signingSocket = '';
  let apiBaseUrl = '';
  let browser: BrowserBotmemClient;
  let browserCookie = '';
  let accessToken = '';
  let webResponse: SearchResponse;
  let cliResponse: SearchResponse;
  let mcpResponse: SearchResponse;
  let exportText = '';
  let deletionVerified = false;

  beforeAll(async () => {
    if (
      !ADMIN_DATABASE_URL ||
      !API_DATABASE_URL ||
      !WORKER_DATABASE_URL ||
      !DISPATCHER_DATABASE_URL ||
      !COMMERCE_DATABASE_URL ||
      !IDENTITY_DATABASE_URL ||
      !LIFECYCLE_DATABASE_URL ||
      !REDIS_URL ||
      !TLS_CERT_PATH ||
      !TLS_KEY_PATH ||
      !TLS_CA_PATH
    ) {
      throw new Error('production E2E environment is incomplete');
    }
    globalThis.fetch = providerFetch;
    root = await mkdtemp(join(tmpdir(), 'botmem-v2-production-e2e-'));
    artifactRoot = join(root, 'lifecycle-artifacts');
    artifactKeyPath = join(root, 'lifecycle-artifact.key');
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(artifactKeyPath, `${Buffer.alloc(32, 47).toString('base64url')}\n`, {
      mode: 0o600,
    });
    await provision(outsider, 2);

    const tls = {
      cert: await readFile(TLS_CERT_PATH),
      key: await readFile(TLS_KEY_PATH),
    };
    ownTracksServer = createOwnTracksEmulator(tls, providerRequests);
    const ownTracksPort = await listen(ownTracksServer);
    const apiPort = await reservePort();
    tlsProxy = createTlsReverseProxy(tls, apiPort);
    const proxyPort = await listen(tlsProxy);
    apiBaseUrl = `https://localhost:${proxyPort}`;
    const environment = runtimeEnvironment(
      apiPort,
      ownTracksPort,
      proxyPort,
      artifactRoot,
      artifactKeyPath,
    );

    commerceWorker = composeCommerceReconcilerWorker(environment, {
      report: (event) => {
        commerceEvents.push(event.code);
      },
    });
    commerceAbort = new AbortController();
    commerceTask = commerceWorker.run(commerceAbort.signal);
    await eventually(
      () =>
        new PostgresCommerceRepository(commercePool, 'botmem_commerce').reconcilerReady(
          new Date().toISOString(),
          60,
        ),
      5_000,
    );

    await new PostgresRuntimeRoleValidator().validate(
      lifecyclePool,
      'botmem_lifecycle',
      AbortSignal.timeout(5_000),
    );
    lifecycleWorker = createLifecycleWorkerRunner({
      lifecyclePool,
      artifactRoot,
      artifactKey: new Uint8Array(32).fill(47),
      artifactStore: {
        maxArtifactBytes: 5 * 1024 * 1024,
        maxWorkspaceBytes: 10 * 1024 * 1024,
        maxGlobalBytes: 20 * 1024 * 1024,
        minimumFreeBytes: 0,
      },
      workerId: 'production-e2e-lifecycle',
      clock: { nowMs: () => Date.now() },
      telemetry: { event: () => undefined },
      pollIntervalMs: 100,
      exportPageSize: 16,
      exportRetentionMs: 60_000,
    });
    await lifecycleWorker.runOnce();

    api = await startProductionApiFromEnvironment(environment, [
      commerceApiExtensionFactory,
      lifecycleApiExtensionFactory,
    ]);

    browser = new BrowserBotmemClient({
      baseUrl: apiBaseUrl,
      fetch: sessionFetch(
        nativeFetch,
        () => browserCookie,
        (cookie) => {
          browserCookie = cookie;
        },
      ),
    });

    expect((await browser.getBillingPrice()).unitAmountMinor).toBe(1900);
    const checkout = await browser.createBillingCheckout({
      version: 2,
      email: workspace.email,
      workspaceName: 'Production E2E Owner',
    });
    const checkoutSessionId = new URL(checkout.checkoutUrl).pathname.split('/').pop();
    expect(checkoutSessionId).toBe(CHECKOUT_SESSION_ID);
    const signupId = stripeFixture.signupId;
    if (!signupId) throw new Error('Stripe checkout emulator did not receive the signup ID');
    await sendStripeCheckoutWebhook(signupId);
    let activeWorkspaceId = '';
    try {
      await eventually(async () => {
        const status = await browser.getBillingCheckoutStatus(CHECKOUT_SESSION_ID);
        if (status.status !== 'active') return false;
        activeWorkspaceId = status.workspaceId;
        return true;
      }, 10_000);
    } catch (error) {
      const client = await adminPool.connect();
      try {
        const diagnostics = await client.query({
          text: `SELECT event.state, event.attempts, event.failure_code,
                        signup.checkout_state,
                        subscription.stripe_status,
                        subscription.provisioned_at
                   FROM botmem.stripe_webhook_event event
                   LEFT JOIN botmem.billing_signup signup ON signup.id = event.signup_id
                   LEFT JOIN botmem.billing_subscription subscription
                     ON subscription.signup_id = signup.id
                  WHERE event.id = 'evt_productione2echeckout123456'`,
        });
        throw new Error(
          `checkout reconciliation timed out: ${JSON.stringify({
            diagnostics: diagnostics.rows,
            commerceEvents,
            providerRequests: providerRequests.filter((request) => request.startsWith('stripe:')),
          })}`,
          { cause: error },
        );
      } finally {
        client.release();
      }
    }
    workspace = { ...workspace, workspaceId: activeWorkspaceId };

    const ownerSession = await login(workspace.email, environment);
    expect(ownerSession.setCookie).toContain('__Host-botmem_session=');
    expect(ownerSession.setCookie).toContain('; Path=/');
    expect(ownerSession.setCookie).toContain('; HttpOnly');
    expect(ownerSession.setCookie).toContain('; SameSite=Strict');
    expect(ownerSession.setCookie).toContain('; Secure');
    browserCookie = ownerSession.cookie;
    expect((await browser.getSession()).workspaceId).toBe(workspace.workspaceId);

    const outsiderSession = await login(outsider.email, environment);
    const outsiderBrowser = new BrowserBotmemClient({
      baseUrl: apiBaseUrl,
      fetch: sessionFetch(nativeFetch, () => outsiderSession.cookie),
    });
    expect((await outsiderBrowser.getSession()).workspaceId).toBe(outsider.workspaceId);
    await expect(
      outsiderBrowser.search(workspace.workspaceId, { version: 2, query: QUERY }),
    ).rejects.toEqual(expect.objectContaining<WebApiError>({ status: 403 }));

    accessToken = (
      await browser.issuePersonalAccessToken(workspace.workspaceId, {
        version: 2,
        label: 'production-e2e',
        ttlSeconds: 3_600,
        scopes: ['botmem:search', 'botmem:connections:read', 'botmem:devices:read'],
      })
    ).accessToken;

    await connectOAuth('gmail');
    await connectOAuth('outlook');
    const ownTracks = await browser.connectOwnTracks(workspace.workspaceId, {
      version: 2,
      endpoint: `https://localhost:${ownTracksPort}/api/0/locations`,
      username: 'e2e-owner',
      password: 'e2e-owntracks-password',
    });
    expect(ownTracks.connection.connector).toBe('owntracks');

    const sync = composeHostedSyncWorker({
      workerPool,
      telemetry: { record: () => undefined },
      environment,
    });
    let synchronized = 0;
    while (synchronized < 10 && (await sync.worker.runOnce())) synchronized += 1;
    expect(synchronized).toBe(3);

    projection = await composeProjectionWorker({
      environment: {
        ...environment,
        DISPATCHER_DATABASE_URL,
        WORKER_DATABASE_URL,
        PROJECTION_WORKER_ID: 'production-e2e-projection',
        PROJECTION_BATCH_SIZE: '16',
        PROJECTION_CONCURRENCY: '8',
        PROJECTION_POLL_MS: '50',
        PROJECTION_LEASE_MS: '10000',
        PROJECTION_TASK_TIMEOUT_MS: '5000',
      },
      fetch: providerFetch,
      telemetry: { event: () => undefined, metric: () => undefined },
    });
    let projected = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const count = await projection.worker.runOnce();
      projected += count;
      if (count === 0) break;
    }
    expect(projected).toBe(3);

    const semanticEvidence = await adminPool.connect();
    try {
      const evidence = await semanticEvidence.query<{
        readonly lexical_match: boolean;
        readonly trigram_match: boolean;
      }>({
        text: `SELECT document.search_vector @@
                        websearch_to_tsquery(
                          'simple', botmem.normalize_search_text($2::text)
                        ) AS lexical_match,
                      botmem.normalize_search_text($2::text) <% document.search_text
                        AS trigram_match
                 FROM botmem.hosted_document_revision document
                WHERE document.tenant_id = $1::uuid
                  AND document.connector = 'gmail'
                  AND document.source_event_id = 'gmail-e2e'`,
        values: [workspace.workspaceId, HOSTED_SEMANTIC_QUERY],
      });
      expect(evidence.rows).toEqual([{ lexical_match: false, trigram_match: false }]);
    } finally {
      semanticEvidence.release();
    }
    const semanticResult = await browser.search(workspace.workspaceId, {
      version: 2,
      query: HOSTED_SEMANTIC_QUERY,
      connectors: ['gmail'],
      limit: 5,
    });
    expect(semanticResult.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'gmail-e2e',
          origin: expect.objectContaining({ placement: 'hosted', connector: 'gmail' }),
        }),
      ]),
    );

    expect((await browser.getBillingPrice()).unitAmountMinor).toBe(1900);
    const connections = await browser.listConnections(workspace.workspaceId);
    expect(connections.items.map((item) => item.connector).sort()).toEqual([
      'gmail',
      'outlook',
      'owntracks',
    ]);
    expect(connections.items.every((item) => item.source.searchable)).toBe(true);

    const deviceId = crypto.randomUUID();
    const keyId = 'production-e2e-ed25519';
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
      'base64url',
    );
    const pairing = await browser.issuePairingCode(workspace.workspaceId);
    const paired = await nativeFetch(
      `${apiBaseUrl}/v2/workspaces/${workspace.workspaceId}/devices/pair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: pairing.code,
          deviceId,
          displayName: 'Production E2E Mac',
          keyId,
          publicKeyBase64Url: publicKey,
          connectors: ['imessage', 'whatsapp'],
        }),
      },
    );
    expect(paired.status).toBe(201);

    const indexRoot = join(root, 'device-index');
    await execFileAsync(SEED_BINARY, [indexRoot], { timeout: 30_000 });
    signingSocket = join(root, 'signer.sock');
    signer = await startSigner(signingSocket, async (request) => {
      const signature = await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        authenticationMessage({
          deviceId,
          keyId,
          clientNonce: String(request['clientNonce']),
          serverNonce: String(request['serverNonce']),
        }),
      );
      return Buffer.from(signature).toString('base64url');
    });
    helper = spawnHelper({
      protocolVersion: 'botmem.tunnel.config.v1',
      apiBaseUrl: `${apiBaseUrl}/`,
      workspaceId: workspace.workspaceId,
      deviceId,
      keyId,
      clientVersion: 'botmem-tunnel/production-e2e',
      connectors: ['imessage', 'whatsapp'],
      indexRoot,
      signingSocket,
      trustAnchorPem: await readFile(TLS_CA_PATH, 'utf8'),
    });
    await eventually(async () => {
      if (helper.child.exitCode !== null) {
        throw new Error(`Rust tunnel exited early: ${helper.stderr()}`);
      }
      const devices = await browser.listDevices(workspace.workspaceId);
      const device = devices.items.find((item) => item.deviceId === deviceId);
      return (
        device?.state === 'online' &&
        device.sources.length === 2 &&
        device.sources.every((source) => source.searchable)
      );
    }, 15_000);

    const deviceTypoResult = await browser.search(workspace.workspaceId, {
      version: 2,
      query: DEVICE_TYPO_QUERY,
      connectors: ['imessage', 'whatsapp'],
      limit: 5,
    });
    expect(new Set(deviceTypoResult.items.map((item) => item.sourceId))).toEqual(
      new Set(['imessage-e2e', 'whatsapp-e2e']),
    );
    expect(new Set(deviceTypoResult.items.map((item) => item.origin.connector))).toEqual(
      new Set(['imessage', 'whatsapp']),
    );
    expect(deviceTypoResult.items.every((item) => item.origin.placement === 'device')).toBe(true);

    webResponse = await browser.search(workspace.workspaceId, {
      version: 2,
      query: QUERY,
      limit: 20,
    });
    const cli = await execFileAsync(
      CLI_BINARY,
      ['search', '--workspace', workspace.workspaceId, '--query', QUERY, '--json'],
      {
        env: {
          ...process.env,
          BOTMEM_API_URL: apiBaseUrl,
          BOTMEM_ACCESS_TOKEN: accessToken,
        },
        timeout: 30_000,
      },
    );
    expect(cli.stderr).toBe('');
    cliResponse = parseSearchResponse(JSON.parse(cli.stdout));

    const transport = new StreamableHTTPClientTransport(
      new URL(`${apiBaseUrl}/v2/workspaces/${workspace.workspaceId}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    );
    const mcp = new Client({ name: 'botmem-production-e2e', version: '1.0.0' });
    await mcp.connect(transport);
    try {
      const tools = await mcp.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'connections.list',
        'devices.status',
        'search',
      ]);
      const result = await mcp.callTool({ name: 'search', arguments: { query: QUERY, limit: 20 } });
      mcpResponse = parseSearchResponse(result.structuredContent);
    } finally {
      await mcp.close();
    }

    const exportJob = await browser.requestWorkspaceExport(workspace.workspaceId);
    expect(exportJob.job.state).toBe('queued');
    await expect(lifecycleWorker.runOnce()).resolves.toBe(true);
    const exported = await browser.downloadWorkspaceExport(
      workspace.workspaceId,
      exportJob.job.jobId,
    );
    exportText = await exported.text();
    expect(exportText).toContain('"contentBoundary":"hosted-only"');
    expect(exportText).toContain('"localContentIncluded":false');
    expect(exportText).toContain('"connector":"gmail"');
    expect(exportText).toContain('"connector":"outlook"');
    expect(exportText).toContain('"connector":"owntracks"');
    expect(exportText).not.toContain('credential_ref');
    const retriedExport = await browser.downloadWorkspaceExport(
      workspace.workspaceId,
      exportJob.job.jobId,
    );
    await expect(retriedExport.text()).resolves.toBe(exportText);

    helper.child.kill('SIGTERM');
    await helper.exit;
    await eventually(async () => {
      const device = (await browser.listDevices(workspace.workspaceId)).items.find(
        (item) => item.deviceId === deviceId,
      );
      return device?.state === 'offline';
    }, 10_000);

    const deletion = await browser.requestWorkspaceDeletion(
      workspace.workspaceId,
      `DELETE ${workspace.workspaceId}`,
    );
    expect(deletion.job.state).toBe('queued');
    await eventually(async () => {
      const client = await adminPool.connect();
      try {
        const result = await client.query<{ readonly state: string }>({
          text: `SELECT state
                   FROM botmem.workspace_billing_cancellation_request
                  WHERE job_id = $1::uuid`,
          values: [deletion.job.jobId],
        });
        return result.rows[0]?.state === 'confirmed';
      } finally {
        client.release();
      }
    }, 10_000);
    expect(stripeFixture.subscriptionCanceled).toBe(true);
    expect(providerRequests).toContain('stripe:subscription_cancel');
    expect(commerceEvents).toContain('commerce_cancellation_processed');
    await expect(lifecycleWorker.runOnce()).resolves.toBe(true);

    const verificationClient = await adminPool.connect();
    try {
      const result = await verificationClient.query<{
        readonly workspace_status: string | null;
        readonly identity_rows: string;
        readonly credential_rows: string;
        readonly connector_credential_rows: string;
        readonly ingest_rows: string;
        readonly notice_state: string | null;
        readonly deletion_completed: boolean;
        readonly billing_cancellation_state: string | null;
        readonly had_subscription: boolean | null;
      }>({
        text: `SELECT
          (SELECT status FROM botmem.workspace WHERE id = $1::uuid) AS workspace_status,
          (SELECT count(*)::text FROM botmem.identity_user WHERE tenant_id = $1::uuid) AS identity_rows,
          (SELECT count(*)::text FROM botmem.identity_credential WHERE tenant_id = $1::uuid) AS credential_rows,
          (SELECT count(*)::text FROM botmem.connector_credential WHERE tenant_id = $1::uuid) AS connector_credential_rows,
          (SELECT count(*)::text FROM botmem.ingest_event_revision WHERE tenant_id = $1::uuid) AS ingest_rows,
          (SELECT state FROM botmem.workspace_device_deletion_notice
            WHERE job_id = $2::uuid LIMIT 1) AS notice_state,
          EXISTS (
            SELECT 1 FROM botmem.workspace_lifecycle_job
             WHERE id = $2::uuid AND state = 'completed'
          ) AS deletion_completed,
          (SELECT cancellation_state FROM botmem.workspace_deleted_billing_audit
            WHERE job_id = $2::uuid) AS billing_cancellation_state,
          (SELECT had_subscription FROM botmem.workspace_deleted_billing_audit
            WHERE job_id = $2::uuid) AS had_subscription`,
        values: [workspace.workspaceId, deletion.job.jobId],
      });
      expect(result.rows[0]).toMatchObject({
        workspace_status: 'deleted',
        identity_rows: '0',
        credential_rows: '0',
        connector_credential_rows: '0',
        ingest_rows: '0',
        deletion_completed: true,
        billing_cancellation_state: 'confirmed',
        had_subscription: true,
      });
      expect(result.rows[0]?.notice_state).not.toBeNull();
      expect(result.rows[0]?.notice_state).not.toBe('delivered');
    } finally {
      verificationClient.release();
    }
    await expect(browser.getSession()).rejects.toEqual(
      expect.objectContaining<WebApiError>({ status: 401 }),
    );
    const revokedPat = await nativeFetch(
      `${apiBaseUrl}/v2/workspaces/${workspace.workspaceId}/search`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ version: 2, query: QUERY }),
      },
    );
    expect(revokedPat.status).toBe(401);
    deletionVerified = true;
  }, 180_000);

  afterAll(async () => {
    commerceAbort?.abort('test_complete');
    await commerceTask?.catch(() => undefined);
    if (helper?.child.exitCode === null) {
      helper.child.kill('SIGTERM');
      await helper.exit.catch(() => undefined);
    }
    await Promise.allSettled([
      projection?.close(),
      api?.close(),
      commerceWorker?.close(),
      closeServer(tlsProxy),
      closeServer(ownTracksServer),
      closeServer(signer),
    ]);
    if (signingSocket) await unlink(signingSocket).catch(() => undefined);
    await Promise.allSettled([
      adminPool.close(),
      apiPool.close(),
      workerPool.close(),
      commercePool.close(),
      identityPool.close(),
      lifecyclePool.close(),
    ]);
    globalThis.fetch = nativeFetch;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('proves the production onboarding, five-source parity, export, and deletion journey', () => {
    const web = parity(webResponse);
    const cli = parity(cliResponse);
    const mcp = parity(mcpResponse);
    expect(cli).toEqual(web);
    expect(mcp).toEqual(web);
    expect(new Set(web.map((item) => item.connector))).toEqual(
      new Set(['gmail', 'outlook', 'owntracks', 'imessage', 'whatsapp']),
    );
    expect(webResponse.coverage.partial).toBe(false);
    expect(webResponse.coverage.lanes.every((lane) => lane.status === 'complete')).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('resend:'))).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('gmail:'))).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('outlook:'))).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('owntracks:'))).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('openai:'))).toBe(true);
    expect(providerRequests.some((value) => value.startsWith('stripe:'))).toBe(true);
    expect(exportText).toContain('"contentBoundary":"hosted-only"');
    expect(deletionVerified).toBe(true);
  });

  async function sendStripeCheckoutWebhook(signupId: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({
      id: 'evt_productione2echeckout123456',
      object: 'event',
      type: 'checkout.session.completed',
      created: timestamp,
      data: {
        object: {
          id: CHECKOUT_SESSION_ID,
          object: 'checkout.session',
          client_reference_id: signupId,
          customer: STRIPE_CUSTOMER_ID,
          subscription: STRIPE_SUBSCRIPTION_ID,
          metadata: { botmem_signup_id: signupId },
        },
      },
    });
    const signature = createHmac('sha256', STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    const response = await nativeFetch(`${apiBaseUrl}/v2/billing/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function provision(fixture: WorkspaceFixture, sequence: number): Promise<void> {
    const now = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const apiRepository = new PostgresCommerceRepository(apiPool, 'botmem_api');
    const commerce = new PostgresCommerceRepository(commercePool, 'botmem_commerce');
    const signup = {
      signupId: fixture.workspaceId,
      workspaceId: fixture.workspaceId,
      ownerUserId: fixture.ownerId,
      email: fixture.email,
      emailLookupHashHex: await new IdentityEmailLookupHasher(
        new NodeTokenSecurity(PEPPER),
      ).hashCanonicalEmail(fixture.email),
      workspaceName: `Production E2E ${sequence}`,
    };
    const checkoutSessionId = `cs_test_productione2e${sequence}123456`;
    await apiRepository.createSignup({ ...signup, createdAt: now, expiresAt });
    await apiRepository.attachCheckout({
      signupId: fixture.workspaceId,
      sessionId: checkoutSessionId,
      expiresAt,
    });
    await new PostgresIdentityProvisioner(identityPool).provision(signup, now);
    await commerce.applySubscription({
      event: {
        eventId: `evt_productione2e${sequence}123456`,
        eventType: 'invoice.paid',
        eventCreatedAt: now,
        objectId: `in_productione2e${sequence}123456`,
        signupId: fixture.workspaceId,
        subscriptionId: `sub_productione2e${sequence}123456`,
        customerId: `cus_productione2e${sequence}123456`,
      },
      subscription: {
        signupId: fixture.workspaceId,
        subscriptionId: `sub_productione2e${sequence}123456`,
        customerId: `cus_productione2e${sequence}123456`,
        status: 'active',
        priceId: PRICE_ID,
        quantity: 1,
        currentPeriodEnd: expiresAt,
      },
      checkoutSessionId,
      priceMatches: true,
      observedAt: new Date(Date.now() + sequence * 1_000).toISOString(),
      provisionedAt: now,
    });
  }

  async function login(
    email: string,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<{ readonly cookie: string; readonly setCookie: string }> {
    const origin = environment['PUBLIC_WEB_URL']!;
    const started = await nativeFetch(`${apiBaseUrl}/v2/auth/email/start`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, email }),
    });
    expect(started.status, await started.clone().text()).toBe(202);
    const token = await eventuallyValue(() => deliveredLoginTokens.get(email), 5_000);
    const completed = await nativeFetch(`${apiBaseUrl}/v2/auth/email/complete`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(completed.status, await completed.clone().text()).toBe(204);
    const setCookie = completed.headers.get('set-cookie') ?? '';
    const cookie = cookiePair(setCookie);
    if (!cookie) throw new Error('login response did not issue a session cookie');
    return { cookie, setCookie };
  }

  async function connectOAuth(connector: 'gmail' | 'outlook'): Promise<void> {
    const begun = await browser.beginOAuthConnection(workspace.workspaceId, {
      version: 2,
      connector,
    });
    const state = new URL(begun.authorizationUrl).searchParams.get('state');
    if (!state) throw new Error(`${connector} OAuth state missing`);
    const callback = await nativeFetch(
      `${apiBaseUrl}/v2/connections/oauth/${connector}/callback?${new URLSearchParams({
        state,
        code: `${connector}-production-e2e-code`,
      })}`,
      { redirect: 'manual' },
    );
    expect(callback.status).toBe(303);
  }
});

function runtimeEnvironment(
  apiPort: number,
  ownTracksPort: number,
  proxyPort: number,
  artifactRoot: string,
  artifactKeyPath: string,
): Record<string, string> {
  const origin = `https://localhost:${proxyPort}`;
  return {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    DATABASE_URL: API_DATABASE_URL,
    PUBLIC_BASE_URL: origin,
    PUBLIC_WEB_URL: origin,
    TRUSTED_ORIGINS: origin,
    AUTH_TOKEN_PEPPER: PEPPER_TEXT,
    RESEND_API_KEY: 're_production_e2e_key',
    LOGIN_EMAIL_FROM: 'Botmem <login@example.test>',
    CONNECTOR_VAULT_KEYS: VAULT_KEY,
    GOOGLE_OAUTH_CLIENT_ID: 'google-production-e2e-client',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-production-e2e-secret',
    MICROSOFT_OAUTH_CLIENT_ID: 'microsoft-production-e2e-client',
    MICROSOFT_OAUTH_CLIENT_SECRET: 'microsoft-production-e2e-secret',
    OPENAI_API_KEY: `sk-${'e'.repeat(32)}`,
    OPENAI_EMBED_MODEL: 'text-embedding-3-small',
    OPENAI_EMBED_ENDPOINT: `https://localhost:${ownTracksPort}/openai/embeddings`,
    OPENAI_EMBED_TIMEOUT_MS: '5000',
    HOSTED_SEARCH_STATEMENT_TIMEOUT_MS: '1000',
    HOSTED_SEARCH_DEADLINE_MS: '5000',
    DEVICE_SEARCH_DEADLINE_MS: '5000',
    SEARCH_RATE_LIMIT_WORKSPACE_PER_MINUTE: '100',
    SEARCH_RATE_LIMIT_GLOBAL_PER_MINUTE: '1000',
    REDIS_URL,
    API_REPLICA_ID: 'production-e2e-api',
    LIFECYCLE_RELAY_ID: 'production-e2e-lifecycle-relay',
    LIFECYCLE_ARTIFACT_ROOT: artifactRoot,
    LIFECYCLE_ARTIFACT_KEY_PATH: artifactKeyPath,
    LIFECYCLE_ARTIFACT_MAX_BYTES: String(5 * 1024 * 1024),
    LIFECYCLE_ARTIFACT_WORKSPACE_QUOTA_BYTES: String(10 * 1024 * 1024),
    LIFECYCLE_ARTIFACT_GLOBAL_QUOTA_BYTES: String(20 * 1024 * 1024),
    LIFECYCLE_ARTIFACT_MINIMUM_FREE_BYTES: '0',
    LIFECYCLE_WORKER_MAXIMUM_AGE_SECONDS: '60',
    DEVICE_REDIS_NAMESPACE: `botmem:v2:production-e2e:${crypto.randomUUID()}`,
    DEVICE_HEARTBEAT_INTERVAL_MS: '5000',
    DEVICE_RELAY_TIMEOUT_MS: '5000',
    OWNTRACKS_TEST_ALLOW_PRIVATE_ENDPOINTS: '1',
    OWNTRACKS_TEST_ENDPOINT_PORT: String(ownTracksPort),
    WORKER_DATABASE_URL,
    HOSTED_SYNC_WORKER_ID: 'production-e2e-sync',
    HOSTED_SYNC_MAX_RUN_SECONDS: '60',
    HOSTED_SYNC_POLL_MS: '50',
    HOSTED_SYNC_HEARTBEAT_SECONDS: '1',
    HOSTED_SYNC_RETRY_BASE_MS: '100',
    HOSTED_SYNC_RETRY_MAX_MS: '1000',
    HOSTED_SYNC_GMAIL_INTERVAL_SECONDS: '300',
    HOSTED_SYNC_OUTLOOK_INTERVAL_SECONDS: '300',
    HOSTED_SYNC_OWNTRACKS_INTERVAL_SECONDS: '300',
    STRIPE_CHECKOUT_API_KEY: 'sk_test_productione2e123456',
    SALES_ENABLED: 'true',
    STRIPE_WEBHOOK_SECRET,
    STRIPE_API_VERSION: '2026-02-25.clover',
    STRIPE_PRICE_ID: PRICE_ID,
    STRIPE_CHECKOUT_API_ENDPOINT: `https://localhost:${ownTracksPort}`,
    STRIPE_CHECKOUT_SUCCESS_URL: `${origin}/signup/complete?session_id={CHECKOUT_SESSION_ID}`,
    STRIPE_CHECKOUT_CANCEL_URL: `${origin}/pricing?checkout=cancelled`,
    STRIPE_PORTAL_RETURN_URL: `${origin}/app`,
    COMMERCE_DATABASE_URL,
    IDENTITY_ADMIN_DATABASE_URL: IDENTITY_DATABASE_URL,
    STRIPE_RECONCILER_API_KEY: 'rk_test_productione2ereconcile123456',
    STRIPE_RECONCILER_API_ENDPOINT: `https://localhost:${ownTracksPort}`,
    COMMERCE_RECONCILER_WORKER_ID: 'production-e2e-commerce',
    COMMERCE_RECONCILER_POLL_MS: '50',
    COMMERCE_RECONCILER_HEARTBEAT_MS: '1000',
  };
}

function createProviderFetch(
  nativeFetch: typeof globalThis.fetch,
  delivered: Map<string, string>,
  requests: string[],
  stripe: StripeFixture,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'api.resend.com') {
      const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
      const token = /bml_v2\.[A-Za-z0-9_-]{43}/u.exec(body.text)?.[0];
      if (!token || !body.to[0]) return json({ error: 'invalid fixture' }, 400);
      delivered.set(body.to[0], token);
      requests.push(`resend:${body.to[0]}`);
      return json({ id: 'email-production-e2e' });
    }
    if (url.pathname === '/openai/embeddings') {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      requests.push(`openai:${body.input.length}`);
      return json({
        model: 'text-embedding-3-small-production-e2e',
        data: body.input.map((_value, index) => ({
          index,
          embedding: Array.from({ length: 768 }, (_unused, offset) => (offset === 0 ? 1 : 0)),
        })),
      });
    }
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
      const parameters = new URLSearchParams(String(init.body));
      const signupId = parameters.get('client_reference_id');
      if (!signupId) return json({ error: 'missing signup fixture' }, 400);
      stripe.signupId = signupId;
      requests.push('stripe:checkout');
      return json({
        id: stripe.sessionId,
        object: 'checkout.session',
        url: `https://checkout.stripe.test/session/${stripe.sessionId}`,
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      });
    }
    if (url.pathname === `/v1/checkout/sessions/${stripe.sessionId}`) {
      requests.push('stripe:checkout_retrieve');
      return json({
        id: stripe.sessionId,
        object: 'checkout.session',
        client_reference_id: stripe.signupId ?? null,
        customer: STRIPE_CUSTOMER_ID,
        subscription: STRIPE_SUBSCRIPTION_ID,
        metadata: stripe.signupId ? { botmem_signup_id: stripe.signupId } : {},
      });
    }
    if (
      url.pathname === `/v1/subscriptions/${STRIPE_SUBSCRIPTION_ID}` &&
      init?.method === 'DELETE'
    ) {
      stripe.subscriptionCanceled = true;
      requests.push('stripe:subscription_cancel');
      return json({
        id: STRIPE_SUBSCRIPTION_ID,
        object: 'subscription',
        status: 'canceled',
      });
    }
    if (url.pathname === `/v1/subscriptions/${STRIPE_SUBSCRIPTION_ID}`) {
      requests.push('stripe:subscription_retrieve');
      return json({
        id: STRIPE_SUBSCRIPTION_ID,
        object: 'subscription',
        customer: STRIPE_CUSTOMER_ID,
        status: stripe.subscriptionCanceled ? 'canceled' : 'active',
        metadata: { botmem_signup_id: stripe.signupId ?? '' },
        current_period_end: Math.floor(Date.now() / 1_000) + 86_400,
        items: {
          data: [{ quantity: 1, price: { id: PRICE_ID } }],
        },
      });
    }
    if (url.pathname.startsWith('/v1/prices/') || url.pathname.startsWith('/stripe/v1/prices/')) {
      requests.push('stripe:price');
      return json({
        id: PRICE_ID,
        object: 'price',
        active: true,
        type: 'recurring',
        currency: 'usd',
        unit_amount: 1900,
        recurring: { interval: 'month', interval_count: 1 },
      });
    }
    if (url.hostname === 'oauth2.googleapis.com') {
      requests.push('gmail:token');
      return json({
        access_token: 'gmail-access-e2e',
        refresh_token: 'gmail-refresh-e2e',
        expires_in: 3600,
        scope: GMAIL_OAUTH_SCOPE,
        token_type: 'Bearer',
      });
    }
    if (url.hostname === 'openidconnect.googleapis.com') {
      requests.push('gmail:identity');
      return json({ sub: 'google-e2e-owner', email: 'gmail@example.test', email_verified: true });
    }
    if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/profile')) {
      requests.push('gmail:profile');
      return json({
        emailAddress: 'gmail@example.test',
        historyId: 'history-e2e',
        messagesTotal: 1,
      });
    }
    if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/messages')) {
      requests.push('gmail:list');
      return json({ messages: [{ id: 'gmail-e2e' }] });
    }
    if (url.hostname === 'gmail.googleapis.com' && url.pathname.includes('/messages/gmail-e2e')) {
      requests.push('gmail:message');
      return json({
        id: 'gmail-e2e',
        threadId: 'gmail-thread-e2e',
        historyId: 'history-e2e',
        labelIds: ['SENT'],
        internalDate: '1700000001000',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: 'Production handoff nexus Gmail' },
            { name: 'From', value: 'Owner <gmail@example.test>' },
            { name: 'To', value: 'Team <team@example.test>' },
          ],
          body: { data: Buffer.from(`${QUERY} hosted Gmail result`).toString('base64url') },
        },
      });
    }
    if (url.hostname === 'login.microsoftonline.com') {
      requests.push('outlook:token');
      return json({
        access_token: 'outlook-access-e2e',
        refresh_token: 'outlook-refresh-e2e',
        expires_in: 3600,
        scope: OUTLOOK_SCOPE,
        token_type: 'Bearer',
      });
    }
    if (url.hostname === 'graph.microsoft.com' && url.pathname === '/v1.0/me') {
      requests.push('outlook:profile');
      return json({
        id: 'outlook-owner-e2e',
        mail: 'outlook@example.test',
        userPrincipalName: null,
      });
    }
    if (url.hostname === 'graph.microsoft.com' && url.pathname === '/v1.0/me/mailFolders') {
      requests.push('outlook:folders');
      return json({ value: [{ id: 'inbox-e2e', childFolderCount: 0 }] });
    }
    if (url.hostname === 'graph.microsoft.com' && url.pathname.includes('/messages/delta')) {
      requests.push('outlook:message');
      return json({
        value: [
          {
            id: 'outlook-e2e',
            changeKey: 'outlook-revision-e2e',
            receivedDateTime: '2023-11-14T22:13:22.000Z',
            subject: 'Production handoff nexus Outlook',
            body: { contentType: 'text', content: `${QUERY} hosted Outlook result` },
            from: { emailAddress: { address: 'outlook@example.test', name: 'Owner' } },
            toRecipients: [{ emailAddress: { address: 'team@example.test', name: 'Team' } }],
            conversationId: 'outlook-conversation-e2e',
            attachments: [],
          },
        ],
        '@odata.deltaLink':
          'https://graph.microsoft.com/v1.0/me/mailFolders/inbox-e2e/messages/delta?$deltatoken=e2e',
      });
    }
    return nativeFetch(input, init);
  };
}

function createOwnTracksEmulator(
  tls: { readonly cert: Buffer; readonly key: Buffer },
  requests: string[],
): HttpsServer {
  return createHttpsServer(tls, (request, response) => {
    requests.push(`owntracks:${request.url ?? '/'}`);
    if (
      request.url?.startsWith('/api/0/locations') &&
      request.headers.authorization ===
        `Basic ${Buffer.from('e2e-owner:e2e-owntracks-password').toString('base64')}`
    ) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify([
          {
            _type: 'location',
            _id: 'owntracks-e2e',
            tst: Math.floor(Date.now() / 1000) - 60,
            lat: 25.2048,
            lon: 55.2708,
            acc: 4,
          },
        ]),
      );
      return;
    }
    response.writeHead(401).end();
  });
}

function sessionFetch(
  nativeFetch: typeof globalThis.fetch,
  cookie: () => string,
  updateCookie: (value: string) => void = () => undefined,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const current = cookie();
    if (current) headers.set('cookie', current);
    const method = init.method?.toUpperCase() ?? 'GET';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      headers.set('origin', url.origin);
    }
    const response = await nativeFetch(input, { ...init, headers });
    const issued = cookiePair(response.headers.get('set-cookie'));
    if (issued) updateCookie(issued);
    return response;
  };
}

function createTlsReverseProxy(
  tls: { readonly cert: Buffer; readonly key: Buffer },
  apiPort: number,
): HttpsServer {
  const server = createHttpsServer(tls, (request, response) => {
    const upstream = requestHttp(
      {
        hostname: '127.0.0.1',
        port: apiPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          'x-forwarded-for': request.socket.remoteAddress ?? '127.0.0.1',
          'x-forwarded-host': request.headers.host ?? `localhost:${apiPort}`,
          'x-forwarded-proto': 'https',
        },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = connectNet(apiPort, '127.0.0.1', () => {
      const firstLine = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}\r\n`;
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${firstLine}${headers.join('\r\n')}\r\n\r\n`);
      if (head.byteLength > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return server;
}

async function startSigner(
  path: string,
  sign: (request: Record<string, unknown>) => Promise<string>,
): Promise<NetServer> {
  await unlink(path).catch(() => undefined);
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    let received = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      socket.removeAllListeners('data');
      void (async () => {
        try {
          const request = JSON.parse(received.subarray(0, newline).toString()) as Record<
            string,
            unknown
          >;
          socket.end(
            `${JSON.stringify({
              protocolVersion: 'botmem.signing.ipc.v1',
              ok: true,
              signatureBase64Url: await sign(request),
              errorCode: null,
            })}\n`,
          );
        } catch {
          socket.destroy();
        }
      })();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  await chmod(path, 0o600);
  return server;
}

function spawnHelper(config: object): RunningHelper {
  const child = spawn(TUNNEL_BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    },
  );
  child.stdin.end(JSON.stringify(config));
  return { child, exit, stderr: () => stderr };
}

function parity(response: SearchResponse) {
  return response.items.map((item) => ({
    ref: item.ref,
    sourceId: item.sourceId,
    connector: item.origin.connector,
    placement: item.origin.placement,
    accountId: item.origin.placement === 'hosted' ? item.origin.accountId : undefined,
    deviceId: item.origin.placement === 'device' ? item.origin.deviceId : undefined,
  }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cookiePair(value: string | null): string {
  return value?.split(';', 1)[0] ?? '';
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function listen(server: HttpsServer | NetServer): Promise<number> {
  return await new Promise<number>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('TCP address missing'));
      resolveListen(address.port);
    });
  });
}

async function closeServer(server: HttpsServer | NetServer | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function eventually(operation: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('eventual assertion timed out');
}

async function eventuallyValue<T>(operation: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = operation();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('eventual value timed out');
}
