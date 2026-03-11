import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import { LogsService } from '../logs.service';
import { ConfigService } from '../../config/config.service';

function makeTmpPath() {
  return (
    os.tmpdir() + '/test-logs-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ndjson'
  );
}

function makeService(logsPath: string): LogsService {
  const config = { logsPath } as unknown as ConfigService;
  const traceContext = { current: () => undefined } as unknown as { current: () => undefined };
  return new LogsService(config, traceContext);
}

describe('LogsService', () => {
  const paths: string[] = [];

  afterEach(async () => {
    for (const p of paths) {
      try {
        await fs.unlink(p);
      } catch {
        // file may not exist
      }
    }
    paths.length = 0;
  });

  it('add() followed by query() returns the added entry', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({
      jobId: 'job-1',
      connectorType: 'gmail',
      accountId: 'acc-1',
      stage: 'sync',
      level: 'info',
      message: 'Hello test',
    });

    // Give fire-and-forget a tick to write
    await new Promise((r) => setTimeout(r, 50));

    const result = await service.query({ jobId: 'job-1' });
    expect(result.logs).toHaveLength(1);
    const entry = result.logs[0] as Record<string, unknown>;
    expect(entry.jobId).toBe('job-1');
    expect(entry.connectorType).toBe('gmail');
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('Hello test');
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('query() with non-existent file returns empty array', async () => {
    const path = makeTmpPath();
    const service = makeService(path);

    const result = await service.query({ jobId: 'nonexistent' });
    expect(result.logs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by level', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({ connectorType: 'gmail', level: 'info', message: 'info msg' });
    service.add({ connectorType: 'gmail', level: 'error', message: 'error msg' });

    await new Promise((r) => setTimeout(r, 50));

    const errors = await service.query({ level: 'error' });
    expect(errors.logs).toHaveLength(1);
    expect((errors.logs[0] as Record<string, unknown>).level).toBe('error');
  });

  it('filters by accountId', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({ connectorType: 'gmail', accountId: 'acc-1', level: 'info', message: 'a' });
    service.add({ connectorType: 'gmail', accountId: 'acc-2', level: 'info', message: 'b' });

    await new Promise((r) => setTimeout(r, 50));

    const result = await service.query({ accountId: 'acc-1' });
    expect(result.logs).toHaveLength(1);
    expect((result.logs[0] as Record<string, unknown>).accountId).toBe('acc-1');
  });

  it('sanitizes null bytes from messages', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({ connectorType: 'gmail', level: 'info', message: 'Bad\x00message' });
    await new Promise((r) => setTimeout(r, 50));

    const result = await service.query();
    expect(result.logs).toHaveLength(1);
    expect((result.logs[0] as Record<string, unknown>).message).not.toContain('\x00');
  });

  it('applies limit and offset', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    for (let i = 0; i < 10; i++) {
      service.add({ connectorType: 'gmail', level: 'info', message: `msg-${i}` });
    }
    await new Promise((r) => setTimeout(r, 100));

    const result = await service.query({ limit: 3, offset: 2 });
    expect(result.logs).toHaveLength(3);
    expect(result.total).toBe(10);
  });

  it('sorts by timestamp descending', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({ connectorType: 'gmail', level: 'info', message: 'first' });
    await new Promise((r) => setTimeout(r, 20));
    service.add({ connectorType: 'gmail', level: 'info', message: 'second' });
    await new Promise((r) => setTimeout(r, 50));

    const result = await service.query();
    expect(result.logs).toHaveLength(2);
    expect((result.logs[0] as Record<string, unknown>).message).toBe('second');
  });

  it('handles multiple add() calls without optional fields', async () => {
    const path = makeTmpPath();
    paths.push(path);
    const service = makeService(path);

    service.add({ connectorType: 'gmail', level: 'info', message: 'bare minimum' });
    await new Promise((r) => setTimeout(r, 50));

    const result = await service.query();
    expect(result.logs).toHaveLength(1);
    const entry = result.logs[0] as Record<string, unknown>;
    expect(entry.jobId).toBeNull();
    expect(entry.accountId).toBeNull();
    expect(entry.stage).toBeNull();
  });
});
