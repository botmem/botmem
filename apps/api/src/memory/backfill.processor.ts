import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ContactsService, IdentifierInput } from '../contacts/contacts.service';
import { memories, rawEvents, memoryContacts } from '../db/schema';

@Processor('backfill')
export class BackfillProcessor extends WorkerHost {
  constructor(
    private dbService: DbService,
    private contactsService: ContactsService,
  ) {
    super();
  }

  async process(job: Job<{ memoryId: string }>) {
    const { memoryId } = job.data;
    const db = this.dbService.db;

    // Skip if already has contact links
    const existing = await db
      .select()
      .from(memoryContacts)
      .where(eq(memoryContacts.memoryId, memoryId));
    if (existing.length > 0) return { skipped: true };

    // Fetch the memory
    const memRows = await db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId));
    if (!memRows.length) return { skipped: true };
    const mem = memRows[0];

    // Find the raw event for participant data
    const rawRows = await db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.sourceId, mem.sourceId));
    if (!rawRows.length) return { skipped: true, reason: 'no raw event' };

    const event = JSON.parse(rawRows[0].payload);
    const metadata = event.content?.metadata || {};
    const participants = event.content?.participants || [];

    const linked = await this.resolveContacts(memoryId, mem.connectorType, metadata, participants);
    return { memoryId, linked };
  }

  private async resolveContacts(
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
      if (metadata.name) identifiers.push({ type: 'name', value: metadata.name as string, connectorType: 'gmail' });
      for (const email of (metadata.emails as string[]) || []) {
        identifiers.push({ type: 'email', value: email, connectorType: 'gmail' });
      }
      for (const phone of (metadata.phones as string[]) || []) {
        identifiers.push({ type: 'phone', value: phone.replace(/\s*\(.*\)/, '').trim(), connectorType: 'gmail' });
      }
      if (identifiers.length) {
        const contact = await this.contactsService.resolveContact(identifiers);
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
          const contact = await this.contactsService.resolveContact(identifiers);
          await this.contactsService.linkMemory(memoryId, contact.id, header === 'from' ? 'sender' : 'recipient');
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
      const contact = await this.contactsService.resolveContact([
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
      const contact = await this.contactsService.resolveContact(identifiers);
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
    for (const participant of participants) {
      if (!participant) continue;
      const identifiers: IdentifierInput[] = [];

      if (participant.includes('@')) {
        identifiers.push({ type: 'email', value: participant, connectorType: 'imessage' });
        identifiers.push({ type: 'imessage_handle', value: participant, connectorType: 'imessage' });
      } else {
        identifiers.push({ type: 'phone', value: participant, connectorType: 'imessage' });
        identifiers.push({ type: 'imessage_handle', value: participant, connectorType: 'imessage' });
      }

      const contact = await this.contactsService.resolveContact(identifiers);
      await this.contactsService.linkMemory(memoryId, contact.id, metadata.isFromMe ? 'recipient' : 'sender');
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
      linked++;
    }

    for (const name of participants) {
      if (!name || resolvedNames.has(name)) continue;
      const contact = await this.contactsService.resolveContact([
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
