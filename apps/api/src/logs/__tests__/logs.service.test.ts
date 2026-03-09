import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import { LogsService } from '../logs.service';
import { ConfigService } from '../../config/config.service';

function makeTmpPath() {
  return os.tmpdir() + '/test-logs-' + Date.now() + '.ndjson';
}

function makeService(logsPath: string): LogsService {
  const config = { logsPath } as unknown as ConfigService;
  return new LogsService(config);
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
    // do NOT push to paths — no file to delete
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
});
