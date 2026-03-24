/**
 * CLI E2E Tests (CLI-001 → CLI-030)
 *
 * These tests spawn the actual `botmem` CLI binary and verify stdout/stderr.
 * Prerequisites:
 *   - API running on localhost:12412
 *   - CLI built: `pnpm --filter @botmem/cli build`
 *   - At least one user with an API key
 *
 * Set BOTMEM_E2E_API_KEY env var or the tests will create a user + key via the API.
 */

import { execSync, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_URL = process.env['BOTMEM_API_URL'] || 'http://localhost:12412/api';
const CLI_BIN = 'node ' + resolve(__dirname, '../../packages/cli/dist/cli.js');

let API_KEY = process.env['BOTMEM_E2E_API_KEY'] || '';

/** Run the CLI and return { stdout, stderr, exitCode }. Never throws. */
function cli(
  args: string,
  opts: { env?: Record<string, string>; expectFail?: boolean } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const envOverrides = opts.env ?? {};
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      BOTMEM_API_URL: API_URL,
      BOTMEM_API_KEY: API_KEY,
      NO_COLOR: '1', // Disable ANSI for easier assertions
      HOME: '/tmp/botmem-cli-e2e-home', // Avoid touching real config
      ...envOverrides,
    },
  };
  try {
    const stdout = execSync(`${CLI_BIN} ${args}`, execOpts);
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
      exitCode: err.status ?? 1,
    };
  }
}

