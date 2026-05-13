import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { desc, eq, sql, and, or, inArray, type SQLWrapper } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { AiService } from './ai.service';
import { PgSearchService } from './pg-search.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PluginRegistry } from '../plugins/plugin-registry';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { Traced } from '../tracing/traced.decorator';
import {
  memories,
  memoryLinks,
  memorySearchIndex,
  memoryPeople,
  people,
  personIdentifiers,
  accounts,
  rawEvents,
  settings,
  users,
} from '../db/schema';
import { parseNlq } from './nlq-parser';
import {
  MIN_SCORE,
  HYBRID_K_MULTIPLIER,
  HYBRID_K_CAP,
  INJECTED_CONTACT_BASELINE,
  CONTACT_BOOST_MIXED,
  CONTACT_BOOST_PURE_MULTI,
  RECENCY_DECAY_RATE,
  DIVERSITY_FACTOR_DEFAULT,
  GRAPH_GROUP_STRENGTH,
  GRAPH_DIRECT_STRENGTH,
  GRAPH_LINK_SCORE,
  GRAPH_VECTOR_WEIGHT,
  GRAPH_BASE_SCORE,
  SCORING_PROFILES,
} from './search.constants';

/** Escape LIKE metacharacters so user input is treated as literal text. */
function escapeLike(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

const MINIMAL_STOPS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'he',
  'she',
  'his',
  'her',
  'they',
  'them',
  'their',
  'this',
  'that',
  'of',
  'in',
  'to',
  'for',
  'on',
  'at',
  'by',
  'with',
  'and',
  'or',
  'but',
  'if',
  'so',
  'as',
  'not',
  'no',
]);

const TITLE_PREFIXES = new Set(['dr.', 'dr', 'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms']);
const GROUPISH_CONTACT_WORDS = new Set([
  'family',
  'group',
  'chat',
  'channel',
  'team',
  'friends',
  'community',
]);
const GENERIC_CONVERSATION_WORDS = new Set([
  'chat',
  'chats',
  'conversation',
  'conversations',
  'message',
  'messages',
  'msg',
  'msgs',
  'text',
  'texts',
  'thread',
  'threads',
]);
const LEXICAL_QUERY_FILLER_WORDS = new Set([
  ...MINIMAL_STOPS,
  ...GENERIC_CONVERSATION_WORDS,
  'about',
  'anything',
  'detail',
  'details',
  'find',
  'give',
  'info',
  'information',
  'know',
  'latest',
  'newest',
  'please',
  'recent',
  'recently',
  'show',
  'tell',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
]);

function buildLexicalQuery(query: string, topicWords?: string[]): string {
  const source = topicWords ? topicWords.join(' ') : query;
  const words = source
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/'s$/i, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
    .filter((word) => word.length >= 2 && !LEXICAL_QUERY_FILLER_WORDS.has(word));
  return words.join(' ');
}

function searchCoverageTerms(query: string, topicWords?: string[]): string[] {
  return [...new Set(buildLexicalQuery(query, topicWords).split(/\s+/).filter(Boolean))];
}

function queryTokenCoverage(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const normalized = stripAccents(text.toLowerCase());
  let matches = 0;
  for (const term of terms) {
    const needle = stripAccents(term.toLowerCase());
    if (needle && normalized.includes(needle)) matches++;
  }
  return matches / terms.length;
}

const RECENCY_INTENT_TERMS = new Set(['latest', 'newest', 'recent', 'recently']);
const GENERIC_BOOKING_TERMS = new Set([
  'booking',
  'booked',
  'ticket',
  'tickets',
  'confirmation',
  'confirm',
  'reservation',
  'receipt',
]);

