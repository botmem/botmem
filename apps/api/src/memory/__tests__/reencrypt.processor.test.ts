import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeWorkerProperty(processor: Record<string, unknown>) {
  Object.defineProperty(processor, 'worker', {
    value: { on: vi.fn(), concurrency: 1 },
    writable: true,
    configurable: true,
  });
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      userId: 'user-1',
      oldKey: Buffer.from('old-key-32-bytes-padding-1234567').toString('base64'),
      newKey: Buffer.from('new-key-32-bytes-padding-1234567').toString('base64'),
      newKeyVersion: 2,
      ...overrides,
    },
    updateProgress: vi.fn(),
  };
}

function makeCrypto() {
  return {
    isEncrypted: vi.fn().mockReturnValue(true),
    decrypt: vi.fn().mockImplementation((v: string) => `dec-app-${v}`),
    decryptWithKey: vi.fn().mockImplementation((v: string) => `dec-user-${v}`),
    encryptWithKey: vi.fn().mockImplementation((v: string) => `enc-new-${v}`),
  };
}

// Helper to build a mock DB that returns specific sequences of results for select queries
function makeDb(banks: unknown[], countRows: unknown[], batchRows: unknown[]) {
  let selectCall = 0;
  const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCall++;
            if (selectCall === 1) return Promise.resolve(banks);
            if (selectCall === 2) return Promise.resolve(countRows);
            if (selectCall === 3) return { limit: vi.fn().mockResolvedValue(batchRows) };
            return { limit: vi.fn().mockResolvedValue([]) };
          }),
        }),
      }),
      update: updateFn,
    },
    updateFn,
    updateSet,
  };
}

describe('ReencryptProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrypts with old user key for keyVersion>=1 and encrypts with new key', async () => {
    const { ReencryptProcessor } = await import('../reencrypt.processor');
    const crypto = makeCrypto();
    const mem1 = {
      id: 'mem-1',
      text: 't1',
      entities: 'e1',
      claims: 'c1',
      metadata: 'm1',
      keyVersion: 1,
      memoryBankId: 'b1',
    };
    const { db, updateFn } = makeDb([{ id: 'b1' }], [mem1], [mem1]);
    const processor = new (ReencryptProcessor as unknown as new (...args: unknown[]) => {
      process: (job: unknown) => Promise<void>;
      worker: unknown;
    })({ db }, crypto);
    makeWorkerProperty(processor);

    await processor.process(makeJob());

    expect(crypto.decryptWithKey).toHaveBeenCalledWith('t1', expect.any(Buffer));
    expect(crypto.encryptWithKey).toHaveBeenCalled();
    expect(updateFn).toHaveBeenCalled();
  });

  it('decrypts with APP_SECRET for keyVersion=0 (legacy)', async () => {
    const { ReencryptProcessor } = await import('../reencrypt.processor');
    const crypto = makeCrypto();
    const mem0 = {
      id: 'mem-0',
      text: 't0',
      entities: 'e0',
      claims: 'c0',
      metadata: 'm0',
      keyVersion: 0,
      memoryBankId: 'b1',
    };
    const { db } = makeDb([{ id: 'b1' }], [mem0], [mem0]);
    const processor = new (ReencryptProcessor as unknown as new (...args: unknown[]) => {
      process: (job: unknown) => Promise<void>;
      worker: unknown;
    })({ db }, crypto);
    makeWorkerProperty(processor);

    await processor.process(makeJob());

    expect(crypto.decrypt).toHaveBeenCalledWith('t0');
    expect(crypto.encryptWithKey).toHaveBeenCalled();
  });

  it('handles per-row errors without aborting batch', async () => {
    const { ReencryptProcessor } = await import('../reencrypt.processor');
    const crypto = {
      ...makeCrypto(),
      decryptWithKey: vi.fn().mockImplementation(() => {
        throw new Error('bad');
      }),
    };
    const mem = {
      id: 'mem-err',
      text: 't',
      entities: 'e',
      claims: 'c',
      metadata: 'm',
      keyVersion: 1,
      memoryBankId: 'b1',
    };
    const { db, updateFn } = makeDb([{ id: 'b1' }], [mem], [mem]);
    const processor = new (ReencryptProcessor as unknown as new (...args: unknown[]) => {
      process: (job: unknown) => Promise<void>;
      worker: unknown;
    })({ db }, crypto);
    makeWorkerProperty(processor);

    // Should not throw
    await expect(processor.process(makeJob())).resolves.not.toThrow();
    // Should still update keyVersion to avoid infinite loop
    expect(updateFn).toHaveBeenCalled();
  });

  it('reports progress via job.updateProgress', async () => {
    const { ReencryptProcessor } = await import('../reencrypt.processor');
    const crypto = makeCrypto();
    const mem = {
      id: 'mem-p',
      text: 't',
      entities: 'e',
      claims: 'c',
      metadata: 'm',
      keyVersion: 1,
      memoryBankId: 'b1',
    };
    const { db } = makeDb([{ id: 'b1' }], [mem], [mem]);
    const processor = new (ReencryptProcessor as unknown as new (...args: unknown[]) => {
      process: (job: unknown) => Promise<void>;
      worker: unknown;
    })({ db }, crypto);
    makeWorkerProperty(processor);

    const job = makeJob();
    await processor.process(job);

    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ processed: expect.any(Number), total: expect.any(Number) }),
    );
  });

  it('handles no memory banks gracefully', async () => {
    const { ReencryptProcessor } = await import('../reencrypt.processor');
    const crypto = makeCrypto();
    const { db } = makeDb([], [], []);
    const processor = new (ReencryptProcessor as unknown as new (...args: unknown[]) => {
      process: (job: unknown) => Promise<void>;
      worker: unknown;
    })({ db }, crypto);
    makeWorkerProperty(processor);

    const job = makeJob();
    await processor.process(job);

    expect(job.updateProgress).not.toHaveBeenCalled();
  });
});
