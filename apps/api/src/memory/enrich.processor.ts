import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EnrichService } from './enrich.service';
import { MemoryService } from './memory.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { rawEvents, memories } from '../db/schema';

@Processor('enrich')
export class EnrichProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private dbService: DbService,
    private enrichService: EnrichService,
    private memoryService: MemoryService,
    private events: EventsService,
    private logsService: LogsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private pluginRegistry: PluginRegistry,
  ) {
    super();
  }

  onModuleInit() {
    this.worker.on('error', (err) => console.warn('[enrich worker]', err.message));
    const concurrency = parseInt(this.settingsService.get('enrich_concurrency'), 10) || 8;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'enrich_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 8;
      }
    });
  }

  async process(job: Job<{ rawEventId: string; memoryId: string }>) {
    const { rawEventId, memoryId } = job.data;

    // Look up parent job ID from the raw event
    const rawRows = await this.dbService.db
      .select({ jobId: rawEvents.jobId, connectorType: rawEvents.connectorType, accountId: rawEvents.accountId })
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    const parentJobId = rawRows[0]?.jobId;
    const connectorType = rawRows[0]?.connectorType || 'unknown';
    const accountId = rawRows[0]?.accountId;

    // Run enrichment
    await this.enrichService.enrich(memoryId);

    // Read enriched memory for hook and event
    const [mem] = await this.dbService.db
      .select({ text: memories.text, sourceType: memories.sourceType, entities: memories.entities, factuality: memories.factuality })
      .from(memories)
      .where(eq(memories.id, memoryId));

    // Fire afterEnrich hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterEnrich', {
      id: memoryId, text: mem?.text, sourceType: mem?.sourceType,
      connectorType, eventTime: undefined,
      entities: mem?.entities, factuality: mem?.factuality,
    });

    // Mark memory as done
    await this.dbService.db.update(memories)
      .set({ embeddingStatus: 'done' })
      .where(eq(memories.id, memoryId));

    this.events.emitToChannel('memories', 'memory:updated', {
      memoryId,
      sourceType: mem?.sourceType,
      connectorType,
      text: mem?.text?.slice(0, 100),
    });

    // Emit graph delta for incremental graph updates
    this.emitGraphDelta(memoryId);

    // Debounced dashboard stats
    this.events.emitDebounced('dashboard:stats', 'dashboard', 'dashboard:stats',
      () => this.memoryService.getStats());

    // Advance parent job progress
    await this.advanceAndComplete(parentJobId);
  }

  private emitGraphDelta(memoryId: string) {
    this.memoryService.buildGraphDelta(memoryId).then((delta) => {
      if (delta) this.events.emitToChannel('memories', 'graph:delta', delta);
    }).catch(() => {});
  }

  private async advanceAndComplete(jobId: string | null | undefined) {
    if (!jobId) return;
    try {
      const result = await this.jobsService.incrementProgress(jobId);
      this.events.emitToChannel(`job:${jobId}`, 'job:progress', {
        jobId,
        processed: result.progress,
        total: result.total,
      });
      const done = await this.jobsService.tryCompleteJob(jobId);
      if (done) {
        this.events.emitToChannel(`job:${jobId}`, 'job:complete', { jobId, status: 'done' });
        this.events.emitToChannel('dashboard', 'dashboard:jobs', { trigger: 'enrich_complete', jobId });
      }
    } catch {
      // Non-fatal
    }
  }
}