function hasRecencyIntent(query: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .some((word) => RECENCY_INTENT_TERMS.has(word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')));
}

function distinctiveCoverageTerms(terms: string[]): string[] {
  return terms.filter((term) => term.length >= 4 && !GENERIC_BOOKING_TERMS.has(term));
}

function objectText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(objectText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/base64|thumbnail|token|secret|credential|auth/i.test(key))
      .map(([, child]) => objectText(child))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function scoreQueryIntent(input: {
  query: string;
  coverageTerms: string[];
  text: string;
  metadata: unknown;
  eventTime: Date;
  weights: { recency?: number };
}): {
  sourceBoost: number;
  recencyBoost: number;
  negativePrior: number;
  distinctiveCoverage: number;
} {
  const normalizedText = stripAccents(input.text.toLowerCase());
  const metadataText = stripAccents(objectText(input.metadata).toLowerCase());
  const distinctiveTerms = distinctiveCoverageTerms(input.coverageTerms);
  const distinctiveMatches = distinctiveTerms.filter(
    (term) => normalizedText.includes(term) || metadataText.includes(term),
  ).length;
  const distinctiveCoverage = distinctiveTerms.length
    ? distinctiveMatches / distinctiveTerms.length
    : 0;

  const metadataMatches = distinctiveTerms.filter((term) => metadataText.includes(term)).length;
  const sourceBoost =
    metadataMatches > 0
      ? 1 + Math.min(0.25, (metadataMatches / Math.max(distinctiveTerms.length, 1)) * 0.25)
      : 1;

  const recencyBoost = hasRecencyIntent(input.query)
    ? 0.86 + Math.max(0, Math.min(1, input.weights.recency ?? 0)) * 0.32
    : 1;

  const queryHasGenericBooking = input.coverageTerms.some((term) =>
    GENERIC_BOOKING_TERMS.has(term),
  );
  const textHasGenericBooking = [...GENERIC_BOOKING_TERMS].some((term) =>
    normalizedText.includes(term),
  );
  const negativePrior =
    queryHasGenericBooking &&
    textHasGenericBooking &&
    distinctiveTerms.length > 0 &&
    distinctiveMatches === 0
      ? 0.72
      : 1;

  return { sourceBoost, recencyBoost, negativePrior, distinctiveCoverage };
}

interface SearchFilters {
  sourceType?: string;
  connectorType?: string;
  contactId?: string;
  contactIds?: string[];
  factualityLabel?: string;
  from?: string;
  to?: string;
  userId?: string;
  memoryBankId?: string;
  memoryBankIds?: string[]; // API key memory bank scoping
  accountIds?: string[]; // User isolation — filter by user's accounts
  // New multi-value filters for faceted search
  connectorTypes?: string[];
  sourceTypes?: string[];
  factualityLabels?: string[];
  personNames?: string[];
  pinned?: boolean;
  fromMe?: boolean;
}

type SearchIntent =
  | 'broad_topic'
  | 'person_lookup'
  | 'conversation'
  | 'location'
  | 'transaction'
  | 'recent_activity';

interface SearchDiagnostics {
  intent: SearchIntent;
  resolvedEntities: {
    contacts: { id: string; displayName: string }[];
    mode: 'hint' | 'filter' | 'fallback';
    topicWords: string[];
  };
  candidateLanes: Record<string, number>;
  appliedFilters: string[];
  skippedUndecryptableResultIds: string[];
  topScoreComponents: Array<{
    id: string;
    score: number;
    semantic: number;
    queryCoverage?: number;
    distinctiveCoverage?: number;
    sourceBoost?: number;
    recencyBoost?: number;
    negativePrior?: number;
    lanes: string[];
  }>;
  entityResolutionFallback?: 'disabled' | 'reran_without_entities';
  schemaStatus?: Awaited<ReturnType<PgSearchService['getSchemaStatus']>>;
}

/** Strip accents/diacritics for fuzzy matching (amélie → amelie) */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: string;
  connectorType: string;
  eventTime: Date;
  ingestTime: Date;
  createdAt: Date;
  factuality: unknown;
  entities: string;
  metadata: unknown;
  accountIdentifier: string | null;
  pinned: boolean;
  score: number;
  weights: {
    semantic: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
  people?: { role: string; personId: string; displayName: string }[];
  matchedContactIds?: string[];
  matchedContactRoles?: string[];
  topicCoverage?: number;
  matchMode?: 'hard_filter' | 'hint' | 'fallback';
  textSource?: 'body' | 'attachment_ocr' | 'metadata';
}

export interface ResolvedEntities {
  contacts: { id: string; displayName: string }[];
  topicWords: string[];
  topicMatchCount: number;
}

export interface ParsedQuery {
  temporal: { from: string; to: string } | null;
  temporalFallback?: boolean;
  entities: { id: string; displayName: string }[];
  intent: 'recall' | 'browse' | 'find';
  cleanQuery: string;
  sourceType?: string;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetCounts {
  connectorType: FacetValue[];
  sourceType: FacetValue[];
  factualityLabel: FacetValue[];
  people: FacetValue[];
}

export interface SearchResponse {
  items: SearchResult[];
  fallback: boolean;
  resolvedEntities?: ResolvedEntities;
  parsed?: ParsedQuery;
  facetCounts?: FacetCounts;
  found?: number;
  diagnostics?: SearchDiagnostics;
}

export interface RawMemoryAsset {
  contentType: string;
  fileName: string;
  contentLength: number | null;
  buffer: Buffer;
}

/** Check if candidate words match as whole-word boundaries in a contact name.
 *  Short words (<=4 chars) require exact match. Longer words allow prefix match at >=80% coverage. */
function nameWordsMatch(contactName: string, candidateWords: string[]): boolean {
  if (!contactName) return false;
  const nameWords = stripAccents(contactName.toLowerCase()).split(/\s+/);
  return candidateWords.every((cw) =>
    nameWords.some((nw) => {
      if (nw === cw) return true;
      // Only allow prefix matching for longer candidates (5+ chars) with high coverage
      if (cw.length >= 5 && nw.startsWith(cw) && cw.length / nw.length >= 0.8) return true;
      return false;
    }),
  );
}

function planSearchIntent(query: string): SearchIntent {
  const q = query.toLowerCase();
  if (/\b(where|location|located|last seen|near|at)\b/.test(q)) return 'location';
  if (/\b(sent|from|to|conversation|chat|dm|message|messages|thread|with)\b/.test(q)) {
    return 'conversation';
  }
  if (
    /\b(card|top ?up|credited|debited|transfer|amount|aed|usd|eur|bank|wio|payment|invoice)\b/.test(
      q,
    )
  ) {
    return 'transaction';
  }
  if (/\b(recent|latest|last|yesterday|today|this week|this month)\b/.test(q))
    return 'recent_activity';
  if (q.trim().split(/\s+/).length <= 3) return 'person_lookup';
  return 'broad_topic';
}

function extractTransactionTokens(query: string): string[] {
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9]+(?:[._-][a-z0-9]+)*|\b(?:aed|usd|eur|gbp|sar|egp)\b|\d+(?:[.,]\d+)?/g) ?? []
  );
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private contactsCache: Map<
    string,
    { data: { id: string; displayName: string; entityType: string }[]; expires: number }
  > = new Map();
  private static CONTACTS_CACHE_TTL = 60_000; // 60s

  constructor(
    private dbService: DbService,
    private ai: AiService,
    private searchIndex: PgSearchService,
    private connectors: ConnectorsService,
    private pluginRegistry: PluginRegistry,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
  ) {}

  /**
   * Decrypt memory fields using per-user DEK.
   * If DEK is wrong (stale), evicts it and returns placeholder.
   * If no DEK available, returns placeholder.
   */
  private decryptMemoryAuto<
    T extends {
      text: string;
      entities: string;
      claims: string;
      metadata: string;
    },
  >(mem: T, userId?: string | null, resolvedKey?: Buffer | null): T {
    const userKey = userId ? (resolvedKey ?? this.userKeyService.getKey(userId)) : null;

    if (userKey) {
      try {
        return this.crypto.decryptMemoryFieldsWithKeyStrict(mem, userKey);
      } catch {
        // DEK is wrong/stale — evict it so needsRecoveryKey triggers
        if (userId) this.userKeyService.removeKey(userId);
        this.logger.warn(`Stale DEK detected for user ${userId} — evicted`);
      }
    }

    // No key or bad key — return placeholder if text looks encrypted
    if (this.crypto.isEncrypted(mem.text)) {
      return {
        ...mem,
        text: '[Encrypted — enter your recovery key to view]',
        entities: '[]',
        claims: '[]',
      };
    }

    // Plaintext passthrough (e.g. demo data)
    return mem;
  }

  /** Resolve user key once (async) for use in batch decryption. */
  async resolveUserKey(userId?: string | null): Promise<Buffer | null> {
    if (!userId) return null;
    return this.userKeyService.getDek(userId);
  }

  private isLockedMemory(mem: { text: string }): boolean {
    return mem.text.startsWith('[Encrypted') || this.crypto.isEncrypted(mem.text);
  }

  private safeDecryptAppField(value: string | null): string | null {
    if (!value) return null;
    const decrypted = this.crypto.decrypt(value);
    const candidate = decrypted ?? value;
    return this.crypto.isEncrypted(candidate) ? null : candidate;
  }

  private factualityForResponse(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const decrypted = this.safeDecryptAppField(value);
    if (!decrypted) return null;
    try {
      return JSON.parse(decrypted);
    } catch {
      try {
        return JSON.parse(value);
      } catch {
        return this.crypto.isEncrypted(value) ? null : value;
      }
    }
  }

  private metadataObject(value: unknown): Record<string, unknown> {
    const parsed = this.parseMaybeJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  private matchesFromMeFilter(metadata: unknown, fromMe?: boolean): boolean {
    if (fromMe === undefined) return true;
    const object = this.metadataObject(metadata);
    if (object.fromMe !== undefined) return object.fromMe === fromMe;
    if (object.isFromMe !== undefined) return object.isFromMe === fromMe;
    if (object.direction === 'outgoing') return fromMe === true;
    if (object.direction === 'incoming') return fromMe === false;
    return false;
  }

  private matchesActivityFilter(item: {
    sourceType?: string | null;
    connectorType?: string | null;
    metadata?: unknown;
  }): boolean {
    if (this.matchesFromMeFilter(item.metadata, true)) return true;

    const sourceType = item.sourceType?.toLowerCase();
    const connectorType = item.connectorType?.toLowerCase();
    if (sourceType === 'photo' || sourceType === 'location') return true;
    if (connectorType === 'photos' || connectorType === 'locations') return true;

    return false;
  }

  /** Check if user has encrypted memories but no decryption key available. */
  async needsRecoveryKey(userId?: string): Promise<boolean> {
    if (!userId) return false;
    const sample = await this.findEncryptedMemorySample(userId);
    const dek = await this.userKeyService.getDek(userId);

    if (!sample) {
      if (dek) return false;
      return this.hasRawEventPipelineDebt(userId);
    }

    if (!dek) return true;

    try {
      this.crypto.decryptWithKeyStrict(sample.text, dek);
      return false;
    } catch {
      this.logger.warn(`needsRecoveryKey: stale DEK for user ${userId} — clearing cache tiers`);
      await this.userKeyService.clearDek(userId);
      return true;
    }
  }

  /**
   * Validate cached DEK by trial-decrypting one memory.
   * If DEK is stale/wrong, evicts it so needsRecoveryKey returns true.
   * Returns true if recovery key is needed after validation.
   */
  async validateDek(userId?: string): Promise<boolean> {
    if (!userId) return false;
    return this.needsRecoveryKey(userId);
  }

  /** @deprecated Use needsRecoveryKey instead */
  async needsRelogin(userId?: string): Promise<boolean> {
    return this.needsRecoveryKey(userId);
  }

  /**
   * Fetch linked people for a batch of memory IDs.
   * Returns a map: memoryId → [{ role, personId, displayName }]
   */
  async getPeopleForMemories(
    memoryIds: string[],
  ): Promise<Map<string, { role: string; personId: string; displayName: string }[]>> {
    if (!memoryIds.length) return new Map();
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          memoryId: memoryPeople.memoryId,
          role: memoryPeople.role,
          personId: memoryPeople.personId,
          displayName: people.displayName,
        })
        .from(memoryPeople)
        .innerJoin(people, eq(memoryPeople.personId, people.id))
        .where(inArray(memoryPeople.memoryId, memoryIds)),
    );
    const map = new Map<string, { role: string; personId: string; displayName: string }[]>();
    for (const r of rows) {
      const decrypted = this.crypto.decrypt(r.displayName) ?? r.displayName;
      const entry = { role: r.role, personId: r.personId, displayName: decrypted };
      const existing = map.get(r.memoryId);
      if (existing) existing.push(entry);
      else map.set(r.memoryId, [entry]);
    }
    return map;
  }

  private metadataForResponseWithLinkedPeople(
    memory: Pick<typeof memories.$inferSelect, 'connectorType' | 'sourceType' | 'metadata'>,
    linkedPeople?: { role: string; displayName: string }[],
  ): unknown {
    const metadata = this.sanitizeMetadataForResponse(memory.metadata);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;

    const object = { ...(metadata as Record<string, unknown>) };
    if (memory.connectorType !== 'whatsapp' || memory.sourceType !== 'message') return object;

    const isIncoming = object.fromMe === false || object.isFromMe === false;
    if (!isIncoming) return object;

    const currentSender = typeof object.senderName === 'string' ? object.senderName.trim() : '';
    if (currentSender && currentSender.toLowerCase() !== 'unknown') return object;

    const linkedSender = linkedPeople?.find((person) => person.role === 'sender')?.displayName;
    const fallback = [linkedSender, object.senderPhone, object.pushName, object.senderLid]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find(Boolean);
    if (fallback) object.senderName = fallback;
    return object;
  }

  /** Invalidate contacts cache (call after contact writes) */
  invalidateContactsCache(userId?: string) {
    if (userId) {
      this.contactsCache.delete(userId);
    } else {
      this.contactsCache.clear();
    }
  }

  /** Get account IDs belonging to a user — used for data isolation */
  /**
   * Returns account IDs for a user. null = no user filter (internal/system calls).
   * Empty array = user exists but has no accounts (should see zero data).
   */
  async getUserAccountIds(userId?: string, connectorTypes?: string[]): Promise<string[] | null> {
    if (!userId) return null;
    const connectorTypeSet = connectorTypes
      ? Array.from(new Set(connectorTypes.filter(Boolean)))
      : undefined;
    const conditions = [eq(accounts.userId, userId)];
    if (connectorTypeSet?.length) {
      conditions.push(inArray(accounts.connectorType, connectorTypeSet));
    }
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(...conditions)),
    );
    return rows.map((r) => r.id);
  }

  private async findEncryptedMemorySample(userId: string): Promise<{ text: string } | null> {
    const userAccountIds = await this.getUserAccountIds(userId);
    if (!userAccountIds?.length) return null;

    // Avoid a leading-wildcard scan over encrypted text on every dashboard request.
    // A small indexed account/event-time sample is enough to validate the cached user key.
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ text: memories.text })
        .from(memories)
        .where(inArray(memories.accountId, userAccountIds))
        .orderBy(desc(memories.eventTime))
        .limit(25),
    );

    return rows.find((row) => this.crypto.isEncrypted(row.text)) ?? null;
  }

  private async hasRawEventPipelineDebt(userId: string): Promise<boolean> {
    const userAccountIds = await this.getUserAccountIds(userId);
    if (!userAccountIds?.length) return false;

    const [userRow] = await this.dbService.withCurrentUser((db) =>
      db
        .select({ recoveryKeyHash: users.recoveryKeyHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    if (!userRow?.recoveryKeyHash) return false;

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: rawEvents.id })
        .from(rawEvents)
        .where(
          and(
            inArray(rawEvents.accountId, userAccountIds),
            inArray(rawEvents.processingState, ['pending', 'failed', 'quota_blocked']),
            sql`${rawEvents.sourceType} NOT IN ('contact', 'group')`,
          ),
        )
        .limit(1),
    );

    return rows.length > 0;
  }

  private async getCachedContacts(
    userId?: string,
  ): Promise<{ id: string; displayName: string; entityType: string; memoryCount: number }[]> {
    const cacheKey = userId || '__none__';
    const cached = this.contactsCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }
    const rawData = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: people.id,
          displayName: people.displayName,
          entityType: people.entityType,
          memoryCount: people.memoryCount,
        })
        .from(people),
    );
    const data = rawData.map((c) => ({
      ...c,
      displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
    }));
    this.contactsCache.set(cacheKey, {
      data,
      expires: Date.now() + MemoryService.CONTACTS_CACHE_TTL,
    });
    return data;
  }

  private async getContactsByIds(
    ids: string[],
    userId?: string,
  ): Promise<{ id: string; displayName: string; entityType: string; memoryCount: number }[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return [];
    const allContacts = await this.getCachedContacts(userId);
    const idSet = new Set(uniqueIds);
    return allContacts.filter((contact) => idSet.has(contact.id));
  }

  private inferTextSource(metadata: unknown): 'body' | 'attachment_ocr' | 'metadata' {
    const object = this.metadataObject(metadata);
    const mediaExtraction = object.mediaExtraction;
    if (
      mediaExtraction &&
      typeof mediaExtraction === 'object' &&
      typeof (mediaExtraction as Record<string, unknown>).extractedText === 'string'
    ) {
      return 'attachment_ocr';
    }
    return 'body';
  }

  /** Build a human-friendly label for photo/file memories from metadata instead of text. */
  private buildMediaLabel(
    sourceType: string,
    metadata: Record<string, unknown>,
    entityNames: string[],
    eventTime: string | null,
    text: string,
  ): string {
    if (sourceType !== 'photo' && sourceType !== 'file') {
      return text.slice(0, 60);
    }

    const parts: string[] = [];

    // People detected
    const people = metadata.people as Array<{ name?: string } | string> | undefined;
    if (people?.length) {
      const names = people.map((p) => (typeof p === 'string' ? p : p.name || '')).filter(Boolean);
      if (names.length) parts.push(names.slice(0, 3).join(', '));
    }

    // Location
    const locParts = [metadata.city, metadata.state, metadata.country].filter(Boolean) as string[];
    if (locParts.length) parts.push(locParts.join(', '));

    // File name as fallback context
    if (!parts.length && metadata.fileName) {
      parts.push(String(metadata.fileName));
    }

    // Entity names as fallback
    if (!parts.length && entityNames.length) {
      parts.push(entityNames.slice(0, 3).join(', '));
    }

    // Date
    if (eventTime) {
      const d = new Date(eventTime);
      if (!isNaN(d.getTime())) {
        parts.push(
          d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        );
      }
    }

    if (!parts.length) {
      return sourceType === 'photo' ? 'Photo' : 'File';
    }

    const label = parts.join(' \u2022 ');
    return label.length > 80 ? label.slice(0, 77) + '...' : label;
  }

  private getTrustScore(connectorType: string): number {
    try {
      return this.connectors.get(connectorType).manifest.trustScore;
    } catch {
      return 0.7;
    }
  }

  private getWeights(connectorType: string): {
    semantic: number;
    recency: number;
    importance: number;
    trust: number;
  } {
    const defaults = { semantic: 0.3, recency: 0.35, importance: 0.2, trust: 0.15 };
    try {
      const w = this.connectors.get(connectorType).manifest.weights;
      return {
        semantic: w?.semantic ?? defaults.semantic,
        recency: w?.recency ?? defaults.recency,
        importance: w?.importance ?? defaults.importance,
        trust: w?.trust ?? defaults.trust,
      };
    } catch {
      return defaults;
    }
  }

  private diversifyResults(
    candidates: Array<{
      id: string;
      row: any;
      score: number;
      weights: any;
      queryCoverage?: number;
    }>,
    limit: number,
    diversityFactor = DIVERSITY_FACTOR_DEFAULT,
  ): Array<{ id: string; row: any; score: number; weights: any; queryCoverage?: number }> {
    if (candidates.length <= 1) return candidates.slice(0, limit);

    const sorted = [...candidates].sort(
      (a, b) => b.score - a.score || (b.queryCoverage ?? 0) - (a.queryCoverage ?? 0),
    );

    // Group by connector type
    const groups = new Map<string, typeof sorted>();
    for (const c of sorted) {
      const ct = c.row.memory?.connectorType || c.row.connectorType || 'unknown';
      if (!groups.has(ct)) groups.set(ct, []);
      groups.get(ct)!.push(c);
    }

    const result: typeof sorted = [];
    const selectedCounts = new Map<string, number>();

    while (result.length < limit) {
      // Find globally best remaining
      let bestCandidate: (typeof sorted)[0] | null = null;
      let bestConnector = '';
      for (const [ct, list] of groups) {
        if (list.length && (!bestCandidate || list[0].score > bestCandidate.score)) {
          bestCandidate = list[0];
          bestConnector = ct;
        }
      }
      if (!bestCandidate) break;

      const bestScore = bestCandidate.score;
      const minThreshold = bestScore - diversityFactor;

      // Find least-represented connector with candidate above threshold
      let diversePick: { connector: string; candidate: (typeof sorted)[0] } | null = null;
      let minCount = Infinity;

      for (const [ct, list] of groups) {
        if (!list.length) continue;
        const count = selectedCounts.get(ct) || 0;
        if (count < minCount && list[0].score >= minThreshold) {
          minCount = count;
          diversePick = { connector: ct, candidate: list[0] };
        } else if (
          count === minCount &&
          diversePick &&
          list[0].score > diversePick.candidate.score
        ) {
          diversePick = { connector: ct, candidate: list[0] };
        }
      }

      const pick = diversePick || { connector: bestConnector, candidate: bestCandidate };
      result.push(pick.candidate);
      selectedCounts.set(pick.connector, (selectedCounts.get(pick.connector) || 0) + 1);
      groups.get(pick.connector)!.shift();
    }

    return result;
  }

  /**
   * Greedy multi-word entity resolution: tries longest spans first against contact names.
   * "assad mansoor car" → contacts: [Assad Mansoor], topicWords: ["car"]
   * Uses word-boundary matching so "car" does NOT match "Ricardo".
   */
  private async resolveEntities(
    queryWords: string[],
    userId?: string,
  ): Promise<{
    contacts: { id: string; displayName: string }[];
    topicWords: string[];
    droppedGenericTopicWords: string[];
    contactIds: string[];
  }> {
    const allContacts = (await this.getCachedContacts(userId)).filter(
      (c) => !c.entityType || c.entityType === 'person',
    );

    const resolved: { id: string; displayName: string }[] = [];
    const remaining = [...queryWords];
    const usedIndices = new Set<number>();

    // Try progressively shorter spans starting from each position
    let i = 0;
    while (i < remaining.length) {
      let matched = false;
      for (let spanLen = remaining.length - i; spanLen >= 1; spanLen--) {
        const candidateWords = remaining.slice(i, i + spanLen).map((w) => stripAccents(w));

        const contactMatches = allContacts
          .filter((c) => nameWordsMatch(c.displayName, candidateWords))
          .sort((a, b) => {
            const aWords = stripAccents((a.displayName || '').toLowerCase()).split(/\s+/);
            const bWords = stripAccents((b.displayName || '').toLowerCase()).split(/\s+/);
            const aExact = aWords.length === candidateWords.length ? 1 : 0;
            const bExact = bWords.length === candidateWords.length ? 1 : 0;
            const aStarts = aWords[0] === candidateWords[0] ? 1 : 0;
            const bStarts = bWords[0] === candidateWords[0] ? 1 : 0;
            return (
              bExact - aExact ||
              bStarts - aStarts ||
              Math.log10((b.memoryCount || 0) + 1) - Math.log10((a.memoryCount || 0) + 1) ||
              a.displayName.localeCompare(b.displayName)
            );
          });

        for (const c of contactMatches) {
          // For single-word candidates, require the candidate covers a significant
          // portion of the name (avoid "car" matching "Nomi Car Lift")
          const nameWordsRaw = stripAccents((c.displayName || '').toLowerCase()).split(/\s+/);
          const nameWordCount = nameWordsRaw.length;
          if (candidateWords.length === 1 && nameWordCount > 1) {
            if (nameWordsRaw.some((w) => GROUPISH_CONTACT_WORDS.has(w))) continue;
            const prevWord = i > 0 ? remaining[i - 1] : '';
            const hasPersonCue = ['with', 'from', 'to', 'sent', 'by', 'where', 'is'].includes(
              prevWord,
            );
            if (remaining.length > 1 && i > 0 && !hasPersonCue) continue;
            // Only match first real word of multi-word names (prevents "insurance" → "Osama Insurance")
            const nameWordsClean = nameWordsRaw.filter((w) => !TITLE_PREFIXES.has(w));
            const firstNameWord = nameWordsClean[0] || nameWordsRaw[0];
            const cw = candidateWords[0];
            const matchesFirst =
              firstNameWord === cw ||
              (cw.length >= 5 &&
                firstNameWord.startsWith(cw) &&
                cw.length / firstNameWord.length >= 0.8);
            if (!matchesFirst) continue;
          }
          if (!resolved.some((r) => r.id === c.id)) {
            resolved.push(c);
          }
          for (let j = i; j < i + spanLen; j++) usedIndices.add(j);
          matched = true;
          break;
        }
        if (matched) {
          i += spanLen;
          break;
        }
      }
      if (!matched) i++;
    }

    const unusedWords = remaining.filter((_, idx) => !usedIndices.has(idx));
    const topicWords = unusedWords.filter(
      (w) => !MINIMAL_STOPS.has(w) && !GENERIC_CONVERSATION_WORDS.has(w),
    );
    const droppedGenericTopicWords = unusedWords.filter((w) => GENERIC_CONVERSATION_WORDS.has(w));
    const contactIds = resolved.map((c) => c.id);

    return { contacts: resolved, topicWords, droppedGenericTopicWords, contactIds };
  }

  @Traced('memory.search')
  async search(
    query: string,
    filters?: SearchFilters,
    limit = 20,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
    diversityFactor?: number,
    options?: { debug?: boolean; noEntityResolution?: boolean },
  ): Promise<SearchResponse> {
    if (!query.trim()) return { items: [], fallback: false };

    // Pre-resolve user decryption key (async 2-tier: memory → Redis)
    const resolvedKey = await this.resolveUserKey(userId);

    // --- NLQ parsing (pure, synchronous) ---
    const nlq = parseNlq(query);
    const plannedIntent = planSearchIntent(query);
    const effectiveFilters: SearchFilters = { ...filters };
    const diagnostics: SearchDiagnostics | undefined = options?.debug
      ? {
          intent: plannedIntent,
          resolvedEntities: { contacts: [], mode: 'hint', topicWords: [] },
          candidateLanes: {},
          appliedFilters: [],
          skippedUndecryptableResultIds: [],
          topScoreComponents: [],
        }
      : undefined;

    // --- User isolation: resolve account IDs ---
    // Narrow account scope before Postgres search when connector filters are present.
    // A full account_id list combined with connector_type filters can exceed the
    // Postgres search client timeout even when the matching connector has one account.
    const connectorScope = [
      ...(filters?.connectorTypes ?? []),
      ...(filters?.connectorType ? [filters.connectorType] : []),
    ];
    const userAccountIds = await this.getUserAccountIds(
      userId,
      connectorScope.length ? connectorScope : undefined,
    );
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { items: [], fallback: false };
      effectiveFilters.accountIds = userAccountIds;
    }

    // Apply memory bank scoping
    if (memoryBankId) effectiveFilters.memoryBankId = memoryBankId;
    else if (memoryBankIds?.length) effectiveFilters.memoryBankIds = memoryBankIds;

    // Apply temporal filters from NLQ (only if caller didn't provide explicit from/to)
    if (nlq.temporal && !filters?.from && !filters?.to) {
      effectiveFilters.from = nlq.temporal.from;
      effectiveFilters.to = nlq.temporal.to;
    }

    // Apply source type hint from NLQ (only if caller didn't provide explicit sourceType)
    if (nlq.sourceTypeHint && !filters?.sourceType) {
      effectiveFilters.sourceType = nlq.sourceTypeHint;
    }

    // Apply intent-based limit: find intent caps at 5
    let effectiveLimit = limit;
    if (nlq.intent === 'find') {
      effectiveLimit = Math.min(limit, 5);
    }

    // Use clean query for embeddings (stripped of temporal tokens)
    const embeddingQuery = nlq.cleanQuery;

    // --- Entity resolution ---
    const queryLower = query.toLowerCase();
    const queryWords = queryLower
      .split(/\s+/)
      .map((w) => w.replace(/'s$/i, ''))
      .filter((w) => w.length >= 2);

    const entityResult = options?.noEntityResolution
      ? {
          contacts: [],
          topicWords: queryWords.filter((w) => !MINIMAL_STOPS.has(w)),
          droppedGenericTopicWords: [],
          contactIds: [],
        }
      : await this.resolveEntities(queryWords, userId);
    let { contacts: resolvedContacts, contactIds } = entityResult;
    const { topicWords, droppedGenericTopicWords } = entityResult;
    const explicitContactIds = [
      ...new Set([
        ...(effectiveFilters.contactIds ?? []),
        ...(effectiveFilters.contactId ? [effectiveFilters.contactId] : []),
      ]),
    ];
    const hardContactFilter = explicitContactIds.length > 0;
    if (hardContactFilter) {
      const explicitContacts = await this.getContactsByIds(explicitContactIds, userId);
      const contactMap = new Map(resolvedContacts.map((contact) => [contact.id, contact]));
      for (const contact of explicitContacts) {
        contactMap.set(contact.id, { id: contact.id, displayName: contact.displayName });
      }
      resolvedContacts = [...contactMap.values()];
      contactIds = explicitContactIds;
    }
    const hasContacts = contactIds.length > 0;
    if (diagnostics && options?.noEntityResolution) {
      diagnostics.entityResolutionFallback = 'disabled';
    }

    // --- Build Qdrant-format filter (Postgres searchService converts internally) ---
    const tsFilter = this.buildQdrantFilter(effectiveFilters);

    // --- Build Postgres search filter string for faceted search ---
    const tsFilterString = this.searchIndex.buildFilterString({
      connectorTypes: effectiveFilters.connectorTypes,
      sourceTypes: effectiveFilters.sourceTypes,
      factualityLabels: effectiveFilters.factualityLabels,
      personNames: effectiveFilters.personNames,
      pinned: effectiveFilters.pinned,
      accountIds: effectiveFilters.accountIds,
      memoryBankId: effectiveFilters.memoryBankId,
      memoryBankIds: effectiveFilters.memoryBankIds,
    });

    // Merge legacy Qdrant-format filter with new filter string
    const legacyFilterStr = Object.keys(tsFilter).length
      ? this.searchIndex.buildLegacyFilter(tsFilter)
      : '';
    const combinedFilter =
      [legacyFilterStr, tsFilterString].filter(Boolean).join(' && ') || undefined;
    if (diagnostics) {
      diagnostics.appliedFilters = [legacyFilterStr, tsFilterString].filter(Boolean);
      diagnostics.schemaStatus = await this.searchIndex.getSchemaStatus().catch(() => undefined);
    }

    const FACET_FIELDS = 'connector_type,source_type,factuality_label,people';

    // --- Single Postgres search hybrid search call with facets ---
    const vector = await this.ai.embedQuery(embeddingQuery);
    // Cap k to avoid Postgres search hybrid search failure at high k values (k>250 with filters can return 0)
    const hybridK = Math.min(effectiveLimit * HYBRID_K_MULTIPLIER, HYBRID_K_CAP);
    const hybridResult = await this.searchIndex.hybridSearch(
      embeddingQuery,
      vector,
      hybridK,
      combinedFilter,
      FACET_FIELDS,
    );
    const searchIndexResults = hybridResult.results;
    const semanticScores = new Map<string, number>();
    const candidateLanes = new Map<string, Set<string>>();
    const noteLane = (id: string, lane: string) => {
      const lanes = candidateLanes.get(id) ?? new Set<string>();
      lanes.add(lane);
      candidateLanes.set(id, lanes);
    };
    for (const point of searchIndexResults) {
      semanticScores.set(point.id, point.score);
      noteLane(point.id, 'vector_semantic');
    }

    const lexicalQuery = buildLexicalQuery(embeddingQuery, hasContacts ? topicWords : undefined);
    const lexicalResults = lexicalQuery
      ? await this.searchIndex.textSearch(
          lexicalQuery,
          hybridK,
          combinedFilter,
          'text,entities_text,people,locations,location_text,organizations',
        )
      : [];
    for (const point of lexicalResults) {
      semanticScores.set(point.id, Math.max(semanticScores.get(point.id) ?? 0, point.score, 0.72));
      noteLane(point.id, 'lexical_exact');
    }

    if (plannedIntent === 'transaction') {
      const txQuery = extractTransactionTokens(query).join(' ');
      if (txQuery) {
        const txResults = await this.searchIndex.textSearch(
          txQuery,
          hybridK,
          combinedFilter,
          'transaction_tokens,text',
        );
        for (const point of txResults) {
          semanticScores.set(
            point.id,
            Math.max(semanticScores.get(point.id) ?? 0, point.score, 0.76),
          );
          noteLane(point.id, 'transaction_tokens');
        }
      }
    }

    // --- Contact boost: identify which results belong to resolved contacts ---
    const contactMatchIds = new Set<string>();
    // Track how many resolved contacts each memory is linked to (for multi-contact boost)
    const contactMatchCount = new Map<string, number>();
    const contactIdsByMemory = new Map<string, Set<string>>();
    const contactRolesByMemory = new Map<string, Set<string>>();
    let topicMatchCount = 0;
    // When query is purely contact names (no topic words), collect ALL contact memories
    const isPureContactQuery = hasContacts && topicWords.length === 0;
    let allContactMemoryIds = new Set<string>();
    if (hasContacts) {
      if (diagnostics) {
        diagnostics.resolvedEntities = {
          contacts: resolvedContacts,
          mode: hardContactFilter ? 'filter' : 'hint',
          topicWords,
        };
      }
      const linked = await this.dbService.withCurrentUser((db) =>
        db
          .select({
            memoryId: memoryPeople.memoryId,
            personId: memoryPeople.personId,
            role: memoryPeople.role,
          })
          .from(memoryPeople)
          .where(inArray(memoryPeople.personId, contactIds)),
      );
      allContactMemoryIds = new Set(linked.map((r) => r.memoryId));
      // Count how many resolved contacts each memory is linked to
      for (const r of linked) {
        contactMatchCount.set(r.memoryId, (contactMatchCount.get(r.memoryId) || 0) + 1);
        const ids = contactIdsByMemory.get(r.memoryId) ?? new Set<string>();
        ids.add(r.personId);
        contactIdsByMemory.set(r.memoryId, ids);
        const roles = contactRolesByMemory.get(r.memoryId) ?? new Set<string>();
        roles.add(r.role);
        contactRolesByMemory.set(r.memoryId, roles);
        if (isPureContactQuery) {
          semanticScores.set(r.memoryId, Math.max(semanticScores.get(r.memoryId) ?? 0, 0.68));
          noteLane(r.memoryId, 'structured_person_role');
        }
      }
      for (const point of [...searchIndexResults, ...lexicalResults]) {
        if (allContactMemoryIds.has(point.id)) contactMatchIds.add(point.id);
      }
      topicMatchCount = contactMatchIds.size;
    }

    // A bare person-name query should behave like opening that person's timeline.
    // Most chat messages do not repeat the participant's name, so ranking literal
    // name matches first hides the recent conversation the user is asking for.
    if (isPureContactQuery && contactIds.length > 0) {
      const contactConditions: SQLWrapper[] = [
        inArray(memoryPeople.personId, contactIds),
        eq(memories.pipelineComplete, true),
      ];
      if (effectiveFilters.accountIds?.length) {
        contactConditions.push(inArray(memories.accountId, effectiveFilters.accountIds));
      }
      if (effectiveFilters.memoryBankId) {
        contactConditions.push(eq(memories.memoryBankId, effectiveFilters.memoryBankId));
      } else if (effectiveFilters.memoryBankIds?.length) {
        contactConditions.push(inArray(memories.memoryBankId, effectiveFilters.memoryBankIds));
      }
      if (effectiveFilters.connectorType) {
        contactConditions.push(eq(memories.connectorType, effectiveFilters.connectorType));
      }
      if (effectiveFilters.connectorTypes?.length) {
        contactConditions.push(inArray(memories.connectorType, effectiveFilters.connectorTypes));
      }
      if (effectiveFilters.sourceType) {
        contactConditions.push(eq(memories.sourceType, effectiveFilters.sourceType));
      }
      if (effectiveFilters.sourceTypes?.length) {
        contactConditions.push(inArray(memories.sourceType, effectiveFilters.sourceTypes));
      }
      if (effectiveFilters.from) {
        contactConditions.push(sql`${memories.eventTime} >= ${effectiveFilters.from}`);
      }
      if (effectiveFilters.to) {
        contactConditions.push(sql`${memories.eventTime} <= ${effectiveFilters.to}`);
      }
      if (effectiveFilters.factualityLabels?.length) {
        contactConditions.push(
          inArray(memories.factualityLabel, effectiveFilters.factualityLabels),
        );
      }
      if (effectiveFilters.pinned !== undefined) {
        contactConditions.push(eq(memories.pinned, effectiveFilters.pinned));
      }

      const recentRows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memory: memories, accountIdentifier: accounts.identifier })
          .from(memoryPeople)
          .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
          .leftJoin(accounts, eq(memories.accountId, accounts.id))
          .where(and(...contactConditions)!)
          .orderBy(desc(memories.eventTime))
          .limit(effectiveLimit * Math.max(contactIds.length, 1) * 3),
      );

      const seen = new Set<string>();
      const items: SearchResult[] = [];
      for (const row of recentRows) {
        if (seen.has(row.memory.id)) continue;
        seen.add(row.memory.id);
        const { score, weights } = this.computeWeights(0.9, row.memory, nlq.intent);
        items.push(
          this.toSearchResult(row, score, weights, userId, resolvedKey, {
            matchedContactIds: [...(contactIdsByMemory.get(row.memory.id) ?? new Set(contactIds))],
            matchedContactRoles: [...(contactRolesByMemory.get(row.memory.id) ?? new Set())],
            topicCoverage: 1,
            matchMode: hardContactFilter ? 'hard_filter' : 'hint',
          }),
        );
        if (items.length >= effectiveLimit) break;
      }

      void this.pluginRegistry.fireHook('afterSearch', {
        query,
        resultCount: items.length,
        topScore: items[0]?.score,
      });

      const filteredItems = items.filter((item) => {
        if (item.text.startsWith('[Encrypted')) {
          diagnostics?.skippedUndecryptableResultIds.push(item.id);
          return false;
        }
        return this.matchesFromMeFilter(item.metadata, effectiveFilters.fromMe);
      });

      if (
        filteredItems.length === 0 &&
        !options?.noEntityResolution &&
        (!hasContacts || topicWords.length > 0 || droppedGenericTopicWords.length === 0)
      ) {
        const fallbackResult = await this.search(
          query,
          filters,
          limit,
          userId,
          memoryBankId,
          memoryBankIds,
          diversityFactor,
          { ...options, noEntityResolution: true },
        );
        if (fallbackResult.items.length > 0) {
          return {
            ...fallbackResult,
            fallback: true,
            resolvedEntities: {
              contacts: resolvedContacts,
              topicWords,
              topicMatchCount,
            },
            diagnostics: fallbackResult.diagnostics
              ? {
                  ...fallbackResult.diagnostics,
                  resolvedEntities: {
                    contacts: resolvedContacts,
                    mode: 'fallback',
                    topicWords,
                  },
                  entityResolutionFallback: 'reran_without_entities',
                }
              : undefined,
          };
        }
      }

      return {
        items: filteredItems,
        fallback: false,
        resolvedEntities: { contacts: resolvedContacts, topicWords, topicMatchCount },
        parsed: {
          temporal: nlq.temporal,
          entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
          intent: nlq.intent,
          cleanQuery: nlq.cleanQuery,
          sourceType: nlq.sourceTypeHint ?? undefined,
        },
        diagnostics,
      };
    }

    const exactLaneIds = new Set(
      [...candidateLanes.entries()]
        .filter(([, lanes]) => lanes.has('lexical_exact') || lanes.has('transaction_tokens'))
        .map(([id]) => id),
    );

    // If filtering by contact ids directly, filter search results to those contact-linked memories.
    if (hardContactFilter) {
      const linkedMemoryIds = new Set(
        (
          await this.dbService.withCurrentUser((db) =>
            db
              .select({ memoryId: memoryPeople.memoryId })
              .from(memoryPeople)
              .where(inArray(memoryPeople.personId, explicitContactIds)),
          )
        ).map((r) => r.memoryId),
      );
      const contactResults: SearchResult[] = [];
      const contactPoints = new Map(
        [...searchIndexResults, ...lexicalResults].map((p) => [p.id, p]),
      );
      const coverageTerms = searchCoverageTerms(embeddingQuery, topicWords);
      for (const point of contactPoints.values()) {
        if (!linkedMemoryIds.has(point.id)) continue;
        const row = await this.fetchMemoryRow(point.id);
        if (!row) continue;
        const memoryForCoverage = this.decryptMemoryAuto(row.memory, userId, resolvedKey);
        const queryCoverage = queryTokenCoverage(memoryForCoverage.text, coverageTerms);
        const hasTopicSupport =
          topicWords.length === 0 || queryCoverage > 0 || exactLaneIds.has(point.id);
        if (!hasTopicSupport) continue;
        const { score, weights } = this.computeWeights(point.score, row.memory, nlq.intent);
        contactResults.push(
          this.toSearchResult(row, score, weights, userId, resolvedKey, {
            matchedContactIds: [
              ...(contactIdsByMemory.get(point.id) ?? new Set(explicitContactIds)),
            ],
            matchedContactRoles: [...(contactRolesByMemory.get(point.id) ?? new Set())],
            topicCoverage: queryCoverage,
            matchMode: 'hard_filter',
          }),
        );
        if (contactResults.length >= effectiveLimit) break;
      }
      const sorted = contactResults.sort((a, b) => b.score - a.score);
      void this.pluginRegistry.fireHook('afterSearch', {
        query,
        resultCount: sorted.length,
        topScore: sorted[0]?.score,
      });
      return {
        items: sorted.filter((item) => {
          if (item.text.startsWith('[Encrypted')) {
            diagnostics?.skippedUndecryptableResultIds.push(item.id);
            return false;
          }
          return this.matchesFromMeFilter(item.metadata, effectiveFilters.fromMe);
        }),
        fallback: false,
        resolvedEntities: { contacts: resolvedContacts, topicWords, topicMatchCount },
        parsed: {
          temporal: nlq.temporal,
          entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
          intent: nlq.intent,
          cleanQuery: nlq.cleanQuery,
          sourceType: nlq.sourceTypeHint ?? undefined,
        },
        diagnostics,
      };
    }

    // --- Collect candidate IDs from Postgres search results ---
    const allCandidateIds = new Set<string>();
    for (const point of searchIndexResults) allCandidateIds.add(point.id);
    for (const point of lexicalResults) allCandidateIds.add(point.id);
    for (const [id] of candidateLanes) allCandidateIds.add(id);

    // For pure contact queries, inject top contact-linked memories that Postgres search may have missed
    if (isPureContactQuery && allContactMemoryIds.size > 0) {
      // Prioritize memories linked to ALL resolved contacts
      const multiContactMemories: string[] = [];
      const singleContactMemories: string[] = [];
      for (const memId of allContactMemoryIds) {
        if (!allCandidateIds.has(memId)) {
          const count = contactMatchCount.get(memId) || 0;
          if (count >= contactIds.length) multiContactMemories.push(memId);
          else singleContactMemories.push(memId);
        }
      }
      // Add multi-contact matches first, then single-contact, up to limit
      const inject = [...multiContactMemories, ...singleContactMemories].slice(0, effectiveLimit);
      for (const id of inject) {
        allCandidateIds.add(id);
        // Give injected contact memories a baseline semantic score
        if (!semanticScores.has(id)) semanticScores.set(id, INJECTED_CONTACT_BASELINE);
      }
    }

    if (!allCandidateIds.size) {
      if (
        hasContacts &&
        topicWords.length > 0 &&
        topicMatchCount === 0 &&
        !options?.noEntityResolution
      ) {
        const fallbackResult = await this.search(
          query,
          filters,
          limit,
          userId,
          memoryBankId,
          memoryBankIds,
          diversityFactor,
          { ...options, noEntityResolution: true },
        );
        if (fallbackResult.items.length > 0) {
          return {
            ...fallbackResult,
            fallback: true,
            resolvedEntities: {
              contacts: resolvedContacts,
              topicWords,
              topicMatchCount,
            },
            diagnostics: fallbackResult.diagnostics
              ? {
                  ...fallbackResult.diagnostics,
                  resolvedEntities: {
                    contacts: resolvedContacts,
                    mode: 'fallback',
                    topicWords,
                  },
                  entityResolutionFallback: 'reran_without_entities',
                }
              : undefined,
          };
        }
      }
      return {
        items: [],
        fallback: false,
        resolvedEntities: hasContacts
          ? { contacts: resolvedContacts, topicWords, topicMatchCount }
          : undefined,
        parsed: {
          temporal: nlq.temporal,
          entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
          intent: nlq.intent,
          cleanQuery: nlq.cleanQuery,
          sourceType: nlq.sourceTypeHint ?? undefined,
        },
        diagnostics,
      };
    }

    // Batch fetch all candidate rows from DB
    const candidateRows: Array<{
      id: string;
      row: { memory: typeof memories.$inferSelect; accountIdentifier: string | null };
    }> = [];
    const batchRows = await this.fetchMemoryRowsBatch([...allCandidateIds]);
    for (const [id, row] of batchRows) {
      const mem = row.memory;
      if (effectiveFilters.sourceType && mem.sourceType !== effectiveFilters.sourceType) continue;
      if (effectiveFilters.connectorType && mem.connectorType !== effectiveFilters.connectorType)
        continue;
      if (effectiveFilters.from && mem.eventTime < new Date(effectiveFilters.from)) continue;
      if (effectiveFilters.to && mem.eventTime > new Date(effectiveFilters.to)) continue;
      candidateRows.push({ id, row });
    }

    // Score all candidates with contact and topical coverage boosts.
    // The coverage term set is derived only from the user's query and resolved
    // topic words, so generic org/brand/person terms do not need hard-coded
    // special cases to rank well when entity resolution falls back.
    const coverageTerms = searchCoverageTerms(embeddingQuery, hasContacts ? topicWords : undefined);
    const coverageById = new Map<string, number>();
    const intentScoreById = new Map<
      string,
      {
        distinctiveCoverage: number;
        sourceBoost: number;
        recencyBoost: number;
        negativePrior: number;
      }
    >();
    const scoredCandidates: Array<{
      id: string;
      row: (typeof candidateRows)[0]['row'];
      score: number;
      weights: SearchResult['weights'];
      queryCoverage: number;
      matchedContactIds?: string[];
      matchedContactRoles?: string[];
      matchMode?: 'hard_filter' | 'hint';
    }> = [];
    let contactTopicSupportedCount = 0;
    for (const { id, row } of candidateRows) {
      const semanticScore = semanticScores.get(id) ?? 0;
      // Multi-contact boost: memories linked to ALL resolved contacts get strongest boost
      // For mixed queries (contacts + keywords), use a softer boost so keyword-matching
      // memories (e.g. messages mentioning "sick") aren't drowned out by photos that
      // only match the contact names.
      const memContactCount = contactMatchCount.get(id) || 0;
      const softBoost = !isPureContactQuery && contactIds.length > 0;
      const contactMultiplier =
        memContactCount >= contactIds.length
          ? softBoost
            ? CONTACT_BOOST_MIXED
            : 1.6 // soft boost for mixed queries, full boost for pure contact queries
          : memContactCount > 0
            ? softBoost
              ? 1.1
              : CONTACT_BOOST_PURE_MULTI
            : isPureContactQuery
              ? 0.5 // pure contact query but memory isn't linked to any — demote
              : 1.0;

      const { score, weights } = this.computeWeights(semanticScore, row.memory, nlq.intent);
      const locationMultiplier =
        plannedIntent === 'location' && ['location', 'photo'].includes(row.memory.sourceType)
          ? 1.22
          : 1.0;
      const recencyMultiplier = plannedIntent === 'recent_activity' ? 1.08 : 1.0;
      const memoryForCoverage = this.decryptMemoryAuto(row.memory, userId, resolvedKey);
      const queryCoverage = queryTokenCoverage(memoryForCoverage.text, coverageTerms);
      coverageById.set(id, queryCoverage);
      const hasTopicSupport = topicWords.length === 0 || queryCoverage > 0 || exactLaneIds.has(id);
      if (hasContacts && memContactCount > 0 && topicWords.length > 0 && !hasTopicSupport) {
        continue;
      }
      if (hasContacts && memContactCount > 0 && topicWords.length > 0 && hasTopicSupport) {
        contactTopicSupportedCount += 1;
      }
      const intentScore = scoreQueryIntent({
        query,
        coverageTerms,
        text: memoryForCoverage.text,
        metadata: memoryForCoverage.metadata,
        eventTime: row.memory.eventTime,
        weights,
      });
      intentScoreById.set(id, intentScore);
      const coverageMultiplier =
        coverageTerms.length >= 2
          ? 0.75 + queryCoverage * 0.5
          : coverageTerms.length === 1
            ? 0.85 + queryCoverage * 0.3
            : 1.0;
      const boostedScore = Math.min(
        score *
          contactMultiplier *
          locationMultiplier *
          recencyMultiplier *
          coverageMultiplier *
          intentScore.sourceBoost *
          intentScore.recencyBoost *
          intentScore.negativePrior,
        1.0,
      );
      const boostedWeights = { ...weights, final: boostedScore };

      scoredCandidates.push({
        id,
        row,
        score: boostedScore,
        weights: boostedWeights,
        queryCoverage,
        matchedContactIds:
          memContactCount > 0 ? [...(contactIdsByMemory.get(id) ?? new Set<string>())] : undefined,
        matchedContactRoles:
          memContactCount > 0
            ? [...(contactRolesByMemory.get(id) ?? new Set<string>())]
            : undefined,
        matchMode: memContactCount > 0 ? (hardContactFilter ? 'hard_filter' : 'hint') : undefined,
      });
    }
    if (hasContacts && topicWords.length > 0) {
      topicMatchCount = contactTopicSupportedCount;
    }

    const scoreFiltered = scoredCandidates.filter(
      (c) => c.score >= MIN_SCORE || exactLaneIds.has(c.id),
    );
    const topCandidates = this.diversifyResults(scoreFiltered, effectiveLimit, diversityFactor);
    const returnItems = topCandidates
      .map((c) =>
        this.toSearchResult(c.row, c.score, c.weights, userId, resolvedKey, {
          matchedContactIds: c.matchedContactIds,
          matchedContactRoles: c.matchedContactRoles,
          topicCoverage: c.queryCoverage,
          matchMode: c.matchMode,
        }),
      )
      .filter((item) => {
        if (item.text.startsWith('[Encrypted')) {
          diagnostics?.skippedUndecryptableResultIds.push(item.id);
          return false;
        }
        return this.matchesFromMeFilter(item.metadata, effectiveFilters.fromMe);
      });
    if (diagnostics) {
      for (const [, lanes] of candidateLanes) {
        for (const lane of lanes) {
          diagnostics.candidateLanes[lane] = (diagnostics.candidateLanes[lane] ?? 0) + 1;
        }
      }
      diagnostics.topScoreComponents = topCandidates.slice(0, 10).map((c) => ({
        id: c.id,
        score: c.score,
        semantic: semanticScores.get(c.id) ?? 0,
        queryCoverage: coverageById.get(c.id),
        distinctiveCoverage: intentScoreById.get(c.id)?.distinctiveCoverage,
        sourceBoost: intentScoreById.get(c.id)?.sourceBoost,
        recencyBoost: intentScoreById.get(c.id)?.recencyBoost,
        negativePrior: intentScoreById.get(c.id)?.negativePrior,
        lanes: [...(candidateLanes.get(c.id) ?? new Set())],
      }));
    }

    if (
      hasContacts &&
      topicWords.length > 0 &&
      topicMatchCount === 0 &&
      !options?.noEntityResolution
    ) {
      const fallbackResult = await this.search(
        query,
        filters,
        limit,
        userId,
        memoryBankId,
        memoryBankIds,
        diversityFactor,
        { ...options, noEntityResolution: true },
      );
      if (fallbackResult.items.length > 0) {
        return {
          ...fallbackResult,
          fallback: true,
          resolvedEntities: {
            contacts: resolvedContacts,
            topicWords,
            topicMatchCount,
          },
          diagnostics: fallbackResult.diagnostics
            ? {
                ...fallbackResult.diagnostics,
                resolvedEntities: {
                  contacts: resolvedContacts,
                  mode: 'fallback',
                  topicWords,
                },
                entityResolutionFallback: 'reran_without_entities',
              }
            : undefined,
        };
      }
    }

    // Fire afterSearch hook (fire-and-forget)
    void this.pluginRegistry.fireHook('afterSearch', {
      query,
      resultCount: returnItems.length,
      topScore: returnItems[0]?.score,
    });

    // Map Postgres search facet_counts to our structure
    const facetCounts: FacetCounts = {
      connectorType: [],
      sourceType: [],
      factualityLabel: [],
      people: [],
    };
    for (const fc of hybridResult.facetCounts) {
      if (fc.field_name === 'connector_type') facetCounts.connectorType = fc.counts;
      else if (fc.field_name === 'source_type') facetCounts.sourceType = fc.counts;
      else if (fc.field_name === 'factuality_label') facetCounts.factualityLabel = fc.counts;
      else if (fc.field_name === 'people') facetCounts.people = fc.counts;
    }

    return {
      items: returnItems,
      fallback: false,
      resolvedEntities: hasContacts
        ? { contacts: resolvedContacts, topicWords, topicMatchCount }
        : undefined,
      parsed: {
        temporal: nlq.temporal,
        entities: resolvedContacts.map((c) => ({ id: c.id, displayName: c.displayName })),
        intent: nlq.intent,
        cleanQuery: nlq.cleanQuery,
        sourceType: nlq.sourceTypeHint ?? undefined,
      },
      facetCounts,
      found: hybridResult.found,
      diagnostics,
    };
  }

  @Traced('memory.ask')
  async ask(
    query: string,
    conversationId?: string,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
    filters?: SearchFilters,
  ): Promise<{
    answer: string;
    conversationId: string;
    citations: SearchResult[];
  }> {
    const searchResponse = await this.search(
      query,
      filters,
      20,
      userId,
      memoryBankId,
      memoryBankIds,
    );
    const citations = searchResponse.items;

    // Enrich with people
    if (citations.length) {
      const peopleMap = await this.getPeopleForMemories(citations.map((c) => c.id));
      for (const item of citations) {
        item.people = peopleMap.get(item.id) || [];
      }
    }

    let answer = 'No relevant memories found for this question.';
    if (citations.length) {
      const citationLines = citations
        .slice(0, 12)
        .map((item, index) => {
          const roles = item.matchedContactRoles?.length
            ? ` matchedRoles=${item.matchedContactRoles.join(',')}`
            : '';
          const mode = item.matchMode ? ` matchMode=${item.matchMode}` : '';
          const coverage =
            item.topicCoverage !== undefined ? ` topicCoverage=${item.topicCoverage}` : '';
          const source = item.textSource ? ` textSource=${item.textSource}` : '';
          return `[${index + 1}] id=${item.id} time=${item.eventTime.toISOString()}${mode}${roles}${coverage}${source}\n${item.text}`;
        })
        .join('\n\n');
      try {
        answer = await this.ai.generate(
          [
            'Answer using only the cited Botmem memories.',
            'Do not attribute a topic to a person unless the same citation has a hard_filter match, or it has matched person roles plus non-zero topicCoverage.',
            'If the citations are only fallback or weak related matches, say that no exact person-specific match was found and summarize the weaker evidence.',
            'Never merge facts across different people or senders unless a citation explicitly connects them.',
            '',
            `Question: ${query}`,
            '',
            'Citations:',
            citationLines,
          ].join('\n'),
        );
      } catch (err) {
        this.logger.warn(`Ask generation failed, returning citations only: ${err}`);
        answer =
          'I found matching memories, but answer generation is unavailable. Use the returned citations.';
      }
    }

    return {
      answer,
      conversationId: conversationId || randomUUID(),
      citations,
    };
  }

  private async fetchMemoryRow(id: string) {
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(and(eq(memories.id, id), eq(memories.pipelineComplete, true))),
    );
    return rows.length ? rows[0] : null;
  }

  private async fetchMemoryRowsBatch(
    ids: string[],
  ): Promise<
    Map<string, { memory: typeof memories.$inferSelect; accountIdentifier: string | null }>
  > {
    const result = new Map<
      string,
      { memory: typeof memories.$inferSelect; accountIdentifier: string | null }
    >();
    if (!ids.length) return result;
    // Batch in chunks to avoid overly large IN clauses
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memory: memories, accountIdentifier: accounts.identifier })
          .from(memories)
          .leftJoin(accounts, eq(memories.accountId, accounts.id))
          .where(and(inArray(memories.id, batch), eq(memories.pipelineComplete, true))),
      );
      for (const row of rows) {
        result.set(row.memory.id, row);
      }
    }
    return result;
  }

  private toSearchResult(
    row: { memory: typeof memories.$inferSelect; accountIdentifier: string | null },
    score: number,
    weights: SearchResult['weights'],
    userId?: string | null,
    resolvedKey?: Buffer | null,
    extras: Partial<
      Pick<
        SearchResult,
        'matchedContactIds' | 'matchedContactRoles' | 'topicCoverage' | 'matchMode'
      >
    > = {},
  ): SearchResult {
    const mem = this.decryptMemoryAuto(row.memory, userId, resolvedKey);
    // Decrypt factuality (encrypted JSON string) for output
    let factuality: unknown = mem.factuality;
    if (typeof factuality === 'string') {
      try {
        const decrypted = this.crypto.decrypt(factuality);
        factuality = decrypted ? JSON.parse(decrypted) : factuality;
      } catch {
        try {
          factuality = JSON.parse(factuality as string);
        } catch {
          /* keep as-is */
        }
      }
    }
    // Decrypt accountIdentifier
    const accountIdentifier = this.safeDecryptAppField(row.accountIdentifier);
    const metadata = this.sanitizeMetadataForResponse(mem.metadata);
    return {
      id: mem.id,
      text: mem.text,
      sourceType: mem.sourceType,
      connectorType: mem.connectorType,
      eventTime: mem.eventTime,
      ingestTime: mem.ingestTime,
      createdAt: mem.createdAt,
      factuality,
      entities: mem.entities,
      metadata,
      accountIdentifier,
      pinned: mem.pinned,
      score,
      weights,
      textSource: this.inferTextSource(metadata),
      ...extras,
    };
  }

  async getById(id: string, userId?: string | null) {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select().from(memories).where(eq(memories.id, id)),
    );
    if (!rows.length) return null;
    const resolvedKey = await this.resolveUserKey(userId);
    const mem = this.decryptMemoryAuto(rows[0], userId, resolvedKey);
    if (this.isLockedMemory(mem)) return null;
    const peopleMap = await this.getPeopleForMemories([id]);
    return {
      ...mem,
      metadata: this.sanitizeMetadataForResponse(mem.metadata),
      factuality: this.factualityForResponse(mem.factuality),
      people: peopleMap.get(id) || [],
    };
  }

  async getRawById(id: string, userId?: string | null, memoryBankIds?: string[]) {
    const memory = await this.getById(id, userId);
    if (!memory) return null;
    if (memoryBankIds?.length && !memoryBankIds.includes(memory.memoryBankId ?? '')) return null;

    const rawRows = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(rawEvents)
        .where(
          and(
            eq(rawEvents.accountId, memory.accountId!),
            eq(rawEvents.connectorType, memory.connectorType),
            eq(rawEvents.sourceId, memory.sourceId),
          ),
        )
        .limit(1),
    );
    const rawEvent = rawRows[0] ?? null;
    const payload = rawEvent
      ? this.parseMaybeJson(this.crypto.decrypt(rawEvent.payload) || rawEvent.payload)
      : null;

    const memoryMetadata = this.sanitizeMemoryMetadataForResponse(
      this.parseMaybeJson(memory.metadata),
    );

    return {
      memory: {
        id: memory.id,
        accountId: memory.accountId,
        connectorType: memory.connectorType,
        sourceType: memory.sourceType,
        sourceId: memory.sourceId,
        eventTime: memory.eventTime,
        ingestTime: memory.ingestTime,
        metadata: memoryMetadata,
      },
      rawEvent: rawEvent
        ? {
            id: rawEvent.id,
            accountId: rawEvent.accountId,
            connectorType: rawEvent.connectorType,
            sourceType: rawEvent.sourceType,
            sourceId: rawEvent.sourceId,
            sourceHash: rawEvent.sourceHash,
            processingState: rawEvent.processingState,
            timestamp: rawEvent.timestamp,
            jobId: rawEvent.jobId,
            createdAt: rawEvent.createdAt,
            payload,
          }
        : null,
      connectorRaw:
        memory.connectorType === 'photos'
          ? await this.getPhotosRawMetadata(memory.accountId, memory.sourceId)
          : null,
      asset:
        memory.connectorType === 'photos'
          ? {
              originalUrl: `/api/memories/${encodeURIComponent(memory.id)}/raw/file?variant=original`,
              thumbnailUrl: `/api/memories/${encodeURIComponent(memory.id)}/raw/file?variant=thumbnail`,
            }
          : null,
    };
  }

  async getRawAssetById(
    id: string,
    userId?: string | null,
    memoryBankIds?: string[],
    variant: 'original' | 'thumbnail' = 'original',
  ): Promise<RawMemoryAsset | null> {
    const memory = await this.getById(id, userId);
    if (!memory) return null;
    if (memoryBankIds?.length && !memoryBankIds.includes(memory.memoryBankId ?? '')) return null;
    if (memory.connectorType !== 'photos') {
      throw new Error(`Raw asset streaming is not implemented for ${memory.connectorType}`);
    }

    const auth = await this.getAccountAuth(memory.accountId);
    const connector = this.connectors.get(memory.connectorType);
    const asset = await connector.getRawAsset(memory.sourceId, auth, variant);
    if (!asset)
      throw new Error(`Raw asset streaming is not implemented for ${memory.connectorType}`);

    return {
      contentType: asset.contentType,
      fileName: asset.fileName,
      contentLength: asset.contentLength,
      buffer: asset.buffer,
    };
  }

  private async getPhotosRawMetadata(accountId: string | null, sourceId: string) {
    if (!accountId) return null;
    const auth = await this.getAccountAuth(accountId);
    const connector = this.connectors.get('photos');
    const raw = await connector.getRaw(sourceId, auth);
    return this.sanitizeMemoryMetadataForResponse(raw);
  }

  private async getAccountAuth(accountId: string | null) {
    if (!accountId) throw new Error('Memory is not linked to a connector account');
    const [account] = await this.dbService.withCurrentUser((db) =>
      db
        .select({ authContext: accounts.authContext })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
    );
    const authContext = this.parseMaybeJson(this.crypto.decrypt(account?.authContext) || null);
    if (!authContext || typeof authContext !== 'object') {
      throw new Error('Connector credentials are unavailable');
    }
    return authContext as {
      accessToken?: string;
      refreshToken?: string;
      raw?: Record<string, unknown>;
    };
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  public sanitizeMemoryMetadataForResponse(value: unknown): unknown {
    return this.stripLargeInlineData(value);
  }

  private sanitizeMetadataForResponse(value: unknown): unknown {
    if (typeof value === 'string' && this.crypto.isEncrypted(value)) return {};
    return this.sanitizeMemoryMetadataForResponse(this.parseMaybeJson(value)) ?? {};
  }

  private sanitizeMetadataJsonForResponse(value: unknown): string {
    return JSON.stringify(this.sanitizeMetadataForResponse(value));
  }

  private stripLargeInlineData(value: unknown, parentKey?: string): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.stripLargeInlineData(item, parentKey));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'thumbnailBase64') {
        out.hasThumbnailBase64 = typeof child === 'string' && child.length > 0;
      } else if (key === 'fileBase64') {
        out.hasFileBase64 = typeof child === 'string' && child.length > 0;
      } else if (key === 'searchTokens' || key === 'search_tokens') {
        continue;
      } else if (
        parentKey === 'attachments' &&
        key === 'uri' &&
        typeof child === 'string' &&
        child.length > 0
      ) {
        out.hasUri = true;
      } else if (typeof child === 'string' && this.isLargeInlineMetadataString(key, child)) {
        out[`${key}Stripped`] = true;
      } else {
        out[key] = this.stripLargeInlineData(child, key);
      }
    }
    return out;
  }

  private isLargeInlineMetadataString(key: string, value: string): boolean {
    if (value.startsWith('data:')) return true;
    if (/base64/i.test(key) && value.length > 256) return true;
    return value.length > 4096;
  }

  async list(
    params: {
      limit?: number;
      offset?: number;
      connectorType?: string;
      sourceType?: string;
      sortBy?: 'eventTime' | 'ingestTime';
      userId?: string;
      memoryBankId?: string;
      memoryBankIds?: string[];
      fromMe?: boolean;
    } = {},
  ) {
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    if (params.userId && params.sortBy !== 'ingestTime' && params.fromMe === undefined) {
      const conditions: SQLWrapper[] = [eq(memorySearchIndex.userId, params.userId)];
      if (params.connectorType) {
        conditions.push(eq(memorySearchIndex.connectorType, params.connectorType));
      }
      if (params.sourceType) {
        conditions.push(eq(memorySearchIndex.sourceType, params.sourceType));
      }
      if (params.memoryBankId) {
        conditions.push(eq(memorySearchIndex.memoryBankId, params.memoryBankId));
      } else if (params.memoryBankIds?.length) {
        conditions.push(inArray(memorySearchIndex.memoryBankId, params.memoryBankIds));
      }
      const where = and(...conditions);

      const [totalRows, rows] = await Promise.all([
        this.dbService.withCurrentUser((db) =>
          db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(memorySearchIndex)
            .where(where),
        ),
        this.dbService.withCurrentUser((db) =>
          db
            .select({
              id: memorySearchIndex.memoryId,
              accountId: memorySearchIndex.accountId,
              accountIdentifier: accounts.identifier,
              connectorType: memorySearchIndex.connectorType,
              sourceType: memorySearchIndex.sourceType,
              text: memorySearchIndex.text,
              eventTime: memorySearchIndex.eventTime,
              factualityLabel: memorySearchIndex.factualityLabel,
              pinned: memorySearchIndex.pinned,
              importance: memorySearchIndex.importance,
              recallCount: memorySearchIndex.recallCount,
            })
            .from(memorySearchIndex)
            .leftJoin(accounts, eq(memorySearchIndex.accountId, accounts.id))
            .where(where)
            .orderBy(desc(memorySearchIndex.eventTime))
            .limit(limit)
            .offset(offset),
        ),
      ]);

      const peopleMap = await this.getPeopleForMemories(rows.map((r) => r.id));
      return {
        items: rows.map((r) => ({
          id: r.id,
          accountId: r.accountId,
          accountIdentifier: this.safeDecryptAppField(r.accountIdentifier),
          connectorType: r.connectorType,
          sourceType: r.sourceType,
          text: r.text,
          eventTime: r.eventTime,
          factuality: {
            label: r.factualityLabel ?? 'UNVERIFIED',
            confidence: 0.5,
            rationale: '',
          },
          weights: {
            semantic: 0,
            recency: 0,
            importance: r.importance ?? 0.5,
            trust: 0.5,
            final: r.importance ?? 0.5,
          },
          entities: [],
          claims: [],
          metadata: {},
          pinned: r.pinned,
          recallCount: r.recallCount,
          people: peopleMap.get(r.id) || [],
        })),
        total: totalRows[0]?.count || 0,
      };
    }

    const sortCol = params.sortBy === 'ingestTime' ? memories.ingestTime : memories.eventTime;

    // User isolation
    const userAccountIds = await this.getUserAccountIds(params.userId);

    const conditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }
    if (params.memoryBankId) {
      conditions.push(eq(memories.memoryBankId, params.memoryBankId));
    } else if (params.memoryBankIds?.length) {
      conditions.push(inArray(memories.memoryBankId, params.memoryBankIds));
    }

    const where = conditions.length > 0 ? and(...conditions)! : undefined;

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(where),
    );
    const total = totalRows[0]?.count || 0;

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(where)
        .orderBy(sql`${sortCol} DESC`)
        .limit(limit)
        .offset(offset),
    );
    const listKey = await this.resolveUserKey(params.userId);
    const memoryIds = rows.map((r) => r.memory.id);
    const peopleMap = await this.getPeopleForMemories(memoryIds);
    const items = rows
      .map((r) => {
        const mem = this.decryptMemoryAuto(r.memory, params.userId, listKey);
        return {
          ...mem,
          metadata: this.sanitizeMetadataForResponse(mem.metadata),
          factuality: this.factualityForResponse(mem.factuality),
          accountIdentifier: this.safeDecryptAppField(r.accountIdentifier),
          people: peopleMap.get(r.memory.id) || [],
        };
      })
      .filter((item) => !this.isLockedMemory(item))
      .filter((item) => this.matchesFromMeFilter(item.metadata, params.fromMe));

    return { items, total };
  }

  async insert(data: {
    text: string;
    sourceType: string;
    connectorType: string;
    accountId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const now = new Date();

    await this.dbService.withCurrentUser((db) =>
      db.insert(memories).values({
        id,
        accountId: data.accountId || null,
        connectorType: data.connectorType,
        sourceType: data.sourceType,
        sourceId: `manual-${id}`,
        text: data.text,
        eventTime: now,
        ingestTime: now,
        metadata: JSON.stringify(data.metadata || {}),
        embeddingStatus: 'pending',
        createdAt: now,
      }),
    );

    return {
      id,
      text: data.text,
      sourceType: data.sourceType,
      connectorType: data.connectorType,
      eventTime: now,
      createdAt: now,
    };
  }

  async delete(id: string) {
    await this.dbService.withCurrentUser(async (db) => {
      await db.transaction(async (tx) => {
        await tx.delete(memoryPeople).where(eq(memoryPeople.memoryId, id));
        await tx
          .delete(memoryLinks)
          .where(or(eq(memoryLinks.srcMemoryId, id), eq(memoryLinks.dstMemoryId, id)));
        await tx.delete(memories).where(eq(memories.id, id));
      });
    });
    try {
      await this.searchIndex.remove(id);
    } catch {
      // Qdrant removal is best-effort
    }
  }

  async getStats(userId?: string, memoryBankIds?: string[]) {
    const conditions: SQLWrapper[] = [];
    if (userId) conditions.push(eq(memorySearchIndex.userId, userId));
    if (memoryBankIds?.length) {
      conditions.push(inArray(memorySearchIndex.memoryBankId, memoryBankIds));
    }
    const statsFilter = conditions.length ? and(...conditions) : undefined;

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memorySearchIndex)
        .where(statsFilter),
    );
    const total = Number(totalRows[0]?.count) || 0;

    const sourceRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ key: memorySearchIndex.sourceType, count: sql<number>`COUNT(*)` })
        .from(memorySearchIndex)
        .where(statsFilter)
        .groupBy(memorySearchIndex.sourceType),
    );
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.key] = Number(r.count) || 0;

    const connectorRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ key: memorySearchIndex.connectorType, count: sql<number>`COUNT(*)` })
        .from(memorySearchIndex)
        .where(statsFilter)
        .groupBy(memorySearchIndex.connectorType),
    );
    const byConnector: Record<string, number> = {};
    for (const r of connectorRows) byConnector[r.key] = Number(r.count) || 0;

    const factRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          label: sql<string>`${memorySearchIndex.factualityLabel}`,
          count: sql<number>`COUNT(*)`,
        })
        .from(memorySearchIndex)
        .where(statsFilter)
        .groupBy(memorySearchIndex.factualityLabel),
    );
    const byFactuality: Record<string, number> = {};
    for (const r of factRows) {
      if (r.label) byFactuality[r.label] = Number(r.count) || 0;
    }

    return { total, bySource, byConnector, byFactuality };
  }

  async getGraphData(
    limit = 500,
    linkLimit = 2000,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
    filterMemoryIds?: string[],
  ) {
    const effectiveLimit = filterMemoryIds?.length ? Math.min(limit, 250) : Math.min(limit, 80);
    const effectiveLinkLimit = filterMemoryIds?.length
      ? Math.min(linkLimit, 1000)
      : Math.min(linkLimit, 240);
    const userAccountIds = await this.getUserAccountIds(userId);

    // Build memory bank + user isolation filter conditions
    const memoryBankConditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { nodes: [], links: [] };
      memoryBankConditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (memoryBankId) {
      memoryBankConditions.push(eq(memories.memoryBankId, memoryBankId));
    } else if (memoryBankIds?.length) {
      memoryBankConditions.push(inArray(memories.memoryBankId, memoryBankIds));
    }
    const memoryBankFilter = and(...memoryBankConditions)!;

    // Fetch memories — either specific IDs (search) or recent (preview)
    const recentMemories = filterMemoryIds?.length
      ? await (async () => {
          const rows: Array<typeof memories.$inferSelect> = [];
          for (let i = 0; i < filterMemoryIds.length; i += 500) {
            const batch = filterMemoryIds.slice(i, i + 500);
            const r = await this.dbService.withCurrentUser((db) =>
              db
                .select()
                .from(memories)
                .where(and(memoryBankFilter, inArray(memories.id, batch))),
            );
            rows.push(...r);
          }
          return rows;
        })()
      : await this.dbService.withCurrentUser((db) =>
          db
            .select()
            .from(memories)
            .where(memoryBankFilter)
            .orderBy(desc(memories.eventTime))
            .limit(effectiveLimit),
        );

    const memoryIds = new Set(recentMemories.map((m) => m.id));

    // Fetch links only for user's memories (batched)
    const memoryIdList = [...memoryIds];
    const allLinks: Array<typeof memoryLinks.$inferSelect> = [];
    for (let i = 0; i < memoryIdList.length; i += 500) {
      if (allLinks.length >= effectiveLinkLimit) break;
      const batch = memoryIdList.slice(i, i + 500);
      const srcLinks = await this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(memoryLinks)
          .where(inArray(memoryLinks.srcMemoryId, batch))
          .limit(effectiveLinkLimit - allLinks.length),
      );
      allLinks.push(...srcLinks);
    }

    // Add linked memories not already in the set (only if user-owned and done)
    const linkedIdSet = new Set<string>();
    for (const link of allLinks) {
      if (!memoryIds.has(link.dstMemoryId)) linkedIdSet.add(link.dstMemoryId);
    }
    const missingLinkedIds = filterMemoryIds?.length ? [...linkedIdSet] : [];
    const linkedMemories: Array<(typeof recentMemories)[0]> = [];
    for (let i = 0; i < missingLinkedIds.length; i += 100) {
      const batch = missingLinkedIds.slice(i, i + 100);
      if (!batch.length) break;
      // Apply user isolation to linked memories too
      const linkedConditions: SQLWrapper[] = [
        inArray(memories.id, batch),
        eq(memories.pipelineComplete, true),
      ];
      if (userAccountIds !== null && userAccountIds.length > 0) {
        linkedConditions.push(inArray(memories.accountId, userAccountIds));
      }
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(memories)
          .where(and(...linkedConditions)),
      );
      linkedMemories.push(...rows);
    }

    const allMemories = [...recentMemories, ...linkedMemories];
    for (const m of linkedMemories) memoryIds.add(m.id);

    const relevantLinks = allLinks.filter(
      (l) => memoryIds.has(l.srcMemoryId) && memoryIds.has(l.dstMemoryId),
    );

    // Fetch contacts and identifiers — scope to user's memories only
    const memoryIdArray = [...memoryIds];
    const allMemoryContacts: Array<typeof memoryPeople.$inferSelect> = [];
    for (let i = 0; i < memoryIdArray.length; i += 500) {
      const batch = memoryIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(memoryPeople).where(inArray(memoryPeople.memoryId, batch)),
      );
      allMemoryContacts.push(...rows);
    }
    const relevantMemoryContacts = allMemoryContacts;

    const relevantContactIdSet = new Set(relevantMemoryContacts.map((mc) => mc.personId));

    // Always include self-contact in the graph
    const selfRow = await this.dbService.withCurrentUser((db) =>
      db
        .select({ value: settings.value })
        .from(settings)
        .where(
          inArray(
            settings.key,
            userId ? [`selfContactId:${userId}`, `selfPersonId:${userId}`] : ['selfContactId'],
          ),
        )
        .limit(1),
    );
    const selfContactId = selfRow[0]?.value;
    if (selfContactId) {
      relevantContactIdSet.add(selfContactId);
      // Add all self-contact memory links as edges (even if memory isn't in graph slice)
      const selfLinks = allMemoryContacts.filter(
        (mc) => mc.personId === selfContactId && memoryIds.has(mc.memoryId),
      );
      for (const sl of selfLinks) {
        if (
          !relevantMemoryContacts.some(
            (mc) => mc.memoryId === sl.memoryId && mc.personId === sl.personId,
          )
        ) {
          relevantMemoryContacts.push(sl);
        }
      }
    }

    const contactIdArray = [...relevantContactIdSet];
    const relevantContacts: Array<typeof people.$inferSelect> = [];
    for (let i = 0; i < contactIdArray.length; i += 500) {
      const batch = contactIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(people).where(inArray(people.id, batch)),
      );
      relevantContacts.push(...rows);
    }

    const relevantIdentifiers: Array<typeof personIdentifiers.$inferSelect> = [];
    for (let i = 0; i < contactIdArray.length; i += 500) {
      const batch = contactIdArray.slice(i, i + 500);
      const rows = await this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, batch)),
      );
      relevantIdentifiers.push(...rows);
    }

    // Build entity → cluster mapping
    const entityClusters = new Map<string, number>();
    let nextCluster = 0;

    const graphKey = await this.resolveUserKey(userId);
    const memoryNodes = allMemories.map((raw) => {
      const m = this.decryptMemoryAuto(raw, userId, graphKey);
      let entities: Array<{ type?: string; value?: string; name?: string }> = [];
      try {
        entities = JSON.parse(m.entities);
      } catch {
        /* empty */
      }

      let factLabel = 'UNVERIFIED';
      if (m.factuality) {
        try {
          const decrypted = this.crypto.decrypt(m.factuality as string);
          const parsed = decrypted ? JSON.parse(decrypted) : null;
          factLabel = parsed?.label || 'UNVERIFIED';
        } catch {
          try {
            const parsed = JSON.parse(m.factuality as string);
            factLabel = parsed?.label || 'UNVERIFIED';
          } catch {
            /* keep default */
          }
        }
      }

      const dominantEntity = entities.find(
        (e) => (e.type === 'person' || e.type === 'organization') && e.value,
      );
      let cluster = 0;
      if (dominantEntity) {
        const key = String(dominantEntity.value).toLowerCase();
        if (!entityClusters.has(key)) entityClusters.set(key, nextCluster++);
        cluster = entityClusters.get(key)!;
      }

      const trust = this.getTrustScore(m.connectorType);
      const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
      const entityNames = entities
        .map((e) => e.value || '')
        .filter(Boolean)
        .slice(0, 5);

      const weights: Record<string, number> = (m.weights as Record<string, number>) || {};

      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(m.metadata);
      } catch {
        /* empty */
      }
      const responseMetadata = this.sanitizeMemoryMetadataForResponse(metadata) as Record<
        string,
        unknown
      >;

      const evtStr = m.eventTime instanceof Date ? m.eventTime.toISOString() : m.eventTime;
      const label = this.buildMediaLabel(m.sourceType, metadata, entityNames, evtStr, m.text);

      return {
        id: m.id,
        label,
        text: m.text,
        type: m.sourceType,
        connectorType: m.connectorType,
        factuality: factLabel,
        importance,
        cluster,
        nodeType: 'memory' as const,
        entities: entityNames,
        weights,
        eventTime: m.eventTime,
        metadata: responseMetadata,
      };
    });

    // Build contact nodes
    const identifiersByContact = new Map<string, string[]>();
    for (const ident of relevantIdentifiers) {
      const list = identifiersByContact.get(ident.personId) || [];
      list.push(ident.connectorType || 'unknown');
      identifiersByContact.set(ident.personId, list);
    }

    const contactNodes = relevantContacts.map((c) => {
      const connectors = [...new Set(identifiersByContact.get(c.id) || [])];
      const displayName = this.crypto.decrypt(c.displayName) ?? c.displayName ?? 'Unknown';
      const nameKey = displayName.toLowerCase();
      let cluster = 0;
      if (entityClusters.has(nameKey)) cluster = entityClusters.get(nameKey)!;

      const entityType = c.entityType || 'person';
      const nodeType =
        entityType === 'group'
          ? ('group' as const)
          : entityType === 'device'
            ? ('device' as const)
            : ('contact' as const);

      const avatars = (c.avatars as Array<{ url: string; source: string }>) || [];
      const preferredIdx = c.preferredAvatarIndex ?? 0;
      const preferred = avatars[preferredIdx] ?? avatars[0];
      // Use data URI directly if available, fall back to proxy for legacy URL-based avatars
      const avatarUrl = preferred?.url
        ? preferred.url.startsWith('data:')
          ? preferred.url
          : `/api/people/${c.id}/avatar`
        : undefined;

      return {
        id: `contact-${c.id}`,
        label: displayName,
        type: nodeType,
        connectorType: connectors[0] || 'manual',
        factuality: 'FACT',
        importance: entityType === 'group' ? 0.9 : entityType === 'device' ? 0.6 : 0.8,
        cluster,
        nodeType,
        connectors,
        entityType,
        avatarUrl,
      };
    });

    // Edges — only include those where both endpoints are in our node set
    const edges = relevantLinks
      .filter((l) => memoryIds.has(l.srcMemoryId) && memoryIds.has(l.dstMemoryId))
      .map((l) => ({
        source: l.srcMemoryId,
        target: l.dstMemoryId,
        type: l.linkType,
        strength: l.strength,
      }));

    const contactEdges = relevantMemoryContacts.map((mc) => ({
      source: `contact-${mc.personId}`,
      target: mc.memoryId,
      type: mc.role || 'involves',
      strength: mc.role === 'group' ? GRAPH_GROUP_STRENGTH : GRAPH_DIRECT_STRENGTH,
    }));

    // Build file/attachment nodes from memories in the current graph slice.
    // Extract from already-decrypted allMemories to avoid json_extract on encrypted metadata.
    const fileCounts = new Map<
      string,
      { count: number; mimeType: string; connectorType: string }
    >();
    for (const raw of allMemories) {
      const m = this.decryptMemoryAuto(raw, userId, graphKey);
      const meta = (() => {
        try {
          return JSON.parse(m.metadata) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (!meta) continue;
      const atts = meta.attachments as Array<{ filename?: string; mimeType?: string }> | undefined;
      if (!atts) continue;
      for (const att of atts) {
        const name = att.filename;
        if (!name) continue;
        const existing = fileCounts.get(name);
        if (existing) {
          existing.count++;
        } else {
          fileCounts.set(name, {
            count: 1,
            mimeType: att.mimeType || 'unknown',
            connectorType: m.connectorType,
          });
        }
      }
    }

    // Take top 200 files by occurrence
    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 200);

    const fileNameSet = new Set(topFiles.map(([name]) => name));

    const fileNodes = topFiles.map(([name, info]) => ({
      id: `file-${name}`,
      label: name,
      text: '',
      type: 'file' as string,
      connectorType: info.connectorType,
      factuality: 'FACT',
      importance: Math.min(0.4 + info.count * 0.05, 1.0),
      cluster: 0,
      nodeType: 'file' as const,
      entities: [info.mimeType],
      weights: {} as Record<string, number>,
      eventTime: '',
    }));

    // Create edges only for memories in the current graph that have these files
    const fileEdges: typeof edges = [];
    for (const m of allMemories) {
      const meta = (() => {
        try {
          return JSON.parse(this.crypto.decrypt(m.metadata) ?? m.metadata) as Record<
            string,
            unknown
          >;
        } catch {
          return null;
        }
      })();
      if (!meta) continue;
      const attachments = meta.attachments as Array<{ filename?: string }> | undefined;
      if (!attachments?.length) continue;
      for (const att of attachments) {
        if (att.filename && fileNameSet.has(att.filename)) {
          fileEdges.push({
            source: m.id,
            target: `file-${att.filename}`,
            type: 'attachment',
            strength: 0.8,
          });
        }
      }
    }

    return {
      nodes: [...memoryNodes, ...contactNodes, ...fileNodes],
      links: [...edges, ...contactEdges, ...fileEdges],
    };
  }

  async getGraphNeighbors(
    nodeId: string,
    limit = 30,
    userId?: string,
    memoryBankId?: string,
    memoryBankIds?: string[],
  ) {
    const effectiveLimit = Math.max(1, Math.min(limit, 50));
    const userAccountIds = await this.getUserAccountIds(userId);
    if (userAccountIds !== null && userAccountIds.length === 0) return { nodes: [], links: [] };

    const memoryBankConditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null)
      memoryBankConditions.push(inArray(memories.accountId, userAccountIds));
    if (memoryBankId) {
      memoryBankConditions.push(eq(memories.memoryBankId, memoryBankId));
    } else if (memoryBankIds?.length) {
      memoryBankConditions.push(inArray(memories.memoryBankId, memoryBankIds));
    }

    let memoryIds: string[];

    if (nodeId.startsWith('contact-')) {
      const personId = nodeId.slice('contact-'.length);
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ id: memories.id })
          .from(memoryPeople)
          .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
          .where(and(eq(memoryPeople.personId, personId), ...memoryBankConditions))
          .orderBy(desc(memories.eventTime))
          .limit(effectiveLimit),
      );
      memoryIds = rows.map((row) => row.id);
    } else if (nodeId.startsWith('file-')) {
      return { nodes: [], links: [] };
    } else {
      const peopleRows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ personId: memoryPeople.personId })
          .from(memoryPeople)
          .where(eq(memoryPeople.memoryId, nodeId)),
      );
      const personIds = [...new Set(peopleRows.map((row) => row.personId))];

      const linkRows = await this.dbService.withCurrentUser((db) =>
        db
          .select({
            srcMemoryId: memoryLinks.srcMemoryId,
            dstMemoryId: memoryLinks.dstMemoryId,
          })
          .from(memoryLinks)
          .where(or(eq(memoryLinks.srcMemoryId, nodeId), eq(memoryLinks.dstMemoryId, nodeId)))
          .limit(effectiveLimit),
      );
      const linkedIds = linkRows.map((link) =>
        link.srcMemoryId === nodeId ? link.dstMemoryId : link.srcMemoryId,
      );

      let peopleMemoryIds: string[] = [];
      if (personIds.length) {
        const rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ id: memories.id })
            .from(memoryPeople)
            .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
            .where(and(inArray(memoryPeople.personId, personIds), ...memoryBankConditions))
            .orderBy(desc(memories.eventTime))
            .limit(effectiveLimit),
        );
        peopleMemoryIds = rows.map((row) => row.id);
      }

      memoryIds = [nodeId, ...peopleMemoryIds, ...linkedIds];
    }

    const uniqueMemoryIds = [...new Set(memoryIds)].slice(0, effectiveLimit);
    if (!uniqueMemoryIds.length) return { nodes: [], links: [] };
    return this.getGraphData(
      uniqueMemoryIds.length,
      Math.max(120, uniqueMemoryIds.length * 6),
      userId,
      memoryBankId,
      memoryBankIds,
      uniqueMemoryIds,
    );
  }

  /**
   * Build graph delta for a single memory — lightweight query for WS push.
   * Returns the memory node, its links, associated contact nodes, and contact edges.
   */
  async buildGraphDelta(memoryId: string) {
    const [rawMem] = await this.dbService.withCurrentUser((db) =>
      db.select().from(memories).where(eq(memories.id, memoryId)),
    );
    if (!rawMem || !rawMem.pipelineComplete) return null;
    // buildGraphDelta is a WS fire-and-forget with no userId context; use auto-detect
    const mem = this.decryptMemoryAuto(rawMem);

    let entities: Array<{ type?: string; value?: string; name?: string }> = [];
    try {
      entities = JSON.parse(mem.entities);
    } catch {
      /* empty */
    }
    let factLabel = 'UNVERIFIED';
    if (mem.factuality) {
      try {
        const parsed =
          typeof mem.factuality === 'string' ? JSON.parse(mem.factuality) : mem.factuality;
        factLabel = parsed?.label || 'UNVERIFIED';
      } catch {
        /* keep default */
      }
    }
    const weights: Record<string, number> = (mem.weights as Record<string, number>) || {};
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(mem.metadata);
    } catch {
      /* empty */
    }

    const trust = this.getTrustScore(mem.connectorType);
    const importance = Math.min(0.3 + entities.length * 0.1 + trust * 0.3, 1.0);
    const entityNames = entities
      .map((e) => e.value || '')
      .filter(Boolean)
      .slice(0, 5);

    const responseMetadata = this.sanitizeMemoryMetadataForResponse(metadata) as Record<
      string,
      unknown
    >;

    const eventTimeStr =
      mem.eventTime instanceof Date ? mem.eventTime.toISOString() : mem.eventTime;
    const label = this.buildMediaLabel(
      mem.sourceType,
      metadata,
      entityNames,
      eventTimeStr,
      mem.text,
    );

    const node = {
      id: mem.id,
      label,
      text: mem.sourceType === 'photo' ? '' : mem.text,
      type: mem.sourceType,
      connectorType: mem.connectorType,
      factuality: factLabel,
      importance,
      cluster: 0,
      nodeType: 'memory' as const,
      entities: entityNames,
      weights,
      eventTime: mem.eventTime,
      metadata: responseMetadata,
    };

    // Links from/to this memory
    const links = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(memoryLinks)
        .where(
          sql`${memoryLinks.srcMemoryId} = ${memoryId} OR ${memoryLinks.dstMemoryId} = ${memoryId}`,
        ),
    );
    const graphLinks = links.map((l) => ({
      source: l.srcMemoryId,
      target: l.dstMemoryId,
      type: l.linkType,
      strength: l.strength,
    }));

    // Contact associations
    const mcRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryPeople).where(eq(memoryPeople.memoryId, memoryId)),
    );
    const contactIds = mcRows.map((mc) => mc.personId);
    const contactNodes: Array<Record<string, unknown>> = [];
    const contactEdges = mcRows.map((mc) => ({
      source: `contact-${mc.personId}`,
      target: memoryId,
      type: mc.role || 'involves',
      strength: mc.role === 'group' ? GRAPH_GROUP_STRENGTH : GRAPH_DIRECT_STRENGTH,
    }));

    if (contactIds.length) {
      const contactRows = await this.dbService.withCurrentUser((db) =>
        db.select().from(people).where(inArray(people.id, contactIds)),
      );
      const identRows = await this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, contactIds)),
      );
      const identByContact = new Map<string, string[]>();
      for (const i of identRows) {
        const list = identByContact.get(i.personId) || [];
        list.push(i.connectorType || 'unknown');
        identByContact.set(i.personId, list);
      }
      for (const c of contactRows) {
        const connectors = [...new Set(identByContact.get(c.id) || [])];
        const entityType = c.entityType || 'person';
        const nodeType =
          entityType === 'group'
            ? ('group' as const)
            : entityType === 'device'
              ? ('device' as const)
              : ('contact' as const);
        contactNodes.push({
          id: `contact-${c.id}`,
          label: c.displayName || 'Unknown',
          type: nodeType,
          connectorType: connectors[0] || 'manual',
          factuality: 'FACT',
          importance: entityType === 'group' ? 0.9 : entityType === 'device' ? 0.6 : 0.8,
          cluster: 0,
          nodeType,
          connectors,
          entityType,
        });
      }
    }

    return {
      nodes: [node],
      links: graphLinks,
      contacts: contactNodes,
      contactEdges,
    };
  }

  private computeWeights(
    semanticScore: number,
    mem: {
      pinned: boolean | null;
      recallCount: number | null;
      eventTime: Date;
      entities: string;
      text: string;
      connectorType: string;
    },
    intent?: 'recall' | 'browse' | 'find',
  ): {
    score: number;
    weights: {
      semantic: number;
      recency: number;
      importance: number;
      trust: number;
      final: number;
    };
  } {
    const isPinned = !!mem.pinned;
    const recallCount = mem.recallCount || 0;

    const ageDays = (Date.now() - new Date(mem.eventTime).getTime()) / (1000 * 60 * 60 * 24);
    // Pinned memories are exempt from recency decay
    const recency = isPinned ? 1.0 : Math.exp(-RECENCY_DECAY_RATE * ageDays);

    let entityCount = 0;
    try {
      entityCount = JSON.parse(mem.entities).length;
    } catch {
      /* empty */
    }
    // Importance: base + entity boost + text length signal + recall boost
    let importance = 0.3;
    importance += Math.min(entityCount * 0.1, 0.3);
    const textLen = (mem.text || '').length;
    if (textLen > 500) importance += 0.15;
    else if (textLen > 200) importance += 0.1;
    else if (textLen > 50) importance += 0.05;
    importance += Math.min(recallCount * 0.02, 0.2);
    importance = Math.min(importance, 1.0);
    const trust = this.getTrustScore(mem.connectorType);

    // Per-connector weight scaling (photos=lower semantic, locations=higher recency)
    const connectorWeights = this.getWeights(mem.connectorType);
    const semScale = connectorWeights.semantic / 0.4;
    const recScale = connectorWeights.recency / 0.25;

    // The semantic score already includes Postgres search hybrid rank fusion.
    // Browse intent boosts recency weight significantly.
    let final: number;
    if (intent === 'browse') {
      const p = SCORING_PROFILES.browse;
      final =
        Math.min(SCORING_PROFILES.recall.semantic * semScale, SCORING_PROFILES.recall.semanticCap) *
          semanticScore +
        Math.min(p.recency * recScale, p.recencyCap) * recency +
        0.15 * importance +
        p.trust * trust;
    } else {
      const p = SCORING_PROFILES.recallHybrid;
      final =
        Math.min(p.semantic * semScale, p.semanticCap) * semanticScore +
        Math.min(p.recency * recScale, p.recencyCap) * recency +
        p.importance * importance +
        p.trust * trust;
    }

    // Scorer plugin bonus (clamped to +/-0.05, averaged across plugins)
    const scorers = this.pluginRegistry.getScorers();
    if (scorers.length > 0) {
      let pluginBonus = 0;
      for (const scorer of scorers) {
        try {
          pluginBonus += scorer.score(mem, {
            semantic: semanticScore,
            recency,
            importance,
            trust,
          });
        } catch {
          /* ignore */
        }
      }
      pluginBonus = Math.max(-0.05, Math.min(0.05, pluginBonus / scorers.length));
      final = Math.max(0, Math.min(1, final + pluginBonus));
    }

    // Pinned memories get a score floor of 0.75
    if (isPinned) final = Math.max(final, 0.75);

    return {
      score: final,
      weights: { semantic: semanticScore, recency, importance, trust, final },
    };
  }

  /** Phase 9: Temporal query — memories within a date range, optionally filtered */
  async timeline(params: {
    from?: string;
    to?: string;
    connectorType?: string;
    sourceType?: string;
    query?: string;
    limit?: number;
    userId?: string;
    memoryBankId?: string;
    memoryBankIds?: string[];
    fromMe?: boolean;
  }) {
    const limit = params.limit || 50;
    const userAccountIds = await this.getUserAccountIds(params.userId);
    const conditions: SQLWrapper[] = [eq(memories.pipelineComplete, true)];
    if (userAccountIds !== null) {
      if (userAccountIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(memories.accountId, userAccountIds));
    }
    if (params.memoryBankId) {
      conditions.push(eq(memories.memoryBankId, params.memoryBankId));
    } else if (params.memoryBankIds?.length) {
      conditions.push(inArray(memories.memoryBankId, params.memoryBankIds));
    }

    if (params.from) {
      conditions.push(sql`${memories.eventTime} >= ${params.from}`);
    }
    if (params.to) {
      conditions.push(sql`${memories.eventTime} <= ${params.to}`);
    }
    if (params.connectorType) {
      conditions.push(eq(memories.connectorType, params.connectorType));
    }
    if (params.sourceType) {
      conditions.push(eq(memories.sourceType, params.sourceType));
    }
    if (params.query) {
      const words = params.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 2);
      for (const word of words) {
        conditions.push(sql`LOWER(${memories.text}) LIKE ${'%' + escapeLike(word) + '%'}`);
      }
    }

    const totalRows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(memories)
        .where(and(...conditions)!),
    );
    const total = totalRows[0]?.count || 0;

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories, accountIdentifier: accounts.identifier })
        .from(memories)
        .leftJoin(accounts, eq(memories.accountId, accounts.id))
        .where(and(...conditions)!)
        .orderBy(sql`${memories.eventTime} ASC`)
        .limit(limit),
    );

    const timelineKey = await this.resolveUserKey(params.userId);
    const peopleMap = await this.getPeopleForMemories(rows.map((row) => row.memory.id));
    const items = rows
      .map((r) => {
        const mem = this.decryptMemoryAuto(r.memory, params.userId, timelineKey);
        return {
          ...mem,
          metadata: this.metadataForResponseWithLinkedPeople(mem, peopleMap.get(mem.id)),
          factuality: this.factualityForResponse(mem.factuality),
          accountIdentifier: this.safeDecryptAppField(r.accountIdentifier),
        };
      })
      .filter((item) => !this.isLockedMemory(item))
      .filter((item) => this.matchesFromMeFilter(item.metadata, params.fromMe));
    return { items, total };
  }

  async activity(params: {
    from?: string;
    to?: string;
    connectorType?: string;
    sourceType?: string;
    query?: string;
    limit?: number;
    userId?: string;
    memoryBankId?: string;
    memoryBankIds?: string[];
  }) {
    const requestedLimit = params.limit ?? 50;
    const timeline = await this.timeline({
      ...params,
      limit: Math.min(Math.max(requestedLimit * 3, requestedLimit), 500),
    });
    const items = timeline.items
      .filter((item) => this.matchesActivityFilter(item))
      .slice(0, requestedLimit);
    return { items, total: items.length };
  }

  async backfillWhatsappSenderNames(userId: string): Promise<{
    updated: number;
    scanned: number;
    needsRecoveryKey?: boolean;
  }> {
    const userKey = await this.resolveUserKey(userId);
    if (!userKey) return { updated: 0, scanned: 0, needsRecoveryKey: true };
    const userAccountIds = await this.getUserAccountIds(userId);
    if (!userAccountIds?.length) return { updated: 0, scanned: 0 };

    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          memory: memories,
          senderName: people.displayName,
        })
        .from(memories)
        .leftJoin(
          memoryPeople,
          and(eq(memoryPeople.memoryId, memories.id), eq(memoryPeople.role, 'sender')),
        )
        .leftJoin(people, eq(people.id, memoryPeople.personId))
        .where(
          and(
            eq(memories.connectorType, 'whatsapp'),
            eq(memories.sourceType, 'message'),
            inArray(memories.accountId, userAccountIds),
          ),
        )
        .limit(5000),
    );

    let updated = 0;
    for (const row of rows) {
      const mem = this.decryptMemoryAuto(row.memory, userId, userKey);
      if (this.isLockedMemory(mem)) continue;
      const metadata = this.metadataObject(mem.metadata);
      const isIncoming = metadata.fromMe === false || metadata.isFromMe === false;
      if (!isIncoming) continue;
      const currentSender =
        typeof metadata.senderName === 'string' ? metadata.senderName.trim() : '';
      if (currentSender && currentSender.toLowerCase() !== 'unknown') continue;
      const fallback = [row.senderName, metadata.senderPhone, metadata.pushName, metadata.senderLid]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find(Boolean);
      if (!fallback) continue;

      metadata.senderName = fallback;
      const text = mem.text.replace(/^Unknown(?=:|\s+sent\b)/i, fallback);
      const encrypted = this.crypto.encryptMemoryFieldsWithKey(
        {
          text,
          entities: mem.entities,
          claims: mem.claims,
          metadata: JSON.stringify(metadata),
        },
        userKey,
      );
      await this.dbService.withCurrentUser((db) =>
        db
          .update(memories)
          .set({
            text: encrypted.text,
            metadata: encrypted.metadata,
            searchTokens: sql`to_tsvector('english', ${text})`,
          })
          .where(eq(memories.id, mem.id)),
      );
      updated += 1;
    }

    return { updated, scanned: rows.length };
  }

  /** Phase 9: Get memories related to a given memory (via links + vector similarity) */
  async getRelated(memoryId: string, limit = 20) {
    const memory = await this.getById(memoryId);
    if (!memory) return { items: [], source: null };

    // 1. Direct graph links (memoryLinks table)
    const linkedIds = new Set<string>();
    const outLinks = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryLinks).where(eq(memoryLinks.srcMemoryId, memoryId)),
    );
    const inLinks = await this.dbService.withCurrentUser((db) =>
      db.select().from(memoryLinks).where(eq(memoryLinks.dstMemoryId, memoryId)),
    );
    for (const l of [...outLinks, ...inLinks]) {
      linkedIds.add(l.srcMemoryId === memoryId ? l.dstMemoryId : l.srcMemoryId);
    }

    // 2. Vector similarity (Qdrant recommend)
    const recommended = await this.searchIndex.recommend(memoryId, limit);
    for (const r of recommended) linkedIds.add(r.id);

    // 3. Same-contact memories (shared participants)
    const contactLinks = await this.dbService.withCurrentUser((db) =>
      db
        .select({ contactId: memoryPeople.personId })
        .from(memoryPeople)
        .where(eq(memoryPeople.memoryId, memoryId)),
    );
    const contactIdList = contactLinks.map((c) => c.contactId);

    if (contactIdList.length > 0) {
      const coMemories = await this.dbService.withCurrentUser((db) =>
        db
          .select({ memoryId: memoryPeople.memoryId })
          .from(memoryPeople)
          .where(inArray(memoryPeople.personId, contactIdList))
          .limit(limit * 2),
      );
      for (const cm of coMemories) {
        if (cm.memoryId !== memoryId) linkedIds.add(cm.memoryId);
      }
    }

    // Fetch and score all related
    linkedIds.delete(memoryId);
    const relatedIds = [...linkedIds].slice(0, limit * 2);
    const items: Array<Record<string, unknown>> = [];

    for (const id of relatedIds) {
      const row = await this.fetchMemoryRow(id);
      if (!row) continue;
      const mem = row.memory;

      // Score by: graph link > vector similarity > contact co-occurrence
      const graphLink =
        outLinks.some((l) => l.dstMemoryId === id) || inLinks.some((l) => l.srcMemoryId === id);
      const vectorScore = recommended.find((r) => r.id === id)?.score ?? 0;
      const score =
        (graphLink ? GRAPH_LINK_SCORE : 0) + vectorScore * GRAPH_VECTOR_WEIGHT + GRAPH_BASE_SCORE;

      items.push({
        id: mem.id,
        text: mem.text,
        sourceType: mem.sourceType,
        connectorType: mem.connectorType,
        eventTime: mem.eventTime,
        accountIdentifier: row.accountIdentifier,
        score,
        relationship: graphLink ? 'linked' : vectorScore > 0 ? 'similar' : 'co-participant',
      });
    }

    items.sort((a, b) => (b.score as number) - (a.score as number));
    return { items: items.slice(0, limit), source: memory };
  }

  /** Canonical entity types */
  getEntityTypes(): string[] {
    return [
      'person',
      'organization',
      'location',
      'event',
      'product',
      'topic',
      'pet',
      'group',
      'device',
      'other',
    ];
  }

  /** Phase 10: Search entities across all memories */
  async searchEntities(query: string, limit = 50, types?: string[], userId?: string) {
    const queryLower = query.toLowerCase();

    // Search in entities JSON column
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: memories.id,
          entities: memories.entities,
          connectorType: memories.connectorType,
          sourceType: memories.sourceType,
          eventTime: memories.eventTime,
        })
        .from(memories)
        .innerJoin(accounts, eq(memories.accountId, accounts.id))
        .where(
          and(
            userId ? eq(accounts.userId, userId) : undefined,
            eq(memories.pipelineComplete, true),
            sql`LOWER(${memories.entities}) LIKE ${'%' + escapeLike(queryLower) + '%'}`,
          ),
        )
        .limit(limit * 5),
    );

    // Extract and aggregate matching entities
    const entityMap = new Map<
      string,
      {
        value: string;
        type: string;
        memoryCount: number;
        memoryIds: string[];
        connectors: Set<string>;
      }
    >();

    for (const row of rows) {
      const entities = (() => {
        try {
          return JSON.parse(row.entities) as Array<{
            type?: string;
            value?: string;
            name?: string;
          }>;
        } catch {
          return null;
        }
      })();
      if (!entities) continue;

      for (const e of entities) {
        const value = e.value || e.name || (e as Record<string, unknown>).id;
        if (!value || !String(value).toLowerCase().includes(queryLower)) continue;

        const key = `${e.type}:${String(value).toLowerCase()}`;
        const existing = entityMap.get(key);
        if (existing) {
          existing.memoryCount++;
          if (existing.memoryIds.length < 5) existing.memoryIds.push(row.id);
          existing.connectors.add(row.connectorType);
        } else {
          entityMap.set(key, {
            value: String(value),
            type: e.type || 'unknown',
            memoryCount: 1,
            memoryIds: [row.id],
            connectors: new Set([row.connectorType]),
          });
        }
      }
    }

    // Filter by type if specified
    let entries = [...entityMap.values()];
    if (types && types.length > 0) {
      const typeSet = new Set(types.map((t) => t.toLowerCase()));
      entries = entries.filter((e) => typeSet.has(e.type.toLowerCase()));
    }

    const entities = entries
      .map((e) => ({ ...e, connectors: [...e.connectors] }))
      .sort((a, b) => b.memoryCount - a.memoryCount)
      .slice(0, limit);

    return { entities, total: entities.length };
  }

  /** Phase 10: Get entity details with related memories and co-occurring entities */
  async getEntityGraph(entityValue: string, limit = 30) {
    const queryLower = entityValue.toLowerCase();

    // Find memories containing this entity
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: memories.id,
          text: memories.text,
          entities: memories.entities,
          connectorType: memories.connectorType,
          sourceType: memories.sourceType,
          eventTime: memories.eventTime,
        })
        .from(memories)
        .where(
          and(
            eq(memories.pipelineComplete, true),
            sql`LOWER(${memories.entities}) LIKE ${'%' + escapeLike(queryLower) + '%'}`,
          ),
        )
        .orderBy(sql`${memories.eventTime} DESC`)
        .limit(limit),
    );

    // Collect co-occurring entities
    const coEntities = new Map<string, { value: string; type: string; count: number }>();
    const memoryItems = rows.map((row) => {
      let entities: Array<{ type?: string; value?: string; name?: string }> = [];
      try {
        entities = JSON.parse(row.entities);
      } catch {
        /* empty */
      }

      for (const e of entities) {
        const val = e.value || e.name || (e as Record<string, unknown>).id;
        if (!val) continue;
        const key = `${e.type}:${String(val).toLowerCase()}`;
        if (String(val).toLowerCase() === queryLower) continue;
        const existing = coEntities.get(key);
        if (existing) {
          existing.count++;
        } else {
          coEntities.set(key, { value: String(val), type: e.type || 'unknown', count: 1 });
        }
      }

      return {
        id: row.id,
        text: row.text.slice(0, 200),
        sourceType: row.sourceType,
        connectorType: row.connectorType,
        eventTime: row.eventTime,
      };
    });

    const relatedEntities = [...coEntities.values()].sort((a, b) => b.count - a.count).slice(0, 20);

    // Also check contacts matching this entity
    const matchingContacts = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: people.id, displayName: people.displayName })
        .from(people)
        .where(sql`LOWER(${people.displayName}) LIKE ${'%' + escapeLike(queryLower) + '%'}`)
        .limit(10),
    );

    return {
      entity: entityValue,
      memories: memoryItems,
      relatedEntities,
      contacts: matchingContacts,
      memoryCount: memoryItems.length,
    };
  }

  private buildQdrantFilter(filters: SearchFilters): Record<string, unknown> {
    const must: Array<Record<string, unknown>> = [];

    if (filters.sourceType) {
      must.push({ key: 'source_type', match: { value: filters.sourceType } });
    }
    if (filters.connectorType) {
      must.push({ key: 'connector_type', match: { value: filters.connectorType } });
    }
    if (filters.from || filters.to) {
      const range: Record<string, string> = {};
      if (filters.from) range.gte = filters.from;
      if (filters.to) range.lte = filters.to;
      must.push({ key: 'event_time', range });
    }
    // User scoping — filter by memory_bank_id if present in Qdrant payload
    if (filters.memoryBankId) {
      must.push({ key: 'memory_bank_id', match: { value: filters.memoryBankId } });
    } else if (filters.memoryBankIds?.length) {
      // API key scoped to specific memory banks
      must.push({ key: 'memory_bank_id', match: { any: filters.memoryBankIds } });
    }
    // User isolation — filter by account_id
    if (filters.accountIds?.length) {
      must.push({ key: 'account_id', match: { any: filters.accountIds } });
    }

    return must.length ? { must } : {};
  }
}
