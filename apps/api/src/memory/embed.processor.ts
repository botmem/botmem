import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { SettingsService } from '../settings/settings.service';
import { rawEvents, memories, accounts } from '../db/schema';

export interface SlackProfile {
  name: string;
  realName?: string;
  email?: string;
  phone?: string;
  title?: string;
  avatarUrl?: string;
}

export function buildSlackIdentifiers(
  username: string,
  profiles: Record<string, SlackProfile> | undefined,
): IdentifierInput[] {
  const profile = profiles?.[username];
  const identifiers: IdentifierInput[] = [];

  if (profile) {
    identifiers.push({ type: 'name', value: profile.realName || username, connectorType: 'slack' });
    if (profile.email) {
      identifiers.push({ type: 'email', value: profile.email, connectorType: 'slack' });
    }
    if (profile.phone) {
      identifiers.push({ type: 'phone', value: profile.phone, connectorType: 'slack' });
    }
    identifiers.push({ type: 'slack_id', value: username, connectorType: 'slack' });
  } else {
    identifiers.push({ type: 'slack_id', value: username, connectorType: 'slack' });
  }

  return identifiers;
}

interface ConnectorDataEvent {
  sourceType: string;
  sourceId: string;
  timestamp: string;
  content: {
    text?: string;
    participants?: string[];
    attachments?: unknown[];
    metadata?: Record<string, unknown>;
  };
}

