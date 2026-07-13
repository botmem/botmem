import { describe, expect, it } from 'vitest';
import { parseProjectionWorkerConfig, ProjectionWorkerConfigError } from './composition.js';

const base = {
  NODE_ENV: 'test',
  PROJECTION_WORKER_ID: 'projection-worker-1',
  DISPATCHER_DATABASE_URL: 'postgresql://dispatcher_login:secret@localhost/botmem',
  WORKER_DATABASE_URL: 'postgresql://worker_login:secret@localhost/botmem',
  OPENAI_API_KEY: 'sk-1234567890_abcdefgh',
};

describe('projection worker runtime configuration', () => {
  it('requires separate dispatcher and worker login URLs', () => {
    const config = parseProjectionWorkerConfig(base);
    expect(config.dispatcherDatabaseUrl).toContain('dispatcher_login');
    expect(config.workerDatabaseUrl).toContain('worker_login');
    expect(config.leaseMs - config.taskTimeoutMs).toBeGreaterThanOrEqual(5_000);

    expect(() =>
      parseProjectionWorkerConfig({
        ...base,
        WORKER_DATABASE_URL: base.DISPATCHER_DATABASE_URL,
      }),
    ).toThrow(ProjectionWorkerConfigError);
  });

  it('rejects plaintext or loopback production database authorities', () => {
    expect(() => parseProjectionWorkerConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      ProjectionWorkerConfigError,
    );
    expect(() =>
      parseProjectionWorkerConfig({
        ...base,
        NODE_ENV: 'production',
        DISPATCHER_DATABASE_URL:
          'postgresql://dispatcher:secret@db.example.invalid/botmem?sslmode=verify-full',
        WORKER_DATABASE_URL: 'postgresql://worker:secret@db.example.invalid/botmem',
      }),
    ).toThrow(ProjectionWorkerConfigError);
  });

  it('never includes a malformed secret-bearing URL in its error', () => {
    try {
      parseProjectionWorkerConfig({
        ...base,
        DISPATCHER_DATABASE_URL: 'not a URL super-secret',
      });
      throw new Error('expected parse to fail');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
      expect(String(error)).toContain('DISPATCHER_DATABASE_URL');
    }
  });
});
