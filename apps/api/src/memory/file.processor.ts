import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AccountsService } from '../accounts/accounts.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { LogsService } from '../logs/logs.service';
import { EventsService } from '../events/events.service';
import { memories } from '../db/schema';
import { photoDescriptionPrompt } from './prompts';

const MAX_CONTENT_LENGTH = 10_000;
const TRUNCATION_SUFFIX = '\n\n---\n*[Truncated]*';

@Processor('file')
export class FileProcessor extends WorkerHost {
  private collectionReady = false;

  constructor(
    private dbService: DbService,
    private accountsService: AccountsService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    @InjectQueue('enrich') private enrichQueue: Queue,
    private logsService: LogsService,
    private events: EventsService,
  ) {
    super();
  }

  async process(job: Job<{ memoryId: string }>) {
    const { memoryId } = job.data;
    const mid = memoryId.slice(0, 8);

    // 1. Read memory record
    const rows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));

    if (!rows.length) return;
    const memory = rows[0];

    const metadata = JSON.parse(memory.metadata || '{}');
    const fileUrl: string | undefined = metadata.fileUrl;
    const mimetype: string | undefined = metadata.mimetype;
    const fileName: string | undefined = metadata.fileName;

    if (!fileUrl) {
      this.addLog(memory.connectorType, memory.accountId, 'warn',
        `[file:skip] ${mid} — no fileUrl in metadata`);
      return;
    }

    this.addLog(memory.connectorType, memory.accountId, 'info',
      `[file:start] ${mid} "${fileName || 'unknown'}" (${mimetype || 'unknown'})`);

    const pipelineStart = Date.now();

    try {
      // 2. Get auth headers from account
      const headers = await this.buildAuthHeaders(memory.accountId, memory.connectorType);

      // 3. Download file
      let t0 = Date.now();
      const res = await fetch(fileUrl, { headers });
      if (!res.ok) {
        throw new Error(`File download failed: ${res.status} ${res.statusText}`);
      }
      const downloadMs = Date.now() - t0;

      // 4. Route by MIME type and extract content
      t0 = Date.now();
      let content = await this.extractContent(res, mimetype, fileName, memory);
      const extractMs = Date.now() - t0;

      if (!content) {
        this.addLog(memory.connectorType, memory.accountId, 'warn',
          `[file:skip] ${mid} — unsupported type "${mimetype || fileName || 'unknown'}"`);
        return;
      }

      // 5. Truncate if necessary
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      }

      // 6. Update memory text with extracted content
      const updatedText = memory.text
        ? `${memory.text}\n\n${content}`
        : content;

      await this.dbService.db
        .update(memories)
        .set({ text: updatedText })
        .where(eq(memories.id, memoryId));

      // 7. Re-embed
      t0 = Date.now();
      const vector = await this.ollama.embed(updatedText);
      const embedMs = Date.now() - t0;

      if (!this.collectionReady) {
        await this.qdrant.ensureCollection(vector.length);
        this.collectionReady = true;
      }

      t0 = Date.now();
      await this.qdrant.upsert(memoryId, vector, {
        source_type: memory.sourceType,
        connector_type: memory.connectorType,
        event_time: memory.eventTime,
        account_id: memory.accountId,
      });
      const qdrantMs = Date.now() - t0;

      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, memoryId));

      // 8. Enqueue enrichment
      await this.enrichQueue.add(
        'enrich',
        { memoryId },
        { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
      );

      const totalMs = Date.now() - pipelineStart;
      this.addLog(memory.connectorType, memory.accountId, 'info',
        `[file:done] ${mid} in ${totalMs}ms — download=${downloadMs}ms extract=${extractMs}ms(${content.length} chars) embed=${embedMs}ms qdrant=${qdrantMs}ms`);

      // 9. Emit real-time event
      this.events.emitToChannel('memories', 'memory:updated', {
        memoryId,
        sourceType: memory.sourceType,
        connectorType: memory.connectorType,
        text: updatedText.slice(0, 100),
      });
    } catch (err: any) {
      const totalMs = Date.now() - pipelineStart;
      this.addLog(memory.connectorType, memory.accountId, 'error',
        `[file:fail] ${mid} after ${totalMs}ms: ${err?.message || err}`);
      throw err;
    }
  }

  private async buildAuthHeaders(
    accountId: string | null,
    connectorType: string,
  ): Promise<Record<string, string>> {
    if (!accountId) return {};

    let account;
    try {
      account = await this.accountsService.getById(accountId);
    } catch {
      return {};
    }

    const authContext = account.authContext ? JSON.parse(account.authContext) : null;
    if (!authContext?.accessToken) return {};

    switch (connectorType) {
      case 'slack':
        return { Authorization: `Bearer ${authContext.accessToken}` };
      case 'photos':
        return { 'x-api-key': authContext.accessToken };
      default:
        return { Authorization: `Bearer ${authContext.accessToken}` };
    }
  }

  private async extractContent(
    res: Response,
    mimetype: string | undefined,
    fileName: string | undefined,
    memory: any,
  ): Promise<string | null> {
    const mime = (mimetype || '').toLowerCase();
    const ext = (fileName || '').toLowerCase().split('.').pop() || '';
    const header = fileName ? `# ${fileName}` : '';

    // Image → Ollama VL model
    if (mime.startsWith('image/')) {
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const description = await this.ollama.generate(
        photoDescriptionPrompt(memory.text || ''),
        [base64],
      );
      return description.trim() || null;
    }

    // PDF
    if (mime === 'application/pdf' || ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = Buffer.from(await res.arrayBuffer());
      const data = await pdfParse(buffer);
      const text = data.text?.trim();
      if (!text) return null;
      return header ? `${header}\n\n${text}` : text;
    }

    // DOCX
    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === 'docx'
    ) {
      const mammoth = await import('mammoth');
      const buffer = Buffer.from(await res.arrayBuffer());
      const result = await mammoth.convertToMarkdown({ buffer });
      const text = result.value?.trim();
      if (!text) return null;
      return header ? `${header}\n\n${text}` : text;
    }

    // Spreadsheets (xlsx, xls, csv)
    if (
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel' ||
      mime === 'text/csv' ||
      ext === 'xlsx' || ext === 'xls' || ext === 'csv'
    ) {
      const XLSX = await import('xlsx');
      const buffer = Buffer.from(await res.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sections: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (!csv.trim()) continue;

        // Convert CSV to markdown table
        const lines = csv.split('\n').filter((l: string) => l.trim());
        if (!lines.length) continue;

        const mdLines: string[] = [`## ${sheetName}`];
        const headerCols = lines[0].split(',');
        mdLines.push(`| ${headerCols.join(' | ')} |`);
        mdLines.push(`| ${headerCols.map(() => '---').join(' | ')} |`);
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          mdLines.push(`| ${cols.join(' | ')} |`);
        }
        sections.push(mdLines.join('\n'));
      }

      if (!sections.length) return null;
      const tableContent = sections.join('\n\n');
      return header ? `${header}\n\n${tableContent}` : tableContent;
    }

    // Plain text (but not CSV, already handled above)
    if (mime.startsWith('text/') && ext !== 'csv') {
      const text = await res.text();
      if (!text.trim()) return null;
      return header ? `${header}\n\n${text.trim()}` : text.trim();
    }

    // Unsupported type
    return null;
  }

  private addLog(connectorType: string, accountId: string | null, level: string, message: string) {
    const stage = 'file';
    this.logsService.add({ connectorType, accountId: accountId ?? undefined, stage, level, message });
    this.events.emitToChannel('logs', 'log', {
      connectorType, accountId, stage, level, message, timestamp: new Date().toISOString(),
    });
  }
}
