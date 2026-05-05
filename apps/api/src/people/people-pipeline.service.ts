import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { rawEvents, memories, accounts, settings } from '../db/schema';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { AccountsService } from '../accounts/accounts.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PeopleService, type IdentifierInput } from './people.service';
import {
  memoryPeople,
  mergeDismissals,
  people,
  personIdentifiers,
  personRelationships,
} from '../db/schema';
import {
  buildWhatsAppGroupIdentity,
  shouldMergeEntityResolutionBucket,
} from '../memory/connector-normalizers/whatsapp-group-identity';
import { buildWhatsAppContactIdentity } from '../memory/connector-normalizers/whatsapp-contact-identity';
import type {
  ConnectorDataEvent,
  ConnectorLogger,
  EmbedResult,
  PipelineContext,
} from '@botmem/connector-sdk';

type RawEventRow = typeof rawEvents.$inferSelect;

interface PeoplePipelineEvent {
  rawEventId: string;
  accountId: string;
  connectorType: string;
  sourceId: string;
  sourceType: string;
  payload: string;
  cleanedText: string | null;
  memoryId: string | null;
}

interface ProcessResult {
  resolved: number;
  linked: number;
  relationships: number;
  skipped: boolean;
  reason?: string;
}

const PEOPLE_PIPELINE_BATCH_SIZE = 1_000;