/** Provision a test user + API key if none provided via env. */
async function ensureApiKey(): Promise<string> {
  if (API_KEY) return API_KEY;

  const email = `cli-e2e-${Date.now()}@test.botmem.xyz`;
  const password = 'TestPass123!';

  // Register
  const regRes = await fetch(`${API_URL}/user-auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'CLI E2E' }),
  });
  if (!regRes.ok) {
    throw new Error(`Register failed: ${regRes.status} ${await regRes.text()}`);
  }
  const regBody = await regRes.json();
  const token = regBody.accessToken;

  // Submit recovery key so encryption works
  if (regBody.recoveryKey) {
    await fetch(`${API_URL}/user-auth/recovery-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ recoveryKey: regBody.recoveryKey }),
    });
  }

  // Create API key
  const keyRes = await fetch(`${API_URL}/api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: 'cli-e2e-key' }),
  });
  if (!keyRes.ok) {
    throw new Error(`Create API key failed: ${keyRes.status} ${await keyRes.text()}`);
  }
  const keyBody = await keyRes.json();
  return keyBody.key;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  API_KEY = await ensureApiKey();
  // Create isolated home so config commands don't touch real ~/.botmem
  execSync('mkdir -p /tmp/botmem-cli-e2e-home', { encoding: 'utf-8' });
}, 30_000);

// ===========================================================================
// Tests
// ===========================================================================

describe('CLI E2E Tests', () => {
  // -------------------------------------------------------------------------
  // CLI-001: Help output
  // -------------------------------------------------------------------------
  it('CLI-001: shows help text with no arguments', () => {
    const { stdout, exitCode } = cli('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('botmem -- Query and manage your personal memory system');
    expect(stdout).toContain('COMMANDS');
    expect(stdout).toContain('search');
    expect(stdout).toContain('version');
  });

  // -------------------------------------------------------------------------
  // CLI-002: Help flag
  // -------------------------------------------------------------------------
  it('CLI-002: shows help with --help flag', () => {
    const { stdout, exitCode } = cli('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('GLOBAL OPTIONS');
  });

  // -------------------------------------------------------------------------
  // CLI-003: -h short flag
  // -------------------------------------------------------------------------
  it('CLI-003: shows help with -h flag', () => {
    const { stdout, exitCode } = cli('-h');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('botmem <command> [options]');
  });

  // -------------------------------------------------------------------------
  // CLI-004: Command-specific help
  // -------------------------------------------------------------------------
  it('CLI-004: shows command-specific help for search', () => {
    const { stdout, exitCode } = cli('search --help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('botmem search');
    expect(stdout).toContain('--connector');
    expect(stdout).toContain('--limit');
  });

  // -------------------------------------------------------------------------
  // CLI-005: Unknown command
  // -------------------------------------------------------------------------
  it('CLI-005: exits with error on unknown command', () => {
    const { stderr, exitCode } = cli('foobar');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown command: foobar');
  });

  // -------------------------------------------------------------------------
  // CLI-006: version command (JSON)
  // -------------------------------------------------------------------------
  it('CLI-006: version --json returns valid JSON with uptime', () => {
    const { stdout, exitCode } = cli('version --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('uptime');
    expect(data).toHaveProperty('gitHash');
    expect(typeof data.uptime).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CLI-007: version command (human)
  // -------------------------------------------------------------------------
  it('CLI-007: version shows human-readable output', () => {
    const { stdout, exitCode } = cli('version');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Botmem API');
    expect(stdout).toContain('Uptime:');
  });

  // -------------------------------------------------------------------------
  // CLI-008: status command (JSON)
  // -------------------------------------------------------------------------
  it('CLI-008: status --json returns stats, queues, and accounts', () => {
    const { stdout, exitCode } = cli('status --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('queues');
    expect(data).toHaveProperty('accounts');
    expect(data.stats).toHaveProperty('total');
    expect(typeof data.stats.total).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CLI-009: status command (human)
  // -------------------------------------------------------------------------
  it('CLI-009: status shows human-readable dashboard', () => {
    const { stdout, exitCode } = cli('status');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('BOTMEM STATUS');
    expect(stdout).toContain('Memories:');
  });

  // -------------------------------------------------------------------------
  // CLI-010: stats command (JSON)
  // -------------------------------------------------------------------------
  it('CLI-010: stats --json returns memory count breakdown', () => {
    const { stdout, exitCode } = cli('stats --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('bySource');
    expect(data).toHaveProperty('byConnector');
    expect(data).toHaveProperty('byFactuality');
  });

  // -------------------------------------------------------------------------
  // CLI-011: stats command (human)
  // -------------------------------------------------------------------------
  it('CLI-011: stats shows human-readable breakdown', () => {
    const { stdout, exitCode } = cli('stats');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Total:');
    expect(stdout).toContain('By Source:');
    expect(stdout).toContain('By Connector:');
  });

  // -------------------------------------------------------------------------
  // CLI-012: memories list (JSON)
  // -------------------------------------------------------------------------
  it('CLI-012: memories --json returns items and total', () => {
    const { stdout, exitCode } = cli('memories --json --limit 3');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // CLI-013: memories list (human)
  // -------------------------------------------------------------------------
  it('CLI-013: memories shows human-readable list', () => {
    const { stdout, exitCode } = cli('memories --limit 5');
    expect(exitCode).toBe(0);
    // Either shows memories or "No memories found."
    expect(stdout.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // CLI-014: memories with --source filter
  // -------------------------------------------------------------------------
  it('CLI-014: memories --source filters by source type', () => {
    const { stdout, exitCode } = cli('memories --json --source email --limit 5');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    for (const item of data.items) {
      expect(item.sourceType).toBe('email');
    }
  });

  // -------------------------------------------------------------------------
  // CLI-015: memories with --connector filter
  // -------------------------------------------------------------------------
  it('CLI-015: memories --connector filters by connector type', () => {
    const { stdout, exitCode } = cli('memories --json --connector gmail --limit 5');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    for (const item of data.items) {
      expect(item.connectorType).toBe('gmail');
    }
  });

  // -------------------------------------------------------------------------
  // CLI-016: search requires query
  // -------------------------------------------------------------------------
  it('CLI-016: search with no query exits with error', () => {
    const { stderr, exitCode } = cli('search');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('search requires a query');
  });

  // -------------------------------------------------------------------------
  // CLI-017: search with query (JSON)
  // -------------------------------------------------------------------------
  it('CLI-017: search --json returns items array', () => {
    const { stdout, exitCode } = cli('search "test" --json --limit 5');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-018: search with filters
  // -------------------------------------------------------------------------
  it('CLI-018: search respects --connector filter', () => {
    const { stdout, exitCode } = cli('search "hello" --json --connector gmail --limit 3');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    // If results returned, they should all be gmail
    for (const item of data.items) {
      expect(item.connectorType).toBe('gmail');
    }
  });

  // -------------------------------------------------------------------------
  // CLI-019: contacts list (JSON)
  // -------------------------------------------------------------------------
  it('CLI-019: contacts --json returns items and total', () => {
    const { stdout, exitCode } = cli('contacts --json --limit 5');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.items)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-020: contacts search requires query
  // -------------------------------------------------------------------------
  it('CLI-020: contacts search with no query exits with error', () => {
    const { stderr, exitCode } = cli('contacts search');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('contacts search requires a query');
  });

  // -------------------------------------------------------------------------
  // CLI-021: contacts search (JSON)
  // -------------------------------------------------------------------------
  it('CLI-021: contacts search --json returns array', () => {
    const { stdout, exitCode } = cli('contacts search "test" --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // CLI-022: jobs list (JSON)
  // -------------------------------------------------------------------------
  it('CLI-022: jobs --json returns jobs array', () => {
    const { stdout, exitCode } = cli('jobs --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('jobs');
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-023: accounts list (JSON)
  // -------------------------------------------------------------------------
  it('CLI-023: accounts --json returns accounts array', () => {
    const { stdout, exitCode } = cli('accounts --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('accounts');
    expect(Array.isArray(data.accounts)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-024: sync requires account ID
  // -------------------------------------------------------------------------
  it('CLI-024: sync with no account ID exits with error', () => {
    const { stderr, exitCode } = cli('sync');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('sync requires an account ID');
  });

  // -------------------------------------------------------------------------
  // CLI-025: retry command (JSON)
  // -------------------------------------------------------------------------
  it('CLI-025: retry --json returns jobs and memories retry counts', () => {
    // retry calls POST endpoints which require write scope.
    // API keys are read-only by default, so this may return a 403 error exit.
    const { stdout, stderr, exitCode } = cli('retry --json');
    if (exitCode === 0) {
      const data = JSON.parse(stdout);
      expect(data).toHaveProperty('jobs');
      expect(data).toHaveProperty('memories');
      expect(data.jobs).toHaveProperty('retried');
      expect(data.memories).toHaveProperty('enqueued');
    } else {
      // 403 Forbidden — API key lacks write scope (expected for read-only keys)
      expect(stderr + stdout).toMatch(/403|Forbidden|write/i);
    }
  });

  // -------------------------------------------------------------------------
  // CLI-026: timeline (JSON)
  // -------------------------------------------------------------------------
  it('CLI-026: timeline --json returns items and total', () => {
    const { stdout, exitCode } = cli('timeline --json --limit 5');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.items)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-027: timeline with date range
  // -------------------------------------------------------------------------
  it('CLI-027: timeline respects --from and --to', () => {
    const { stdout, exitCode } = cli(
      'timeline --json --from 2020-01-01 --to 2020-12-31 --limit 5',
    );
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('items');
    // All items should be within range (if any)
    for (const item of data.items) {
      const t = new Date(item.eventTime).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date('2020-01-01').getTime());
      expect(t).toBeLessThanOrEqual(new Date('2021-01-01').getTime());
    }
  });

  // -------------------------------------------------------------------------
  // CLI-028: entities search requires query
  // -------------------------------------------------------------------------
  it('CLI-028: entities search with no query exits with error', () => {
    const { stderr, exitCode } = cli('entities search');
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('entities search requires a query');
  });

  // -------------------------------------------------------------------------
  // CLI-029: entities search (JSON)
  // -------------------------------------------------------------------------
  it('CLI-029: entities search --json returns entities array', () => {
    const { stdout, exitCode } = cli('entities search "test" --json');
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toHaveProperty('entities');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.entities)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLI-030: config commands
  // -------------------------------------------------------------------------
  it('CLI-030: config show displays current configuration', () => {
    const { stdout, exitCode } = cli('config show');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Config:');
    expect(stdout).toContain('Host:');
  });
});
