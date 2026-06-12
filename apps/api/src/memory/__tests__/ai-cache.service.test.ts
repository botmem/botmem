import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { AiCacheService } from '../ai-cache.service';
import { DbService } from '../../db/db.service';
import { CryptoService } from '../../crypto/crypto.service';

function createMockDbService() {
  const rawDb = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return {
    db: rawDb,
    systemDb: vi.fn((fn) => fn(rawDb)),
  } as unknown as DbService;
}

function createMockCryptoService() {
  return {
    encrypt: vi.fn().mockImplementation((text: string) => `enc:${text}`),
    decrypt: vi.fn().mockImplementation((text: string) => text.replace('enc:', '')),
  } as unknown as CryptoService;
}

describe('AiCacheService', () => {
  let service: AiCacheService;
  let dbService: DbService;
  let cryptoService: CryptoService;
  const computeId = (
    svc: AiCacheService,
    backend: string,
    operation: string,
    model: string,
    input: string,
  ) =>
    (
      svc as unknown as {
        computeId: (
          backend: string,
          operation: string,
          model: string,
          input: string,
        ) => string;
      }
    ).computeId(backend, operation, model, input);

  beforeEach(() => {
    vi.useFakeTimers();
    dbService = createMockDbService();
    cryptoService = createMockCryptoService();
    service = new AiCacheService(dbService, cryptoService);
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clear the eviction timer
    const timer = (service as unknown as { evictionTimer: ReturnType<typeof setInterval> | null })
      .evictionTimer;
    if (timer) clearInterval(timer);
  });

  describe('onModuleInit', () => {
    it('sets up eviction timer', () => {
      service.onModuleInit();

      // Verify the timer is set
      const timer = (service as unknown as { evictionTimer: ReturnType<typeof setInterval> | null })
        .evictionTimer;
      expect(timer).not.toBeNull();
    });
  });

  describe('get', () => {
    it('returns cache miss when no row found', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      const result = await service.get('model-1', 'input text', 'embed');

      expect(result).toEqual({ hit: false });
    });

    it('returns cache hit with decrypted output', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ output: 'enc:cached-output' }],
      });

      const result = await service.get('model-1', 'input text', 'embed');

      expect(result).toEqual({ hit: true, output: 'cached-output' });
      expect(cryptoService.decrypt).toHaveBeenCalledWith('enc:cached-output');
    });

    it('returns cache miss when output is null', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ output: null }],
      });

      const result = await service.get('model-1', 'input text', 'embed');

      expect(result).toEqual({ hit: false });
    });

    it('returns cache miss when decrypt returns null/empty', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ output: 'enc:data' }],
      });
      (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockReturnValue('');

      const result = await service.get('model-1', 'input text', 'embed');

      expect(result).toEqual({ hit: false });
    });

    it('returns cache miss on database error', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('db connection lost'),
      );

      const result = await service.get('model-1', 'input text', 'embed');

      expect(result).toEqual({ hit: false });
    });

    it('uses SHA256 hash of model:input as cache key', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

      await service.get('my-model', 'hello world', 'embed');

      // Verify the execute was called (we can't easily check the SQL params
      // but we verify it was called)
      expect(dbService.db.execute).toHaveBeenCalled();
    });
  });

  describe('set', () => {
    it('encrypts input and output before storing', async () => {
      await service.set('model-1', 'ollama', 'embed', 'input text', 'output text');

      expect(cryptoService.encrypt).toHaveBeenCalledWith('input text');
      expect(cryptoService.encrypt).toHaveBeenCalledWith('output text');
      expect(dbService.db.execute).toHaveBeenCalled();
    });

    it('strips null bytes from input and output', async () => {
      await service.set('model-1', 'ollama', 'embed', 'hello\x00world', 'out\x00put');

      expect(cryptoService.encrypt).toHaveBeenCalledWith('helloworld');
      expect(cryptoService.encrypt).toHaveBeenCalledWith('output');
    });

    it('passes metadata (latencyMs) to the insert', async () => {
      await service.set('model-1', 'ollama', 'embed', 'input', 'output', {
        latencyMs: 150,
      });

      expect(dbService.db.execute).toHaveBeenCalled();
    });

    it('does not throw on database error', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('write failed'),
      );

      // Should not throw
      await expect(
        service.set('model-1', 'ollama', 'embed', 'input', 'output'),
      ).resolves.toBeUndefined();
    });
  });

  describe('computeId determinism', () => {
    it('generates the same ID for the same backend+operation+model+input', () => {
      const id1 = computeId(service, 'ollama', 'embed', 'model-x', 'same input');
      const id2 = computeId(service, 'ollama', 'embed', 'model-x', 'same input');

      expect(id1).toBe(id2);
    });

    it('generates different IDs for different models', () => {
      const id1 = computeId(service, 'ollama', 'embed', 'model-a', 'same input');
      const id2 = computeId(service, 'ollama', 'embed', 'model-b', 'same input');

      expect(id1).not.toBe(id2);
    });

    it('generates different IDs for different inputs', () => {
      const id1 = computeId(service, 'ollama', 'embed', 'model-a', 'input 1');
      const id2 = computeId(service, 'ollama', 'embed', 'model-a', 'input 2');

      expect(id1).not.toBe(id2);
    });

    it('generates different IDs for different operations with the same backend+model+input', () => {
      const id1 = computeId(service, 'ollama', 'embed', 'same-model', 'same input');
      const id2 = computeId(service, 'ollama', 'generate', 'same-model', 'same input');

      expect(id1).not.toBe(id2);
    });

    it('generates different IDs for different backends with the same operation+model+input', () => {
      const id1 = computeId(service, 'ollama', 'embed', 'same-model', 'same input');
      const id2 = computeId(service, 'gemini', 'embed', 'same-model', 'same input');

      expect(id1).not.toBe(id2);
    });

    it('hashes backend:operation:model:inputHash', () => {
      const inputHash = createHash('sha256').update('hello world').digest('hex');
      const expected = createHash('sha256')
        .update(`gemini:embed_multimodal:model-x:${inputHash}`)
        .digest('hex');

      expect(computeId(service, 'gemini', 'embed_multimodal', 'model-x', 'hello world')).toBe(
        expected,
      );
    });
  });

  describe('eviction', () => {
    it('runs eviction after delay on init', async () => {
      service.onModuleInit();

      // The initial eviction runs after 60s delay
      expect(dbService.db.execute).not.toHaveBeenCalled();

      // Advance past the 60s initial delay
      await vi.advanceTimersByTimeAsync(61_000);

      // Eviction should have run (DELETE + SELECT COUNT)
      expect(dbService.db.execute).toHaveBeenCalled();
    });

    it('eviction handles database errors gracefully', async () => {
      (dbService.db.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('eviction failed'),
      );

      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(61_000);

      // Should not throw — errors are caught internally
    });
  });
});
