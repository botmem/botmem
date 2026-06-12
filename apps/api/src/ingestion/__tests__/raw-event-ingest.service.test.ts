import { describe, expect, it, vi } from 'vitest';
import { RawEventIngestService } from '../raw-event-ingest.service';
import type { DbService } from '../../db/db.service';
import type { CryptoService } from '../../crypto/crypto.service';
import type { Queue } from 'bullmq';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BlobStoreService } from '../../blob/blob-store.service';
import type { ConfigService } from '../../config/config.service';

function insertChain(returning: Array<{ id: string }>) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  };
}

describe('RawEventIngestService', () => {
  it('persists a raw event through user scope and enqueues memory processing', async () => {
    const scopedDb = { insert: vi.fn().mockReturnValue(insertChain([{ id: 'raw-1' }])) };
    const dbService = {
      db: { insert: vi.fn() },
      withUserId: vi.fn((_userId: string, fn: (db: typeof scopedDb) => unknown) => fn(scopedDb)),
    } as unknown as DbService;
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
    } as unknown as CryptoService;
    const queue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const blobStore = { put: vi.fn() } as unknown as BlobStoreService;
    const service = new RawEventIngestService(dbService, crypto, queue, blobStore);

    const result = await service.ingest({
      accountId: 'acc-1',
      connectorType: 'gmail',
      userId: 'user-1',
      jobId: 'job-1',
      trace: { traceId: 'trace-1', spanId: 'span-1' },
      event: {
        sourceType: 'email',
        sourceId: 'msg-1',
        timestamp: '2026-05-04T08:00:00.000Z',
        content: { text: 'hello', metadata: {} },
      },
    });

    expect(result.inserted).toBe(true);
    expect(dbService.withUserId).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({
        rawEventId: result.rawEventId,
        _trace: { traceId: 'trace-1', spanId: 'span-1' },
      }),
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
    );
  });

  it('does not enqueue duplicate raw events', async () => {
    const dbService = {
      db: { insert: vi.fn().mockReturnValue(insertChain([])) },
    } as unknown as DbService;
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
    } as unknown as CryptoService;
    const queue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const blobStore = { put: vi.fn() } as unknown as BlobStoreService;
    const service = new RawEventIngestService(dbService, crypto, queue, blobStore);

    const result = await service.ingest({
      accountId: 'acc-1',
      connectorType: 'gmail',
      event: {
        sourceType: 'email',
        sourceId: 'msg-1',
        timestamp: '2026-05-04T08:00:00.000Z',
        content: { text: 'hello', metadata: {} },
      },
    });

    expect(result.inserted).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stores canonical connector types', async () => {
    const chain = insertChain([{ id: 'raw-1' }]);
    const dbService = {
      db: { insert: vi.fn().mockReturnValue(chain) },
    } as unknown as DbService;
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
    } as unknown as CryptoService;
    const queue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
    const blobStore = { put: vi.fn() } as unknown as BlobStoreService;
    const service = new RawEventIngestService(dbService, crypto, queue, blobStore);

    await service.ingest({
      accountId: 'acc-1',
      connectorType: 'photos-immich',
      event: {
        sourceType: 'photo',
        sourceId: 'photo-1',
        timestamp: '2026-05-04T08:00:00.000Z',
        content: { text: 'photo', metadata: {} },
      },
    });

    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ connectorType: 'photos' }));
  });

  it('offloads fileBase64 before encrypting raw events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmem-ingest-blobs-'));
    try {
      const chain = insertChain([{ id: 'raw-1' }]);
      const dbService = {
        db: { insert: vi.fn().mockReturnValue(chain) },
      } as unknown as DbService;
      const encrypt = vi.fn((value: string) => `enc:${value}`);
      const crypto = { encrypt } as unknown as CryptoService;
      const queue = { add: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;
      const blobStore = new BlobStoreService({ blobDir: dir } as ConfigService);
      const service = new RawEventIngestService(dbService, crypto, queue, blobStore);

      await service.ingest({
        accountId: 'acc-1',
        connectorType: 'whatsapp',
        event: {
          sourceType: 'message',
          sourceId: 'wa-1',
          timestamp: '2026-05-04T08:00:00.000Z',
          content: {
            text: 'photo',
            metadata: {
              fileBase64: Buffer.from('image bytes').toString('base64'),
              mimetype: 'image/jpeg',
              fileName: 'photo.jpg',
            },
          },
        },
      });

      const encryptedPayload = encrypt.mock.calls[0][0];
      const storedEvent = JSON.parse(encryptedPayload);
      const metadata = storedEvent.content.metadata;

      expect(metadata.fileBase64).toBeUndefined();
      expect(metadata).toMatchObject({
        blobRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        mime: 'image/jpeg',
        fileName: 'photo.jpg',
        size: 11,
      });
      expect((await blobStore.get(metadata.blobRef))?.toString()).toBe('image bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
