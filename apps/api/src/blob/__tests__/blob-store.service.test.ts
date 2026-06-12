import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BlobStoreService } from '../blob-store.service';
import type { ConfigService } from '../../config/config.service';

describe('BlobStoreService', () => {
  it('round-trips content and dedups identical writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'botmem-blobs-'));
    try {
      const store = new BlobStoreService({ blobDir: dir } as ConfigService);
      const buffer = Buffer.from('same bytes');

      const first = await store.put(buffer, 'text/plain');
      const second = await store.put(buffer, 'text/plain');

      expect(second).toEqual(first);
      expect(await store.has(first.ref)).toBe(true);
      expect(await store.get(first.ref)).toEqual(buffer);
      expect(await readdir(join(dir, first.sha256.slice(0, 2)))).toEqual([first.sha256]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
