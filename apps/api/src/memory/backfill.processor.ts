import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../db/db.service';
import type * as schema from '../db/schema';
import { PeopleService, IdentifierInput } from '../people/people.service';
import { AccountsService } from '../accounts/accounts.service';
import { EnrichService } from './enrich.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { EventsService } from '../events/events.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { ConfigService } from '../config/config.service';
import { memories, rawEvents, memoryContacts, settings, accounts, users } from '../db/schema';

@Processor('backfill')
export class BackfillProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(BackfillProcessor.name);
  constructor(
    private dbService: DbService,
    private contactsService: PeopleService,
    private accountsService: AccountsService,
    private enrichService: EnrichService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    private events: EventsService,
    private jobsService: JobsService,
    private settingsService: SettingsService,
    private config: ConfigService,
  ) {
    super();
  }

  async onModuleInit() {
    this.worker.on('error', (err) => this.logger.warn(`[backfill worker] ${err.message}`));
    const defaultC = this.config.aiConcurrency.backfill;
    const concurrency =
      parseInt(await this.settingsService.get('backfill_concurrency'), 10) || defaultC;
    this.worker.concurrency = concurrency;
    this.worker.opts.lockDuration = 300_000;
    this.settingsService.onChange((key, value) => {
      if (key === 'backfill_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || defaultC;
      }
    });
  }

  async process(job: Job<{ memoryId: string; jobId?: string }>) {
    if (job.name === 'backfill-enrich') {
      return this.processEnrich(job);
    }
    if (job.name === 'backfill-thumbnails') {
      return this.processThumbnail(job);
    }
    return this.processContact(job);
  }

  // ---- Enrich backfill ----

  private async processEnrich(job: Job<{ memoryId: string; jobId?: string }>) {
    const { memoryId, jobId } = job.data;

    // Bootstrap (unscoped): read memory to resolve ownerUserId
    const memRows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!memRows.length) {
      this.logger.warn(`[backfill-enrich] Memory ${memoryId} not found, skipping`);
      await this.advanceAndComplete(jobId);
      return { skipped: true, reason: 'not-found' };
    }
    const mem = memRows[0];

    // Resolve ownerUserId (unscoped bootstrap)
    let ownerUserId: string | undefined;
    if (mem.accountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, mem.accountId));
      ownerUserId = acct?.userId ?? undefined;
    }

    // Resumability: skip if already enriched
    if (mem.enrichedAt) {
      await this.advanceAndComplete(jobId);
      return { skipped: true };
    }

    // Decrypt if needed
    const wasEncrypted = this.crypto.isEncrypted(mem.text);
    if (wasEncrypted) {
      let decrypted: typeof mem;
      if (mem.keyVersion === 0 || !ownerUserId) {
        // Legacy APP_SECRET encrypted
        decrypted = this.crypto.decryptMemoryFields(mem);
      } else {
        const userKey = await this.userKeyService.getDek(ownerUserId);
        if (!userKey) throw new Error(`Encryption key not available for user ${ownerUserId}`);
        decrypted = this.crypto.decryptMemoryFieldsWithKey(mem, userKey);
      }
      const writeDecrypted = (db: typeof this.dbService.db) =>
        db
          .update(memories)
          .set({
            text: decrypted.text,
            entities: decrypted.entities,
            claims: decrypted.claims,
            metadata: decrypted.metadata,
          })
          .where(eq(memories.id, memoryId));
      if (ownerUserId) {
        await this.dbService.withUserId(ownerUserId, writeDecrypted);
      } else {
        await writeDecrypted(this.dbService.db);
      }
    }

    // Run enrichment (enrichService uses unscoped db — acceptable for processor context)
    await this.enrichService.enrich(memoryId);

    // Re-encrypt + set enrichedAt
    await this.encryptMemoryAtRest(memoryId, ownerUserId);
    const writeEnrichedAt = (db: typeof this.dbService.db) =>
      db.update(memories).set({ enrichedAt: new Date() }).where(eq(memories.id, memoryId));
    if (ownerUserId) {
      await this.dbService.withUserId(ownerUserId, writeEnrichedAt);
    } else {
      await writeEnrichedAt(this.dbService.db);
    }

    await this.advanceAndComplete(jobId);
    return { memoryId, enriched: true };
  }

  // ---- Thumbnail backfill ----

  private async processThumbnail(job: Job<{ memoryId: string; jobId?: string }>) {
    const { memoryId, jobId } = job.data;

    const memRows = await this.dbService.db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!memRows.length) {
      await this.advanceAndComplete(jobId);
      return { skipped: true, reason: 'not-found' };
    }
    const mem = memRows[0];

    // Resolve owner for RLS
    let ownerUserId: string | undefined;
    if (mem.accountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, mem.accountId));
      ownerUserId = acct?.userId ?? undefined;
    }

    // Decrypt metadata if needed
    let metadata: Record<string, unknown> = {};
    try {
      const wasEncrypted = this.crypto.isEncrypted(mem.metadata);
      if (wasEncrypted) {
        const decrypted =
          mem.keyVersion === 0 || !ownerUserId
            ? this.crypto.decryptMemoryFields(mem)
            : this.crypto.decryptMemoryFieldsWithKey(
                mem,
                (await this.userKeyService.getDek(ownerUserId!))!,
              );
        metadata = JSON.parse(decrypted.metadata);
      } else {
        metadata = JSON.parse(mem.metadata);
      }
    } catch {
      await this.advanceAndComplete(jobId);
      return { skipped: true, reason: 'metadata-parse-failed' };
    }

    // Skip if already has thumbnail
    if (metadata.thumbnailBase64) {
      await this.advanceAndComplete(jobId);
      return { skipped: true, reason: 'already-has-thumbnail' };
    }

    const fileUrl: string | undefined = metadata.fileUrl as string | undefined;
    if (!fileUrl) {
      await this.advanceAndComplete(jobId);
      return { skipped: true, reason: 'no-file-url' };
    }

    // Build auth headers for fetching from Immich
    const headers: Record<string, string> = {};
    if (mem.accountId) {
      try {
        const account = await this.accountsService.getById(mem.accountId);
        const authContext = account.authContext ? JSON.parse(account.authContext) : null;
        if (authContext?.accessToken) {
          if (mem.connectorType === 'photos') {
            headers['x-api-key'] = authContext.accessToken;
          } else {
            headers['Authorization'] = `Bearer ${authContext.accessToken}`;
          }
        }
      } catch {
        await this.advanceAndComplete(jobId);
        return { skipped: true, reason: 'auth-failed' };
      }
    }

    const thumbUrl = fileUrl
      .replace('size=preview', 'size=thumbnail')
      .replace('size=original', 'size=thumbnail');

    try {
      const res = await fetch(thumbUrl, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      if (buffer.length <= 30_000) {
        metadata.thumbnailBase64 = buffer.toString('base64');

        // Write updated metadata back (re-encrypt if needed)
        const metadataStr = JSON.stringify(metadata);
        const writeUpdate = (db: NodePgDatabase<typeof schema>) =>
          db.update(memories).set({ metadata: metadataStr }).where(eq(memories.id, memoryId));

        if (ownerUserId) {
          await this.dbService.withUserId(ownerUserId, writeUpdate);
        } else {
          await writeUpdate(this.dbService.db);
        }

        // Re-encrypt at rest
        await this.encryptMemoryAtRest(memoryId, ownerUserId);
      }
    } catch (err) {
      this.logger.warn(
        `[backfill-thumbnails] ${memoryId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.advanceAndComplete(jobId);
    return { memoryId, thumbnailStored: true };
  }

  // ---- Contact backfill (existing logic) ----

  private async processContact(job: Job<{ memoryId: string }>) {
    const { memoryId } = job.data;

    // Bootstrap (unscoped): resolve ownerUserId from memory → account
    const bootstrapRows = await this.dbService.db
      .select({ accountId: memories.accountId })
      .from(memories)
      .where(eq(memories.id, memoryId));
    const bootstrapAccountId = bootstrapRows[0]?.accountId;

    let ownerUserId: string | undefined;
    if (bootstrapAccountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, bootstrapAccountId));
      ownerUserId = acct?.userId ?? undefined;
    }

    const withScope = <T>(fn: (db: typeof this.dbService.db) => Promise<T>) =>
      ownerUserId ? this.dbService.withUserId(ownerUserId, fn) : fn(this.dbService.db);

    // Skip if already has contact links
    const existing = await withScope((db) =>
      db.select().from(memoryContacts).where(eq(memoryContacts.memoryId, memoryId)),
    );
    if (existing.length > 0) return { skipped: true };

    // Fetch the memory
    const memRows = await withScope((db) =>
      db.select().from(memories).where(eq(memories.id, memoryId)),
    );
    if (!memRows.length) return { skipped: true };
    const mem = memRows[0];

    // Find the raw event for participant data (rawEvents is RLS-protected)
    const rawRows = await withScope((db) =>
      db.select().from(rawEvents).where(eq(rawEvents.sourceId, mem.sourceId)),
    );
    if (!rawRows.length) return { skipped: true, reason: 'no raw event' };

    const event = JSON.parse(rawRows[0].payload);
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];

    const linked = await this.resolvePeople(memoryId, mem.connectorType, metadata, participants);
    return { memoryId, linked };
  }

  // ---- Shared helpers ----

  private async encryptMemoryAtRest(memoryId: string, ownerUserIdHint?: string) {
    // Read memory fields — use ownerUserIdHint scope if available
    const readRows = (db: typeof this.dbService.db) =>
      db
        .select({
          text: memories.text,
          entities: memories.entities,
          claims: memories.claims,
          metadata: memories.metadata,
          accountId: memories.accountId,
        })
        .from(memories)
        .where(eq(memories.id, memoryId));

    const rows = ownerUserIdHint
      ? await this.dbService.withUserId(ownerUserIdHint, readRows)
      : await readRows(this.dbService.db);

    if (!rows.length) return;
    const mem = rows[0];

    // Resolve owner userId: use hint or fall back to account lookup (unscoped bootstrap)
    let ownerUserId: string | undefined = ownerUserIdHint;
    if (!ownerUserId && mem.accountId) {
      const [acct] = await this.dbService.db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(eq(accounts.id, mem.accountId));
      ownerUserId = acct?.userId ?? undefined;
    }

    if (!ownerUserId) {
      const enc = this.crypto.encryptMemoryFields({
        text: mem.text,
        entities: mem.entities,
        claims: mem.claims,
        metadata: mem.metadata,
      });
      await this.dbService.db
        .update(memories)
        .set({
          text: enc.text,
          entities: enc.entities,
          claims: enc.claims,
          metadata: enc.metadata,
          keyVersion: 0,
        })
        .where(eq(memories.id, memoryId));
      return;
    }

    const userKey = await this.userKeyService.getDek(ownerUserId);
    if (!userKey) throw new Error(`Encryption key not available for user ${ownerUserId}`);

    // users table is NOT RLS-protected — unscoped lookup is correct
    const [user] = await this.dbService.db
      .select({ keyVersion: users.keyVersion })
      .from(users)
      .where(eq(users.id, ownerUserId));
    const keyVersion = user?.keyVersion ?? 1;

    const enc = this.crypto.encryptMemoryFieldsWithKey(
      { text: mem.text, entities: mem.entities, claims: mem.claims, metadata: mem.metadata },
      userKey,
    );
    await this.dbService.withUserId(ownerUserId, (db) =>
      db
        .update(memories)
        .set({
          text: enc.text,
          entities: enc.entities,
          claims: enc.claims,
          metadata: enc.metadata,
          keyVersion,
        })
        .where(eq(memories.id, memoryId)),
    );
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
      }
    } catch (err) {
      this.logger.warn(
        'Job progress advance failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---- Contact resolution methods (unchanged) ----

  private async resolvePeople(
    memoryId: string,
    connectorType: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<number> {
    let linked = 0;

    switch (connectorType) {
      case 'gmail':
        linked = await this.resolveGmail(memoryId, metadata, participants);
        break;
      case 'slack':
        linked = await this.resolveSlack(memoryId, participants);
        break;
      case 'whatsapp':
        linked = await this.resolveWhatsApp(memoryId, metadata, participants);
        break;
      case 'imessage':
        linked = await this.resolveIMessage(memoryId, metadata, participants);
        break;
      case 'photos':
        linked = await this.resolvePhotos(memoryId, metadata, participants);
        break;
    }

    return linked;
  }

  private async resolveGmail(
    memoryId: string,
    metadata: Record<string, unknown>,
    _participants: string[],
  ): Promise<number> {
    let linked = 0;

    if (metadata.type === 'contact') {
      const identifiers: IdentifierInput[] = [];
      if (metadata.name)
        identifiers.push({ type: 'name', value: metadata.name as string, connectorType: 'gmail' });
      for (const email of (metadata.emails as string[]) || []) {
        identifiers.push({ type: 'email', value: email, connectorType: 'gmail' });
      }
      for (const phone of (metadata.phones as string[]) || []) {
        identifiers.push({
          type: 'phone',
          value: phone.replace(/\s*\(.*\)/, '').trim(),
          connectorType: 'gmail',
        });
      }
      if (identifiers.length) {
        const contact = await this.contactsService.resolvePerson(identifiers);
        await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
        linked++;
      }
    } else {
      for (const header of ['from', 'to', 'cc'] as const) {
        const raw = (metadata[header] as string) || '';
        for (const { name, email } of parseEmailAddresses(raw)) {
          const identifiers: IdentifierInput[] = [
            { type: 'email', value: email, connectorType: 'gmail' },
          ];
          if (name) identifiers.push({ type: 'name', value: name, connectorType: 'gmail' });
          const contact = await this.contactsService.resolvePerson(identifiers);
          await this.contactsService.linkMemory(
            memoryId,
            contact.id,
            header === 'from' ? 'sender' : 'recipient',
          );
          linked++;
        }
      }
    }

    return linked;
  }

  private async resolveSlack(memoryId: string, participants: string[]): Promise<number> {
    let linked = 0;
    for (const userId of participants) {
      if (!userId) continue;
      const contact = await this.contactsService.resolvePerson([
        { type: 'slack_id', value: userId, connectorType: 'slack' },
      ]);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
      linked++;
    }
    return linked;
  }

  private async resolveWhatsApp(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<number> {
    let linked = 0;
    const pushName = metadata.pushName as string | undefined;

    for (const jid of participants) {
      if (!jid) continue;
      const phone = jid.replace(/@.*$/, '');
      if (!phone || phone.includes('-')) continue;

      const identifiers: IdentifierInput[] = [
        { type: 'phone', value: phone, connectorType: 'whatsapp' },
      ];
      if (pushName) identifiers.push({ type: 'name', value: pushName, connectorType: 'whatsapp' });
      const contact = await this.contactsService.resolvePerson(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
      linked++;
    }
    return linked;
  }

  private async resolveIMessage(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<number> {
    let linked = 0;

    // Always link self-contact -- you are sender or recipient of every iMessage
    const selfRow = await this.dbService.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'selfContactId'))
      .limit(1);
    const selfContactId = selfRow[0]?.value;
    if (selfContactId) {
      await this.contactsService.linkMemory(
        memoryId,
        selfContactId,
        metadata.isFromMe ? 'sender' : 'recipient',
      );
      linked++;
    }

    for (const participant of participants) {
      if (!participant) continue;
      const identifiers: IdentifierInput[] = [];

      if (participant.includes('@')) {
        identifiers.push({ type: 'email', value: participant, connectorType: 'imessage' });
        identifiers.push({
          type: 'imessage_handle',
          value: participant,
          connectorType: 'imessage',
        });
      } else {
        identifiers.push({ type: 'phone', value: participant, connectorType: 'imessage' });
        identifiers.push({
          type: 'imessage_handle',
          value: participant,
          connectorType: 'imessage',
        });
      }

      const contact = await this.contactsService.resolvePerson(identifiers);
      await this.contactsService.linkMemory(
        memoryId,
        contact.id,
        metadata.isFromMe ? 'recipient' : 'sender',
      );
      linked++;
    }
    return linked;
  }

  private async resolvePhotos(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<number> {
    let linked = 0;
    const people =
      (metadata.people as Array<{ id: string; name: string; birthDate?: string }>) || [];
    const resolvedNames = new Set<string>();

    for (const person of people) {
      if (!person.name) continue;
      const identifiers: IdentifierInput[] = [
        { type: 'name', value: person.name, connectorType: 'photos' },
        { type: 'immich_person_id', value: person.id, connectorType: 'photos' },
      ];
      const contact = await this.contactsService.resolvePerson(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      resolvedNames.add(person.name);
      linked++;
    }

    for (const name of participants) {
      if (!name || resolvedNames.has(name)) continue;
      const contact = await this.contactsService.resolvePerson([
        { type: 'name', value: name, connectorType: 'photos' },
      ]);
      await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      linked++;
    }

    return linked;
  }
}

function parseEmailAddresses(header: string): Array<{ name: string | null; email: string }> {
  if (!header) return [];
  const results: Array<{ name: string | null; email: string }> = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
    if (angleMatch) {
      const name = angleMatch[1].replace(/^["']|["']$/g, '').trim();
      results.push({ name: name || null, email: angleMatch[2].toLowerCase() });
    } else if (trimmed.includes('@')) {
      results.push({ name: null, email: trimmed.toLowerCase() });
    }
  }
  return results;
}