@Processor('embed')
export class EmbedProcessor extends WorkerHost implements OnModuleInit {
  private collectionReady = false;

  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private contactsService: ContactsService,
    @InjectQueue('enrich') private enrichQueue: Queue,
    @InjectQueue('file') private fileQueue: Queue,
    private events: EventsService,
    private logsService: LogsService,
    private settingsService: SettingsService,
  ) {
    super();
  }

  onModuleInit() {
    const concurrency = parseInt(this.settingsService.get('embed_concurrency'), 10) || 4;
    this.worker.concurrency = concurrency;
    this.settingsService.onChange((key, value) => {
      if (key === 'embed_concurrency') {
        this.worker.concurrency = parseInt(value, 10) || 4;
      }
    });
  }

  async process(job: Job<{ rawEventId: string }>) {
    const { rawEventId } = job.data;

    // 1. Read raw event
    const rows = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId));

    if (!rows.length) return;
    const rawEvent = rows[0];

    // 2. Parse payload
    const event: ConnectorDataEvent = JSON.parse(rawEvent.payload);
    const text = event.content?.text || '';
    if (!text.trim()) return;

    const mid = rawEventId.slice(0, 8);
    this.addLog(rawEvent.connectorType, rawEvent.accountId, 'info',
      `[embed:start] ${event.sourceType} ${mid} (${text.length} chars) "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);

    const pipelineStart = Date.now();

    // 3. Create memory record
    const memoryId = randomUUID();
    const now = new Date().toISOString();

    let t0 = Date.now();
    await this.dbService.db.insert(memories).values({
      id: memoryId,
      accountId: rawEvent.accountId,
      connectorType: rawEvent.connectorType,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      text,
      eventTime: event.timestamp,
      ingestTime: now,
      metadata: JSON.stringify(event.content?.metadata || {}),
      embeddingStatus: 'pending',
      createdAt: now,
    });
    const dbInsertMs = Date.now() - t0;

    // Route file events to the file processor for content extraction
    if (event.sourceType === 'file') {
      this.addLog(rawEvent.connectorType, rawEvent.accountId, 'info',
        `[embed:file-route] ${mid} → file queue for content extraction`);

      // Resolve contacts before routing to file processor (e.g. Immich people tags)
      try {
        await this.resolveContacts(memoryId, rawEvent.connectorType, event, rawEvent.accountId);
      } catch (err) {
        console.error('Contact resolution failed for file event:', err);
      }

      await this.fileQueue.add(
        'file',
        { memoryId },
        { attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
      );
      return;
    }

    // 4. Resolve contacts from participants
    t0 = Date.now();
    let contactCount = 0;
    try {
      await this.resolveContacts(memoryId, rawEvent.connectorType, event, rawEvent.accountId);
      contactCount = (event.content?.participants || []).length;
    } catch (err) {
      console.error('Contact resolution failed:', err);
    }
    const contactMs = Date.now() - t0;

    // 5. Generate embedding
    try {
      t0 = Date.now();
      const vector = await this.ollama.embed(text);
      const embedMs = Date.now() - t0;

      // Ensure Qdrant collection exists on first run
      if (!this.collectionReady) {
        await this.qdrant.ensureCollection(vector.length);
        this.collectionReady = true;
      }

      // 6. Store in Qdrant
      t0 = Date.now();
      await this.qdrant.upsert(memoryId, vector, {
        source_type: event.sourceType,
        connector_type: rawEvent.connectorType,
        event_time: event.timestamp,
        account_id: rawEvent.accountId,
      });
      const qdrantMs = Date.now() - t0;

      // 7. Update status
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, memoryId));

      const totalMs = Date.now() - pipelineStart;
      this.addLog(rawEvent.connectorType, rawEvent.accountId, 'info',
        `[embed:done] ${memoryId.slice(0, 8)} in ${totalMs}ms — db=${dbInsertMs}ms contacts=${contactMs}ms(${contactCount}) ollama=${embedMs}ms(${vector.length}d) qdrant=${qdrantMs}ms`);

      // 8. Enqueue enrichment
      await this.enrichQueue.add(
        'enrich',
        { memoryId },
        { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
      );

      // Real-time event omitted — frontend uses polling instead
    } catch (err: any) {
      const totalMs = Date.now() - pipelineStart;
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'failed' })
        .where(eq(memories.id, memoryId));
      this.addLog(rawEvent.connectorType, rawEvent.accountId, 'error',
        `[embed:fail] ${event.sourceType} after ${totalMs}ms: ${err?.message || err}`);
      throw err;
    }
  }

  private addLog(connectorType: string, accountId: string, level: string, message: string) {
    const stage = 'embed';
    this.logsService.add({ connectorType, accountId, stage, level, message });
    this.events.emitToChannel('logs', 'log', { connectorType, accountId, stage, level, message, timestamp: new Date().toISOString() });
  }

  private async resolveContacts(
    memoryId: string,
    connectorType: string,
    event: ConnectorDataEvent,
    accountId?: string,
  ): Promise<void> {
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];

    switch (connectorType) {
      case 'gmail':
        await this.resolveGmailContacts(memoryId, metadata, participants);
        break;
      case 'slack':
        await this.resolveSlackContacts(memoryId, metadata, participants);
        break;
      case 'whatsapp':
        await this.resolveWhatsAppContacts(memoryId, metadata, participants);
        break;
      case 'imessage':
        await this.resolveIMessageContacts(memoryId, metadata, participants);
        break;
      case 'photos':
        await this.resolvePhotosContacts(memoryId, metadata, participants, accountId);
        break;
    }
  }

  private async resolveGmailContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<void> {
    // Gmail metadata has: from, to, cc (raw email headers)
    // Gmail contact events have: metadata.emails, metadata.phones, metadata.name
    const isContact = metadata.type === 'contact';

    if (isContact) {
      // This is a Google contact, not an email
      const identifiers: IdentifierInput[] = [];
      if (metadata.name) {
        identifiers.push({ type: 'name', value: metadata.name as string, connectorType: 'gmail' });
      }
      for (const email of (metadata.emails as string[]) || []) {
        identifiers.push({ type: 'email', value: email, connectorType: 'gmail' });
      }
      for (const phone of (metadata.phones as string[]) || []) {
        // Strip format like "555-1234 (mobile)" to just the number
        const num = phone.replace(/\s*\(.*\)/, '').trim();
        identifiers.push({ type: 'phone', value: num, connectorType: 'gmail' });
      }
      if (identifiers.length) {
        const contact = await this.contactsService.resolveContact(identifiers);
        await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      }
      return;
    }

    // Regular email — parse from/to/cc headers
    const fromHeader = (metadata.from as string) || '';
    const toHeader = (metadata.to as string) || '';
    const ccHeader = (metadata.cc as string) || '';

    const fromEmails = this.parseEmailAddresses(fromHeader);
    for (const { name, email } of fromEmails) {
      const identifiers: IdentifierInput[] = [
        { type: 'email', value: email, connectorType: 'gmail' },
      ];
      if (name) identifiers.push({ type: 'name', value: name, connectorType: 'gmail' });
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
    }

    const recipientEmails = [
      ...this.parseEmailAddresses(toHeader),
      ...this.parseEmailAddresses(ccHeader),
    ];
    for (const { name, email } of recipientEmails) {
      const identifiers: IdentifierInput[] = [
        { type: 'email', value: email, connectorType: 'gmail' },
      ];
      if (name) identifiers.push({ type: 'name', value: name, connectorType: 'gmail' });
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'recipient');
    }
  }

  private async resolveSlackContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<void> {
    const isContact = metadata.type === 'contact';

    if (isContact) {
      const identifiers: IdentifierInput[] = [];
      if (metadata.name) {
        identifiers.push({ type: 'name', value: metadata.name as string, connectorType: 'slack' });
      }
      if (metadata.slackId) {
        identifiers.push({ type: 'slack_id', value: metadata.slackId as string, connectorType: 'slack' });
      }
      for (const email of (metadata.emails as string[]) || []) {
        identifiers.push({ type: 'email', value: email, connectorType: 'slack' });
      }
      for (const phone of (metadata.phones as string[]) || []) {
        identifiers.push({ type: 'phone', value: phone, connectorType: 'slack' });
      }
      if (identifiers.length) {
        const contact = await this.contactsService.resolveContact(identifiers);
        await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      }
      return;
    }

    const profiles = (metadata.participantProfiles || undefined) as
      Record<string, SlackProfile> | undefined;

    for (const username of participants) {
      if (!username) continue;
      const identifiers = buildSlackIdentifiers(username, profiles);
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
    }
  }

  private async resolveWhatsAppContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<void> {
    const senderPhone = metadata.senderPhone as string | undefined;
    const senderName = metadata.senderName as string | undefined;
    const selfPhone = metadata.selfPhone as string | undefined;
    const fromMe = metadata.fromMe as boolean | undefined;

    // Resolve sender
    const phone = senderPhone || (participants[0] || '').replace(/@.*$/, '').split(':')[0];
    if (!phone || phone.includes('-')) return; // Skip group JIDs

    const senderIdentifiers: IdentifierInput[] = [
      { type: 'phone', value: phone, connectorType: 'whatsapp' },
    ];
    if (senderName && senderName !== 'me' && senderName !== phone) {
      senderIdentifiers.push({ type: 'name', value: senderName, connectorType: 'whatsapp' });
    }
    const senderContact = await this.contactsService.resolveContact(senderIdentifiers);
    await this.contactsService.linkMemory(memoryId, senderContact.id, 'sender');

    // For DMs, also resolve the other party as recipient
    const isGroup = metadata.isGroup as boolean | undefined;
    if (!isGroup && selfPhone) {
      const otherPhone = fromMe ? phone : selfPhone;
      // Only create recipient if different from sender
      if (otherPhone !== phone) {
        const recipientIdentifiers: IdentifierInput[] = [
          { type: 'phone', value: otherPhone, connectorType: 'whatsapp' },
        ];
        const recipientContact = await this.contactsService.resolveContact(recipientIdentifiers);
        await this.contactsService.linkMemory(memoryId, recipientContact.id, 'recipient');
      }
    }
  }

  private async resolveIMessageContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<void> {
    // iMessage participants can be emails or phone numbers
    const isFromMe = metadata.isFromMe as boolean | undefined;

    for (const participant of participants) {
      if (!participant) continue;
      const identifiers: IdentifierInput[] = [];

      if (participant.includes('@')) {
        identifiers.push({ type: 'email', value: participant, connectorType: 'imessage' });
        identifiers.push({ type: 'imessage_handle', value: participant, connectorType: 'imessage' });
      } else {
        // Phone number
        identifiers.push({ type: 'phone', value: participant, connectorType: 'imessage' });
        identifiers.push({ type: 'imessage_handle', value: participant, connectorType: 'imessage' });
      }

      const contact = await this.contactsService.resolveContact(identifiers);
      const role = isFromMe ? 'recipient' : 'sender';
      await this.contactsService.linkMemory(memoryId, contact.id, role);
    }
  }

  private async resolvePhotosContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
    accountId?: string,
  ): Promise<void> {
    // Immich people from facial recognition stored in metadata.people
    const people = (metadata.people as Array<{ id: string; name: string; birthDate?: string }>) || [];
    const resolvedNames = new Set<string>();

    // Look up Immich host + API key from account auth for avatar download
    let immichHost: string | null = null;
    let immichApiKey: string | null = null;
    if (accountId) {
      try {
        const accRows = await this.dbService.db.select().from(accounts).where(eq(accounts.id, accountId));
        if (accRows.length && accRows[0].authContext) {
          const auth = JSON.parse(accRows[0].authContext);
          immichHost = auth.raw?.host as string;
          immichApiKey = auth.accessToken as string;
        }
      } catch {
        // Non-fatal
      }
    }

    for (const person of people) {
      if (!person.name) continue;

      const identifiers: IdentifierInput[] = [
        { type: 'name', value: person.name, connectorType: 'photos' },
        { type: 'immich_person_id', value: person.id, connectorType: 'photos' },
      ];

      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      resolvedNames.add(person.name);

      // Download and store avatar if not already present
      if (immichHost && immichApiKey) {
        try {
          const existingAvatars: Array<{ url: string; source: string }> = JSON.parse(contact.avatars || '[]');
          const hasImmichAvatar = existingAvatars.some((a) => a.source === 'immich');
          if (!hasImmichAvatar) {
            const thumbUrl = `${immichHost}/api/people/${person.id}/thumbnail`;
            const res = await fetch(thumbUrl, { headers: { 'x-api-key': immichApiKey } });
            if (res.ok) {
              const buffer = await res.arrayBuffer();
              const base64 = Buffer.from(buffer).toString('base64');
              const contentType = res.headers.get('content-type') || 'image/jpeg';
              existingAvatars.push({ url: `data:${contentType};base64,${base64}`, source: 'immich' });
              await this.contactsService.updateContact(contact.id, { avatars: existingAvatars });
            }
          }
        } catch {
          // Avatar download is best-effort
        }
      }
    }

    // Also resolve any participants not already handled via the people array
    for (const name of participants) {
      if (!name || resolvedNames.has(name)) continue;

      const identifiers: IdentifierInput[] = [
        { type: 'name', value: name, connectorType: 'photos' },
      ];
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
    }
  }

  private parseEmailAddresses(header: string): Array<{ name: string | null; email: string }> {
    if (!header) return [];
    const results: Array<{ name: string | null; email: string }> = [];

    // Split by comma, handle "Name <email>" and bare "email" formats
    const parts = header.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // "Display Name <email@domain.com>" format
      const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
      if (angleMatch) {
        const name = angleMatch[1].replace(/^["']|["']$/g, '').trim();
        results.push({ name: name || null, email: angleMatch[2].toLowerCase() });
      } else if (trimmed.includes('@')) {
        // Bare email
        results.push({ name: null, email: trimmed.toLowerCase() });
      }
    }

    return results;
  }
}
