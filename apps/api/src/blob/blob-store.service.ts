import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { ConfigService } from '../config/config.service';

export interface BlobPutResult {
  ref: string;
  size: number;
  sha256: string;
}

@Injectable()
export class BlobStoreService {
  constructor(private config: ConfigService) {}

  async put(buffer: Buffer, _mime?: string): Promise<BlobPutResult> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const file = this.pathForRef(`sha256:${sha256}`);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, buffer, { flag: 'wx' });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { ref: `sha256:${sha256}`, size: buffer.length, sha256 };
  }

  async get(ref: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathForRef(ref));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(ref: string): Promise<boolean> {
    try {
      await stat(this.pathForRef(ref));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  private pathForRef(ref: string): string {
    const match = /^sha256:([a-f0-9]{64})$/.exec(ref);
    if (!match) throw new Error('Invalid blob ref');
    const sha = match[1];
    return join(this.config.blobDir, sha.slice(0, 2), sha);
  }
}
