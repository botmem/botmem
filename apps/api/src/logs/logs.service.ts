import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { dirname } from 'path';
import { ConfigService } from '../config/config.service';
import { TraceContext } from '../tracing/trace.context';

export const DEFAULT_LOGS_MAX_BYTES = 50 * 1024 * 1024;

function logsMaxBytes(): number {
  const parsed = Number.parseInt(process.env.LOGS_MAX_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOGS_MAX_BYTES;
}

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);
  private readonly maxBytes = logsMaxBytes();
  private currentBytes: number | undefined;
  private writeChain = Promise.resolve();

  constructor(
    private config: ConfigService,
    private traceContext: TraceContext,
  ) {}

  private get logsPath(): string {
    return this.config.logsPath;
  }

  private sanitizeMessage(message: string): string {
    try {
      // Remove null bytes and other invalid UTF-8 sequences
      // eslint-disable-next-line no-control-regex
      return message.replace(/\x00/g, '').replace(/[^\x20-\x7E\n\r\t]/g, '?');
    } catch {
      return message.slice(0, 1000);
    }
  }

  add(data: {
    jobId?: string;
    connectorType: string;
    accountId?: string;
    stage?: string;
    level: string;
    message: string;
  }): void {
    const trace = this.traceContext.current();
    const entry = {
      id: crypto.randomUUID(),
      jobId: data.jobId || null,
      connectorType: data.connectorType,
      accountId: data.accountId || null,
      stage: data.stage || null,
      level: data.level,
      message: this.sanitizeMessage(data.message),
      timestamp: new Date().toISOString(),
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
    };

    const line = JSON.stringify(entry) + '\n';
    const path = this.logsPath;

    process.stdout.write(line);

    const lineBytes = Buffer.byteLength(line, 'utf-8');
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        await this.rotateIfNeeded(path, lineBytes);
        await fs.appendFile(path, line, 'utf-8');
        this.currentBytes = (this.currentBytes ?? 0) + lineBytes;
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to write log entry: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private async rotateIfNeeded(path: string, incomingBytes: number): Promise<void> {
    if (this.currentBytes === undefined) {
      try {
        this.currentBytes = (await fs.stat(path)).size;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.logger.warn(
            `Failed to stat logs file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.currentBytes = 0;
      }
    }
    if (this.currentBytes + incomingBytes <= this.maxBytes) return;

    try {
      // ponytail: one rotated file caps app storage; add numbered generations only if ops needs them.
      await fs.rm(`${path}.1`, { force: true });
      await fs.rename(path, `${path}.1`);
      this.currentBytes = 0;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.currentBytes = 0;
        return;
      }
      this.logger.warn(
        `Failed to rotate logs file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async query(filters?: {
    jobId?: string;
    accountId?: string;
    level?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = filters?.limit || 50;
    const path = this.logsPath;

    // Read only the tail of the file to avoid V8 string size limits on large log files.
    // We read the last ~2MB which is enough for any reasonable query with pagination.
    const MAX_READ_BYTES = 2 * 1024 * 1024;
    let raw: string;
    try {
      const stat = await fs.stat(path);
      if (stat.size > MAX_READ_BYTES) {
        const fh = await fs.open(path, 'r');
        const buf = Buffer.alloc(MAX_READ_BYTES);
        await fh.read(buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
        await fh.close();
        // Drop the first partial line
        const text = buf.toString('utf-8');
        raw = text.slice(text.indexOf('\n') + 1);
      } else {
        raw = await fs.readFile(path, 'utf-8');
      }
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return { logs: [], total: 0 };
      }
      this.logger.error(
        `Failed to read logs file: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { logs: [], total: 0 };
    }

    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const entries: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed lines silently
      }
    }

    let results = entries;
    if (filters?.jobId) results = results.filter((e) => e.jobId === filters.jobId);
    if (filters?.accountId) results = results.filter((e) => e.accountId === filters.accountId);
    if (filters?.level) results = results.filter((e) => e.level === filters.level);

    results.sort((a, b) => {
      const ta = typeof a.timestamp === 'string' ? a.timestamp : '';
      const tb = typeof b.timestamp === 'string' ? b.timestamp : '';
      return tb.localeCompare(ta);
    });

    const total = results.length;
    const offset = filters?.offset || 0;
    results = results.slice(offset, offset + limit);

    return { logs: results, total };
  }
}
