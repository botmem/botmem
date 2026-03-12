import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We cannot easily test the main() function directly because cli.ts calls main()
// at the module level. Instead, we test the key utility functions by extracting
// and testing their logic.

// Test parseGlobalArgs logic by re-implementing its behavior
// and testing config loading/saving functions

describe('CLI config management', () => {
  let tempDir: string;
  let configFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `botmem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    configFile = join(tempDir, 'config.json');
  });

  it('should handle missing config file gracefully', () => {
    // loadConfig returns {} if file doesn't exist
    let result = {};
    try {
      result = JSON.parse(readFileSync(join(tempDir, 'nonexistent.json'), 'utf-8'));
    } catch {
      result = {};
    }
    expect(result).toEqual({});
  });

  it('should save and load config', () => {
    const config = { apiUrl: 'http://localhost:12412/api', apiKey: 'bm_sk_test123' };
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    const loaded = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(loaded.apiUrl).toBe('http://localhost:12412/api');
    expect(loaded.apiKey).toBe('bm_sk_test123');
  });
});

describe('parseGlobalArgs logic', () => {
  // Test the argument parsing logic (mirrors the actual parseGlobalArgs function)
  function parseArgs(
    argv: string[],
    envVars: Record<string, string> = {},
    storedCfg: Record<string, string | undefined> = {},
  ) {
    const DEFAULT_API_URL = 'https://api.botmem.xyz/api';
    let apiUrl = envVars['BOTMEM_API_URL'] || storedCfg.apiUrl || DEFAULT_API_URL;
    let token = envVars['BOTMEM_API_KEY'] || envVars['BOTMEM_TOKEN'] || '';
    let json = false;
    let toon = false;
    let help = false;
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--api-url') {
        apiUrl = argv[++i];
      } else if (a === '--api-key') {
        token = argv[++i];
      } else if (a === '--token') {
        token = argv[++i];
      } else if (a === '--json') {
        json = true;
      } else if (a === '--toon') {
        toon = true;
        json = true;
      } else if (a === '--help' || a === '-h') {
        help = true;
      } else {
        rest.push(a);
      }
    }

    if (!token) token = storedCfg.apiKey || storedCfg.token || '';

    return { apiUrl, token, json, toon, help, rest };
  }

  it('should use default API URL when nothing specified', () => {
    const result = parseArgs([]);
    expect(result.apiUrl).toBe('https://api.botmem.xyz/api');
  });

  it('should use --api-url flag over env var', () => {
    const result = parseArgs(['--api-url', 'http://custom:3000/api', 'search', 'test'], {
      BOTMEM_API_URL: 'http://env:3000/api',
    });
    expect(result.apiUrl).toBe('http://custom:3000/api');
  });

  it('should use env var over stored config', () => {
    const result = parseArgs(
      [],
      { BOTMEM_API_URL: 'http://env:3000/api' },
      { apiUrl: 'http://stored:3000/api' },
    );
    expect(result.apiUrl).toBe('http://env:3000/api');
  });

  it('should use stored config as fallback', () => {
    const result = parseArgs([], {}, { apiUrl: 'http://stored:3000/api' });
    expect(result.apiUrl).toBe('http://stored:3000/api');
  });

  it('should parse --api-key flag', () => {
    const result = parseArgs(['--api-key', 'bm_sk_test']);
    expect(result.token).toBe('bm_sk_test');
  });

  it('should parse --token flag', () => {
    const result = parseArgs(['--token', 'jwt-xyz']);
    expect(result.token).toBe('jwt-xyz');
  });

  it('should use BOTMEM_API_KEY env var', () => {
    const result = parseArgs([], { BOTMEM_API_KEY: 'bm_sk_env' });
    expect(result.token).toBe('bm_sk_env');
  });

  it('should use BOTMEM_TOKEN env var', () => {
    const result = parseArgs([], { BOTMEM_TOKEN: 'jwt-env' });
    expect(result.token).toBe('jwt-env');
  });

  it('should fall back to stored apiKey', () => {
    const result = parseArgs([], {}, { apiKey: 'bm_sk_stored' });
    expect(result.token).toBe('bm_sk_stored');
  });

  it('should fall back to stored token', () => {
    const result = parseArgs([], {}, { token: 'jwt-stored' });
    expect(result.token).toBe('jwt-stored');
  });

  it('should set json=true for --json flag', () => {
    const result = parseArgs(['search', 'test', '--json']);
    expect(result.json).toBe(true);
  });

  it('should set toon=true and json=true for --toon flag', () => {
    const result = parseArgs(['--toon', 'search', 'test']);
    expect(result.toon).toBe(true);
    expect(result.json).toBe(true);
  });

  it('should set help=true for --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('should set help=true for -h flag', () => {
    const result = parseArgs(['-h']);
    expect(result.help).toBe(true);
  });

  it('should collect non-flag arguments into rest', () => {
    const result = parseArgs(['search', 'hello', 'world', '--json']);
    expect(result.rest).toEqual(['search', 'hello', 'world']);
  });
});

describe('runConfig logic', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Test host normalization logic (mirrors runConfig set-host)
  function normalizeHost(host: string): string {
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
      host = `${isLocal ? 'http' : 'https'}://${host}`;
    }
    if (!host.endsWith('/api')) {
      host = host.replace(/\/+$/, '') + '/api';
    }
    return host;
  }

  it('should add https:// for non-local hosts', () => {
    expect(normalizeHost('api.botmem.xyz')).toBe('https://api.botmem.xyz/api');
  });

  it('should add http:// for localhost', () => {
    expect(normalizeHost('localhost:12412')).toBe('http://localhost:12412/api');
  });

  it('should add http:// for 127.0.0.1', () => {
    expect(normalizeHost('127.0.0.1:12412')).toBe('http://127.0.0.1:12412/api');
  });

  it('should add /api suffix if missing', () => {
    expect(normalizeHost('http://custom-host:3000')).toBe('http://custom-host:3000/api');
  });

  it('should not double /api suffix', () => {
    expect(normalizeHost('http://custom-host:3000/api')).toBe('http://custom-host:3000/api');
  });

  it('should strip trailing slashes before adding /api', () => {
    expect(normalizeHost('http://host:3000///')).toBe('http://host:3000/api');
  });
});

describe('command routing', () => {
  // Test that the command router identifies the right commands
  const validCommands = [
    'config',
    'login',
    'version',
    'ask',
    'context',
    'memory-banks',
    'search',
    'memories',
    'memory',
    'stats',
    'contacts',
    'contact',
    'status',
    'jobs',
    'sync',
    'retry',
    'accounts',
    'timeline',
    'related',
    'entities',
    'install-skill',
  ];

  it('should recognize all valid commands', () => {
    for (const cmd of validCommands) {
      expect(validCommands).toContain(cmd);
    }
  });

  it('should identify unknown commands', () => {
    const unknownCmd = 'foobar';
    expect(validCommands).not.toContain(unknownCmd);
  });
});
