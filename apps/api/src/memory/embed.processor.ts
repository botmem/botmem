import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { OllamaService } from './ollama.service';
import { QdrantService } from './qdrant.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { EventsService } from '../events/events.service';
import { LogsService } from '../logs/logs.service';
import { rawEvents, memories } from '../db/schema';

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
export class EmbedProcessor extends WorkerHost {
  private collectionReady = false;

  constructor(
    private dbService: DbService,
    private ollama: OllamaService,
    private qdrant: QdrantService,
    private contactsService: ContactsService,
    @InjectQueue('enrich') private enrichQueue: Queue,
    private events: EventsService,
    private logsService: LogsService,
  ) {
    super();
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

    await this.logsService.add({
      connectorType: rawEvent.connectorType,
      accountId: rawEvent.accountId,
      level: 'info',
      message: `Embedding ${event.sourceType} (${text.slice(0, 60)}${text.length > 60 ? '…' : ''})`,
    });

    // 3. Create memory record
    const memoryId = randomUUID();
    const now = new Date().toISOString();

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

    // 4. Resolve contacts from participants
    try {
      await this.resolveContacts(memoryId, rawEvent.connectorType, event);
    } catch (err) {
      // Contact resolution is best-effort — don't block the pipeline
      console.error('Contact resolution failed:', err);
    }

    // 5. Generate embedding
    try {
      const vector = await this.ollama.embed(text);

      // Ensure Qdrant collection exists on first run
      if (!this.collectionReady) {
        await this.qdrant.ensureCollection(vector.length);
        this.collectionReady = true;
      }

      // 6. Store in Qdrant
      await this.qdrant.upsert(memoryId, vector, {
        source_type: event.sourceType,
        connector_type: rawEvent.connectorType,
        event_time: event.timestamp,
        account_id: rawEvent.accountId,
      });

      // 7. Update status
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'done' })
        .where(eq(memories.id, memoryId));

      await this.logsService.add({
        connectorType: rawEvent.connectorType,
        accountId: rawEvent.accountId,
        level: 'info',
        message: `Embedded ${event.sourceType} → memory ${memoryId.slice(0, 8)}`,
      });

      // 8. Enqueue enrichment
      await this.enrichQueue.add(
        'enrich',
        { memoryId },
        { attempts: 2, backoff: { type: 'exponential', delay: 1000 } },
      );

      // 9. Emit real-time event
      this.events.emitToChannel('memories', 'memory:new', {
        memoryId,
        sourceType: event.sourceType,
        connectorType: rawEvent.connectorType,
        text: text.slice(0, 100),
      });
    } catch (err: any) {
      await this.dbService.db
        .update(memories)
        .set({ embeddingStatus: 'failed' })
        .where(eq(memories.id, memoryId));
      await this.logsService.add({
        connectorType: rawEvent.connectorType,
        accountId: rawEvent.accountId,
        level: 'error',
        message: `Embedding failed for ${event.sourceType}: ${err?.message || err}`,
      });
      throw err;
    }
  }

  private async resolveContacts(
    memoryId: string,
    connectorType: string,
    event: ConnectorDataEvent,
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
        await this.resolvePhotosContacts(memoryId, metadata, participants);
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
    // Slack participants are user IDs like "U1234567890"
    for (const userId of participants) {
      if (!userId) continue;
      const identifiers: IdentifierInput[] = [
        { type: 'slack_id', value: userId, connectorType: 'slack' },
      ];
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
    }
  }

  private async resolveWhatsAppContacts(
    memoryId: string,
    metadata: Record<string, unknown>,
    participants: string[],
  ): Promise<void> {
    // WhatsApp participants are JIDs like "1234567890@s.whatsapp.net"
    const pushName = metadata.pushName as string | undefined;

    for (const jid of participants) {
      if (!jid) continue;
      // Extract phone number from JID
      const phone = jid.replace(/@.*$/, '');
      if (!phone || phone.includes('-')) continue; // Skip group IDs

      const identifiers: IdentifierInput[] = [
        { type: 'phone', value: phone, connectorType: 'whatsapp' },
      ];
      if (pushName) {
        identifiers.push({ type: 'name', value: pushName, connectorType: 'whatsapp' });
      }
      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'sender');
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
  ): Promise<void> {
    // Immich people from facial recognition stored in metadata.people
    const people = (metadata.people as Array<{ id: string; name: string; birthDate?: string }>) || [];
    const resolvedNames = new Set<string>();

    for (const person of people) {
      if (!person.name) continue;

      const identifiers: IdentifierInput[] = [
        { type: 'name', value: person.name, connectorType: 'photos' },
        { type: 'immich_person_id', value: person.id, connectorType: 'photos' },
      ];

      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, 'participant');
      resolvedNames.add(person.name);
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