@Injectable()
export class PeoplePipelineService {
  private readonly logger = new Logger(PeoplePipelineService.name);

  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private accountsService: AccountsService,
    private connectors: ConnectorsService,
    private peopleService: PeopleService,
  ) {}

  async resetPeopleGraph(userId?: string): Promise<void> {
    await this.dbService.systemDb(async (db) => {
      if (!userId) {
        await db.delete(mergeDismissals);
        await db.delete(personRelationships);
        await db.delete(memoryPeople);
        await db.delete(personIdentifiers);
        await db.delete(people);
        await db
          .delete(settings)
          .where(or(like(settings.key, 'selfContactId%'), like(settings.key, 'selfPersonId%')));
        return;
      }

      const userPeople = db.select({ id: people.id }).from(people).where(eq(people.userId, userId));
      const userAccounts = db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, userId));
      const userMemories = db
        .select({ id: memories.id })
        .from(memories)
        .where(inArray(memories.accountId, userAccounts));

      await db
        .delete(mergeDismissals)
        .where(
          or(
            inArray(mergeDismissals.personId1, userPeople),
            inArray(mergeDismissals.personId2, userPeople),
          ),
        );
      await db
        .delete(personRelationships)
        .where(
          or(
            eq(personRelationships.userId, userId),
            inArray(personRelationships.sourcePersonId, userPeople),
            inArray(personRelationships.targetPersonId, userPeople),
          ),
        );
      await db
        .delete(memoryPeople)
        .where(
          or(
            inArray(memoryPeople.personId, userPeople),
            inArray(memoryPeople.memoryId, userMemories),
          ),
        );
      await db.delete(personIdentifiers).where(inArray(personIdentifiers.personId, userPeople));
      await db.delete(people).where(eq(people.userId, userId));
      await db
        .delete(settings)
        .where(
          or(
            eq(settings.key, `selfContactId:${userId}`),
            eq(settings.key, `selfPersonId:${userId}`),
          ),
        );
    });
  }

  async rebuildFromExistingData(
    options: { reset?: boolean; limit?: number; userId?: string } = {},
  ): Promise<{
    scanned: number;
    resolved: number;
    linked: number;
    relationships: number;
    skipped: number;
    failed: number;
  }> {
    if (options.reset) {
      await this.resetPeopleGraph(options.userId);
    }

    let offset = 0;
    let scanned = 0;
    let resolved = 0;
    let linked = 0;
    let relationships = 0;
    let skipped = 0;
    let failed = 0;

    while (options.limit == null || scanned < options.limit) {
      const batchLimit =
        options.limit == null
          ? PEOPLE_PIPELINE_BATCH_SIZE
          : Math.min(PEOPLE_PIPELINE_BATCH_SIZE, options.limit - scanned);
      const events = await this.loadPeoplePipelineEvents(batchLimit, offset, options.userId);
      if (!events.length) break;
      offset += events.length;

      for (const event of events) {
        scanned++;
        try {
          const result = await this.processRawEvent(event);
          if (result.skipped) skipped++;
          resolved += result.resolved;
          linked += result.linked;
          relationships += result.relationships;
        } catch (err) {
          failed++;
          this.logger.warn(
            `people pipeline failed for ${event.connectorType}:${event.sourceId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      this.logger.log(
        `people pipeline scanned=${scanned} resolved=${resolved} linked=${linked} relationships=${relationships} skipped=${skipped} failed=${failed}`,
      );
    }

    return { scanned, resolved, linked, relationships, skipped, failed };
  }

  async processRawEventById(rawEventId: string): Promise<ProcessResult> {
    const [raw] = await this.dbService.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEventId))
      .limit(1);
    if (!raw) return { resolved: 0, linked: 0, relationships: 0, skipped: true, reason: 'missing' };

    const [memory] = await this.dbService.db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.accountId, raw.accountId),
          eq(memories.sourceId, raw.sourceId),
          eq(memories.connectorType, raw.connectorType),
        ),
      )
      .limit(1);

    return this.processRawEvent({
      rawEventId: raw.id,
      accountId: raw.accountId,
      connectorType: raw.connectorType,
      sourceId: raw.sourceId,
      sourceType: raw.sourceType,
      payload: raw.payload,
      cleanedText: raw.cleanedText,
      memoryId: memory?.id ?? null,
    });
  }

  private async loadPeoplePipelineEvents(
    limit: number,
    offset: number,
    userId?: string,
  ): Promise<PeoplePipelineEvent[]> {
    const rows = await this.dbService.queryRaw<PeoplePipelineEvent>(
      `
        WITH candidates AS (
          SELECT
            re.id AS "rawEventId",
            re.account_id AS "accountId",
            re.connector_type AS "connectorType",
            re.source_id AS "sourceId",
            re.source_type AS "sourceType",
            re.payload,
            re.cleaned_text AS "cleanedText",
            re.created_at AS "createdAt",
            m.id AS "memoryId",
            CASE
              WHEN re.source_type IN ('contact', 'group') THEN 0
              WHEN re.source_id LIKE 'wa-group:%' THEN 0
              WHEN re.connector_type IN ('whatsapp', 'imessage', 'telegram') THEN 1
              WHEN re.connector_type IN ('gmail', 'outlook', 'slack') THEN 2
              WHEN re.connector_type IN ('locations', 'photos') THEN 3
              ELSE 4
            END AS priority,
            row_number() OVER (
              PARTITION BY re.account_id, re.connector_type, re.source_id
              ORDER BY re.created_at DESC, re.id ASC
            ) AS rn
          FROM raw_events re
          JOIN accounts a ON a.id = re.account_id
          LEFT JOIN memories m
            ON m.account_id = re.account_id
           AND m.source_id = re.source_id
           AND m.connector_type = re.connector_type
          WHERE
            ($3::text IS NULL OR a.user_id = $3::text)
            AND (
              m.id IS NOT NULL
              OR re.source_type IN ('contact', 'group')
              OR re.source_id LIKE 'wa-group:%'
              OR re.source_id LIKE 'telegram:contact:%'
            )
        )
        SELECT
          "rawEventId",
          "accountId",
          "connectorType",
          "sourceId",
          "sourceType",
          payload,
          "cleanedText",
          "memoryId"
        FROM candidates
        WHERE rn = 1
        ORDER BY
          priority,
          CASE
            WHEN "sourceType" IN ('contact', 'group') OR "sourceId" LIKE 'wa-group:%'
              THEN "createdAt"
          END DESC,
          CASE
            WHEN NOT ("sourceType" IN ('contact', 'group') OR "sourceId" LIKE 'wa-group:%')
              THEN "createdAt"
          END ASC,
          "rawEventId" ASC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset, userId ?? null],
    );
    return rows;
  }

  private async processRawEvent(raw: PeoplePipelineEvent): Promise<ProcessResult> {
    const event = this.parseEvent(raw);
    if (!event) {
      return { resolved: 0, linked: 0, relationships: 0, skipped: true, reason: 'bad_payload' };
    }
    event.sourceId = raw.sourceId;

    if (
      raw.connectorType === 'whatsapp' &&
      (raw.sourceId.startsWith('wa-group:') || event.sourceId.startsWith('wa-group:'))
    ) {
      return this.processWhatsAppGroupIdentity(raw, event);
    }

    if (
      raw.connectorType === 'whatsapp' &&
      (raw.sourceId.startsWith('wa-contact:') || event.sourceId.startsWith('wa-contact:'))
    ) {
      return this.processWhatsAppContactIdentity(raw, event);
    }

    const text =
      (raw.cleanedText ? this.crypto.decrypt(raw.cleanedText) || raw.cleanedText : '') ||
      event.content?.text ||
      '';

    const connector = this.connectors.get(raw.connectorType);
    const ctx = await this.buildPipelineContext(raw.accountId, raw.connectorType);
    const embedResult = await connector.embed(event, text, ctx);

    return this.resolveEntities(raw, event, embedResult);
  }

  private parseEvent(raw: Pick<RawEventRow, 'payload' | 'sourceId'>): ConnectorDataEvent | null {
    try {
      const parsed = JSON.parse(
        this.crypto.decrypt(raw.payload) || raw.payload,
      ) as ConnectorDataEvent;
      parsed.sourceId = raw.sourceId;
      return parsed;
    } catch {
      return null;
    }
  }

  private async resolveEntities(
    raw: PeoplePipelineEvent,
    event: ConnectorDataEvent,
    embedResult: EmbedResult,
  ): Promise<ProcessResult> {
    const ownerUserId = await this.getAccountOwnerUserId(raw.accountId);
    const buckets: Array<{ entityType: string; role: string; identifiers: IdentifierInput[] }> = [];

    for (const entity of embedResult.entities) {
      if (
        entity.type !== 'person' &&
        entity.type !== 'group' &&
        entity.type !== 'device' &&
        entity.type !== 'organization'
      ) {
        continue;
      }

      const identifiers = this.parseEntityIdentifiers(entity, raw.connectorType);
      if (
        raw.connectorType === 'gmail' &&
        entity.type === 'person' &&
        event.sourceType !== 'contact' &&
        !identifiers.some((id) => id.type === 'email')
      ) {
        continue;
      }

      if (
        raw.connectorType === 'gmail' &&
        entity.type === 'person' &&
        event.sourceType === 'contact' &&
        !identifiers.some((id) => id.type === 'email' || id.type === 'phone')
      ) {
        continue;
      }

      let merged = false;
      for (const bucket of buckets) {
        if (shouldMergeEntityResolutionBucket(entity.type, entity.role, bucket, identifiers)) {
          bucket.identifiers.push(...identifiers);
          merged = true;
          break;
        }
      }
      if (!merged) {
        buckets.push({ entityType: entity.type, role: entity.role, identifiers: [...identifiers] });
      }
    }

    let resolved = 0;
    let linked = 0;
    const linkedPeople = new Set<string>();

    for (const { entityType, role, identifiers } of buckets) {
      const resolveType = entityType === 'person' ? undefined : entityType;
      const person = await this.peopleService
        .resolvePerson(
          identifiers,
          resolveType as 'group' | 'organization' | 'device' | undefined,
          ownerUserId || undefined,
        )
        .catch((err) => {
          this.logger.debug(
            `people entity skipped for ${raw.connectorType}:${raw.sourceId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });
      if (!person) continue;
      resolved++;

      if (raw.memoryId && !linkedPeople.has(`${person.id}:${role}`)) {
        await this.peopleService.linkMemory(raw.memoryId, person.id, role);
        linkedPeople.add(`${person.id}:${role}`);
        linked++;
      }
    }

    return {
      resolved,
      linked,
      relationships: 0,
      skipped: resolved === 0,
      reason: resolved === 0 ? `${event.sourceType}:no_people` : undefined,
    };
  }

  private async processWhatsAppGroupIdentity(
    raw: PeoplePipelineEvent,
    event: ConnectorDataEvent,
  ): Promise<ProcessResult> {
    const identity = buildWhatsAppGroupIdentity(event, raw.connectorType);
    if (!identity) {
      return { resolved: 0, linked: 0, relationships: 0, skipped: true, reason: 'no_identity' };
    }

    const ownerUserId = await this.getAccountOwnerUserId(raw.accountId);
    const group = await this.peopleService.resolvePerson(
      identity.groupIdentifiers,
      'group',
      ownerUserId || undefined,
    );

    let resolved = 1;
    let relationships = 0;
    for (const member of identity.members) {
      const person = await this.peopleService
        .resolvePerson(member.identifiers, undefined, ownerUserId || undefined)
        .catch((err) => {
          this.logger.debug(
            `whatsapp group member skipped for ${identity.groupJid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });
      if (!person) continue;
      resolved++;
      await this.peopleService.upsertRelationship({
        sourcePersonId: person.id,
        targetPersonId: group.id,
        relationshipType: 'member_of',
        connectorType: raw.connectorType,
        sourceId: raw.sourceId,
        userId: ownerUserId,
        confidence: member.confidence,
        metadata: { groupJid: identity.groupJid, rawJid: member.rawJid },
      });
      relationships++;
    }

    return { resolved, linked: 0, relationships, skipped: false };
  }

  private async processWhatsAppContactIdentity(
    raw: PeoplePipelineEvent,
    event: ConnectorDataEvent,
  ): Promise<ProcessResult> {
    const identity = buildWhatsAppContactIdentity(event, raw.connectorType);
    if (!identity) {
      return { resolved: 0, linked: 0, relationships: 0, skipped: true, reason: 'no_identity' };
    }

    const ownerUserId = await this.getAccountOwnerUserId(raw.accountId);
    const person = await this.peopleService
      .resolvePerson(identity.identifiers, undefined, ownerUserId || undefined)
      .catch((err) => {
        this.logger.debug(
          `whatsapp contact skipped for ${event.sourceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });

    return {
      resolved: person ? 1 : 0,
      linked: 0,
      relationships: 0,
      skipped: !person,
      reason: person ? undefined : 'no_person',
    };
  }

  private parseEntityIdentifiers(
    entity: { type: string; id: string; role: string },
    connectorType: string,
  ): IdentifierInput[] {
    const identifiers: IdentifierInput[] = [];
    const parts = entity.id.split('|');
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) {
        identifiers.push({
          type: entity.type === 'person' ? 'name' : entity.type,
          value: part,
          connectorType,
        });
      } else {
        identifiers.push({
          type: part.slice(0, colonIdx),
          value: part.slice(colonIdx + 1),
          connectorType,
        });
      }
    }
    return identifiers;
  }

  private async getAccountOwnerUserId(accountId: string): Promise<string | null> {
    const [acct] = await this.dbService.db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return acct?.userId || null;
  }

  private async buildPipelineContext(
    accountId: string,
    connectorType: string,
  ): Promise<PipelineContext> {
    let auth: Record<string, unknown> = {};
    try {
      const account = await this.accountsService.getById(accountId);
      if (account.authContext) auth = JSON.parse(account.authContext) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(
        `auth context unavailable for ${connectorType}:${accountId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const logger: ConnectorLogger = {
      info: (msg) => this.logger.log(`[${connectorType}] ${msg}`),
      warn: (msg) => this.logger.warn(`[${connectorType}] ${msg}`),
      error: (msg) => this.logger.error(`[${connectorType}] ${msg}`),
      debug: (msg) => this.logger.debug(`[${connectorType}] ${msg}`),
    };
    return { accountId, auth, logger };
  }

  async validateNoNameOnlyPeople(): Promise<{ nameOnlyPeople: number; totalPeople: number }> {
    const rows = await this.dbService.queryRaw<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM people p
        WHERE COALESCE(p.entity_type, 'person') = 'person'
          AND NOT EXISTS (
            SELECT 1
            FROM person_identifiers pi
            WHERE pi.person_id = p.id
              AND pi.identifier_type <> 'name'
          )
      `,
    );
    const totals = await this.dbService.queryRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM people`,
    );
    return {
      nameOnlyPeople: Number(rows[0]?.count || 0),
      totalPeople: Number(totals[0]?.count || 0),
    };
  }
}
