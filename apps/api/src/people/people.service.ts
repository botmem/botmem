import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, or, sql, inArray, type SQLWrapper } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { CryptoService } from '../crypto/crypto.service';
import { UserKeyService } from '../crypto/user-key.service';
import { AccountsService } from '../accounts/accounts.service';
import {
  contacts as people,
  contactIdentifiers as personIdentifiers,
  memoryContacts as memoryPeople,
  memories,
  mergeDismissals,
  personRelationships,
  settings,
} from '../db/schema';
import { SYSTEM_SETTINGS_USER_ID } from '../settings/settings.service';

export interface IdentifierInput {
  type: string;
  value: string;
  connectorType?: string;
}

export interface PersonRelationshipInput {
  sourcePersonId: string;
  targetPersonId: string;
  relationshipType: string;
  connectorType?: string;
  sourceId: string;
  userId?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryPersonLinkInput {
  personId: string;
  role: string;
}

/** Normalize an email: lowercase, trim, strip plus-addressing. */
export function normalizeEmail(raw: string): string {
  const email = raw.toLowerCase().trim();
  return email.replace(/^([^@+]+)\+[^@]*(@.+)$/, '$1$2');
}

/** Normalize a phone number to E.164 format. */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (!digits.startsWith('+')) {
    const justDigits = digits.replace(/\D/g, '');
    if (justDigits.length >= 10) digits = '+' + justDigits;
  }
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMBEDDED_EMAIL_RE = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;

/**
 * Normalize an identifier: trim, lowercase where appropriate, reclassify
 * email-like values stored as names, and collapse whitespace in names.
 * Returns null if the identifier should be dropped (empty after normalization).
 */
export function normalizeIdentifier(ident: IdentifierInput): IdentifierInput | null {
  let { type, value } = ident;
  value = value.trim();
  if (!value) return null;
  if (type === 'person') type = 'name';

  // Reclassify: if a "name" looks like an email, treat it as email
  if (type === 'name' && EMAIL_RE.test(value)) {
    type = 'email';
  } else if (type === 'name') {
    const embeddedEmail = value.match(EMBEDDED_EMAIL_RE)?.[0];
    if (embeddedEmail) {
      type = 'email';
      value = embeddedEmail;
    }
  }

  switch (type) {
    case 'email':
      value = normalizeEmail(value);
      break;
    case 'phone':
      value = normalizePhone(value);
      break;
    case 'name':
      // Strip zero-width / directional Unicode chars, collapse whitespace
      value = value
        .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (looksLikeCombinedPersonName(value)) return null;
      break;
    default:
      // slack_id, immich_person_id, etc. — lowercase + trim
      value = value.toLowerCase().trim();
      break;
  }

  if (!value) return null;
  return { ...ident, type, value };
}

export interface PersonWithIdentifiers {
  id: string;
  displayName: string;
  avatars: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  identifiers: Array<{
    id: string;
    identifierType: string;
    identifierValue: string;
    connectorType: string | null;
    confidence: number;
  }>;
}

/** Generic short names that should never trigger merge suggestions */
export const GENERIC_NAMES = new Set([
  'me',
  'bot',
  'app',
  'admin',
  'user',
  'unknown',
  'test',
  'info',
  'no reply',
  'noreply',
]);

const TITLE_WORDS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'eng',
  'prof',
  'sir',
  'madam',
  'captain',
  'capt',
  'sheikh',
  'shaikh',
  'sh',
  'الدكتور',
  'دكتور',
]);
const COMMON_FIRST_NAMES = new Set([
  'mohamed',
  'mohamad',
  'mohammad',
  'mohammed',
  'mohd',
  'muhammad',
  'ahmed',
  'amr',
]);
const LIKELY_GIVEN_NAMES = new Set([
  ...COMMON_FIRST_NAMES,
  'abdulrahman',
  'abdelazeem',
  'abdulaziz',
  'abdullah',
  'abdul',
  'ali',
  'fahad',
  'faisal',
  'hassan',
  'hussein',
  'hussien',
  'khalid',
  'meshal',
  'mishal',
  'omar',
  'saad',
  'saleh',
  'sultan',
  'yousef',
  'yusuf',
]);

export function isMergeSuggestionEligibleEntity(entityType: string | null | undefined): boolean {
  return !entityType || entityType === 'person';
}

export function looksLikeGroupName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(dm|chat|group|conversation)\s+(with|for)\b/.test(normalized)) return true;
  if (/\b(group chat|whatsapp group|slack channel|telegram group)\b/.test(normalized)) return true;
  return /[/|;&+<>]/.test(name);
}

export function looksLikeCombinedPersonName(name: string): boolean {
  if (looksLikeIdentifierLabel(name) || looksLikeGroupName(name)) return false;
  const tokens = normalizeNameForMerge(name);
  if (tokens.length < 4 || tokens.length % 2 !== 0) return false;
  return LIKELY_GIVEN_NAMES.has(tokens[0]) && LIKELY_GIVEN_NAMES.has(tokens[2]);
}

export function isExactIdentifierAutoMergeEligible(
  identifierType: string,
  identifierValue: string,
): boolean {
  if (!identifierValue.trim()) return false;
  if (isGroupScopedIdentifier(identifierType)) return false;
  return identifierType !== 'name';
}

export function isGroupScopedIdentifier(identifierType: string): boolean {
  return (
    identifierType === 'whatsapp_group_jid' ||
    identifierType === 'imessage_group_id' ||
    identifierType === 'slack_channel_id' ||
    identifierType === 'telegram_group_id'
  );
}

export function looksLikeWhatsAppGroupPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('120363') && digits.length >= 15;
}

export function isGroupLikeIdentifier(identifierType: string, identifierValue: string): boolean {
  if (isGroupScopedIdentifier(identifierType)) return true;
  return identifierType === 'phone' && looksLikeWhatsAppGroupPhone(identifierValue);
}

export function hasDurablePersonIdentifier(identifiers: IdentifierInput[]): boolean {
  return identifiers.some((ident) => ident.type !== 'name' && !isGroupScopedIdentifier(ident.type));
}

export function isCompatiblePersonAlias(currentName: string, newName: string): boolean {
  const current = currentName.trim();
  const next = newName.trim();
  if (!current || current === 'Unknown' || looksLikeIdentifierLabel(current)) return true;
  if (!next || looksLikeIdentifierLabel(next)) return false;
  return shouldUpdateDisplayName(current, next) || isDirectNameAutoMergeEligible(current, next);
}

export function normalizeNameForMerge(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !TITLE_WORDS.has(token));
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
    }
  }
  return dp[a.length][b.length];
}

export interface MergeEvidence {
  confidence: number;
  positiveEvidence: string[];
  negativeEvidence: string[];
  sharedIdentifiers: string[];
  aliasSimilarity: number;
  cooccurrenceConflicts: string[];
}

export function scoreNameOnlyMerge(nameA: string, nameB: string): MergeEvidence {
  const a = normalizeNameForMerge(nameA);
  const b = normalizeNameForMerge(nameB);
  const positiveEvidence: string[] = [];
  const negativeEvidence: string[] = [];
  if (looksLikeIdentifierLabel(nameA) || looksLikeIdentifierLabel(nameB)) {
    return {
      confidence: 0,
      positiveEvidence,
      negativeEvidence: ['identifier-like label is not person-name evidence'],
      sharedIdentifiers: [],
      aliasSimilarity: 0,
      cooccurrenceConflicts: [],
    };
  }
  if (looksLikeCombinedPersonName(nameA) || looksLikeCombinedPersonName(nameB)) {
    return {
      confidence: 0,
      positiveEvidence,
      negativeEvidence: ['combined multi-person label is not person-name evidence'],
      sharedIdentifiers: [],
      aliasSimilarity: 0,
      cooccurrenceConflicts: [],
    };
  }
  if (!a.length || !b.length) {
    return {
      confidence: 0,
      positiveEvidence,
      negativeEvidence: ['empty normalized name'],
      sharedIdentifiers: [],
      aliasSimilarity: 0,
      cooccurrenceConflicts: [],
    };
  }
  if ((a.length > 1 && new Set(a).size === 1) || (b.length > 1 && new Set(b).size === 1)) {
    return {
      confidence: 0,
      positiveEvidence,
      negativeEvidence: ['repeated-token name is not person-name evidence'],
      sharedIdentifiers: [],
      aliasSimilarity: 0,
      cooccurrenceConflicts: [],
    };
  }

  if (looksLikeGroupName(nameA) || looksLikeGroupName(nameB)) {
    negativeEvidence.push('group or list-like name separator');
  }

  const setA = new Set(a);
  const setB = new Set(b);
  const shared = a.filter((token) => setB.has(token));
  const firstA = a[0];
  const firstB = b[0];
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  const shorterTokens = a.length <= b.length ? a : b;
  const longerTokens = a.length <= b.length ? b : a;
  const longerSet = a.length <= b.length ? setB : setA;
  const isMultiTokenSubset =
    shorterTokens.length >= 2 &&
    shorterTokens.length < longerTokens.length &&
    shorterTokens.every((token) => longerSet.has(token));
  const isPrefixSubset =
    isMultiTokenSubset && shorterTokens.every((token, index) => longerTokens[index] === token);
  const isEmbeddedSubset =
    isMultiTokenSubset &&
    !isPrefixSubset &&
    shorterTokens.every(
      (token, index) => longerTokens[longerTokens.length - shorterTokens.length + index] === token,
    );

  let score = 0;
  if (a.join(' ') === b.join(' ')) {
    score += 0.72;
    positiveEvidence.push('exact normalized full-name match');
  }
  if (a.slice().sort().join(' ') === b.slice().sort().join(' ')) {
    score += 0.72;
    positiveEvidence.push('same tokens in different order');
  }
  const sameTokenSet = a.slice().sort().join(' ') === b.slice().sort().join(' ');
  if (firstA !== firstB && !sameTokenSet) {
    score -= 0.35;
    negativeEvidence.push(`different first names "${firstA}" / "${firstB}"`);
  }
  if (firstA === firstB && firstA.length > 1) {
    score += COMMON_FIRST_NAMES.has(firstA) ? 0.08 : 0.18;
    positiveEvidence.push(`shared first name "${firstA}"`);
  }
  if (isPrefixSubset && a.join(' ') !== b.join(' ')) {
    score -= 0.35;
    negativeEvidence.push(
      `shorter name is only a prefix of longer name: ${shorterTokens.join(' ')}`,
    );
  } else if (isMultiTokenSubset && a.join(' ') !== b.join(' ')) {
    score += 0.45;
    positiveEvidence.push(`one name contains the other: ${shorterTokens.join(' ')}`);
  }
  if (isEmbeddedSubset && firstA !== firstB) {
    score -= 0.45;
    negativeEvidence.push(
      `embedded full-name fragment with different first name: ${shorterTokens.join(' ')}`,
    );
  }
  if (lastA === lastB && a.length > 1 && b.length > 1) {
    score += 0.28;
    positiveEvidence.push(`shared surname "${lastA}"`);
  } else if (a.length > 1 && b.length > 1 && !isMultiTokenSubset) {
    const dist = levenshtein(lastA, lastB);
    const prefix = lastA.startsWith(lastB) || lastB.startsWith(lastA);
    if ((prefix && Math.min(lastA.length, lastB.length) >= 6) || dist <= 1) {
      score += 0.38;
      positiveEvidence.push(`compatible surname variants "${lastA}" / "${lastB}"`);
    } else {
      score -= 0.3;
      negativeEvidence.push(`different surnames "${lastA}" / "${lastB}"`);
    }
  }
  if (shared.length >= 2) {
    score += Math.min(shared.length * 0.08, 0.24);
    positiveEvidence.push(`shared tokens: ${shared.join(', ')}`);
  }
  const initialsA = a.filter((token) => token.length === 1);
  const initialsB = b.filter((token) => token.length === 1);
  const longA = a.filter((token) => token.length > 1);
  const longB = b.filter((token) => token.length > 1);
  if (
    initialsA.some((initial) => longB.some((token) => token.startsWith(initial))) ||
    initialsB.some((initial) => longA.some((token) => token.startsWith(initial)))
  ) {
    score += 0.12;
    positiveEvidence.push('compatible middle initial');
  }
  if (a.length === 1 || b.length === 1) {
    score -= 0.34;
    negativeEvidence.push('first-name-only or single-token match');
  }
  if (COMMON_FIRST_NAMES.has(firstA) || COMMON_FIRST_NAMES.has(firstB)) {
    score -= 0.12;
    negativeEvidence.push('common first-name penalty');
  }

  const aliasSimilarity = Math.max(0, Math.min(1, score));
  return {
    confidence: Math.round(aliasSimilarity * 100) / 100,
    positiveEvidence,
    negativeEvidence,
    sharedIdentifiers: [],
    aliasSimilarity,
    cooccurrenceConflicts: [],
  };
}

export function isDirectNameAutoMergeEligible(nameA: string, nameB: string): boolean {
  const keyA = exactMultiWordNameAutoMergeKey(nameA);
  const keyB = exactMultiWordNameAutoMergeKey(nameB);
  return !!keyA && keyA === keyB;
}

export function exactDisplayNameAutoMergeKey(name: string): string | null {
  if (
    looksLikeIdentifierLabel(name) ||
    looksLikeGroupName(name) ||
    looksLikeCombinedPersonName(name)
  ) {
    return null;
  }

  const tokens = normalizeNameForExactAutoMerge(name);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => token.length < 2)) return null;
  if (new Set(tokens).size === 1 && tokens.length > 1) return null;
  const normalized = tokens.join(' ');
  if (GENERIC_NAMES.has(normalized)) return null;

  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.length < 4) return null;
    if (COMMON_FIRST_NAMES.has(token)) return null;
  }

  return normalized;
}

export function exactMultiWordNameAutoMergeKey(name: string): string | null {
  if (
    looksLikeIdentifierLabel(name) ||
    looksLikeGroupName(name) ||
    looksLikeCombinedPersonName(name)
  ) {
    return null;
  }

  const tokens = normalizeNameForExactAutoMerge(name);
  if (tokens.length < 2) return null;
  if (tokens.some((token) => token.length < 2)) return null;
  if (new Set(tokens).size === 1) return null;
  const normalized = tokens.join(' ');
  if (GENERIC_NAMES.has(normalized)) return null;
  return normalized;
}

function normalizeNameForExactAutoMerge(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Determine if a name looks like a structured identifier (phone, email, etc.) */
export function looksLikeIdentifier(name: string): boolean {
  const trimmed = name.trim();
  // Phone number: starts with + or digits, mostly digits
  if (/^\+?\d[\d\s\-()]{4,}$/.test(trimmed)) return true;
  // Email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  // Slack/WhatsApp ID patterns (e.g. U0XXXXXXX, @lid)
  if (/^[A-Z]\d{6,}$/.test(trimmed)) return true;
  return false;
}

export function looksLikeIdentifierLabel(name: string): boolean {
  const trimmed = name.trim();
  if (looksLikeIdentifier(trimmed)) return true;
  if (/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(trimmed)) return true;
  if (/<[^<>]+>/.test(trimmed)) return true;
  return false;
}

export function shouldUpdateDisplayName(currentName: string, newName: string): boolean {
  const current = currentName.trim();
  const next = newName.trim();
  if (!next || looksLikeIdentifierLabel(next)) return false;
  if (!current || current === 'Unknown' || looksLikeIdentifierLabel(current)) return true;

  const currentTokens = normalizeNameForMerge(current);
  const nextTokens = normalizeNameForMerge(next);
  if (!currentTokens.length || !nextTokens.length) return false;
  if (currentTokens.join(' ') === nextTokens.join(' ')) return true;
  if (isDirectNameAutoMergeEligible(current, next)) return true;

  // Allow improving a bare first-name display label to the same person's full
  // name, but never replace an established multi-token name with a different one.
  return currentTokens.length === 1 && nextTokens[0] === currentTokens[0] && nextTokens.length > 1;
}

/** Determine if name is a multi-word real name (first + last) */
export function isMultiWordName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length >= 2 && words.every((w) => w.length >= 2);
}

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);
  constructor(
    private dbService: DbService,
    private crypto: CryptoService,
    private userKeyService: UserKeyService,
    @Inject(forwardRef(() => AccountsService)) private accountsService: AccountsService,
  ) {}

  /** Encrypt a JSONB value (avatars or metadata) with APP_SECRET for at-rest protection. */
  private encryptJsonb(value: unknown): string {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    return this.crypto.encrypt(json)!;
  }

  /** Decrypt a JSONB value. Handles plaintext passthrough (pre-encryption data). */
  private decryptJsonb(value: unknown): unknown {
    if (value == null) return value;
    // If it's a string that looks encrypted (iv:data:tag), decrypt it
    if (typeof value === 'string') {
      const decrypted = this.crypto.decrypt(value);
      if (decrypted && decrypted !== value) {
        try {
          return JSON.parse(decrypted);
        } catch {
          return decrypted;
        }
      }
      // Not encrypted — try parsing as JSON
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    // Already a parsed object (pre-encryption JSONB) — return as-is
    return value;
  }

  private mergeAvatarLists(
    targetAvatars: unknown,
    sourceAvatars: unknown,
  ): Array<{ url: string; source: string }> {
    const normalize = (value: unknown): Array<{ url: string; source: string }> => {
      if (!Array.isArray(value)) return [];
      return value
        .map((avatar) => {
          if (!avatar || typeof avatar !== 'object') return null;
          const raw = avatar as Record<string, unknown>;
          const url = String(raw.url || '').trim();
          if (!url) return null;
          return {
            url,
            source: String(raw.source || 'unknown'),
          };
        })
        .filter((avatar): avatar is { url: string; source: string } => avatar !== null);
    };

    const merged = normalize(targetAvatars);
    const seenUrls = new Set(merged.map((avatar) => avatar.url));
    for (const avatar of normalize(sourceAvatars)) {
      if (seenUrls.has(avatar.url)) continue;
      merged.push(avatar);
      seenUrls.add(avatar.url);
    }
    return merged;
  }

  private buildNameAliasMetadata(
    metadata: unknown,
    aliases: IdentifierInput[],
  ): Record<string, unknown> {
    const base =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...(metadata as Record<string, unknown>) }
        : {};
    const existing = Array.isArray(base.nameAliases) ? base.nameAliases : [];
    const values = aliases
      .filter((alias) => alias.type === 'name' && alias.value.trim())
      .map((alias) => alias.value.trim());
    if (!values.length) return base;

    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const item of existing) {
      const value =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object'
            ? String((item as Record<string, unknown>).value || '')
            : '';
      if (!value.trim()) continue;
      const key = value.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(
        typeof item === 'string' ? { value: value.trim() } : (item as Record<string, unknown>),
      );
    }
    for (const value of values) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ value, source: 'connector_label' });
    }
    return { ...base, nameAliases: merged };
  }

  private metadataHasNameAlias(metadata: unknown, alias: string): boolean {
    const normalized = alias.trim().toLowerCase();
    if (!normalized) return true;
    const base = this.decryptJsonb(metadata);
    if (!base || typeof base !== 'object' || Array.isArray(base)) return false;
    const aliases = (base as Record<string, unknown>).nameAliases;
    if (!Array.isArray(aliases)) return false;
    return aliases.some((item) => {
      const value =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object'
            ? String((item as Record<string, unknown>).value || '')
            : '';
      return value.trim().toLowerCase() === normalized;
    });
  }

  private async updateNameAliases(personId: string, aliases: IdentifierInput[]): Promise<void> {
    if (!aliases.some((alias) => alias.type === 'name' && alias.value.trim())) return;
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select({ metadata: people.metadata }).from(people).where(eq(people.id, personId)),
    );
    if (!rows.length) return;
    await this.dbService.withCurrentUser((db) =>
      db
        .update(people)
        .set({
          metadata: this.encryptJsonb(
            this.buildNameAliasMetadata(this.decryptJsonb(rows[0].metadata), aliases),
          ),
          updatedAt: new Date(),
        })
        .where(eq(people.id, personId)),
    );
  }

  async resolvePerson(
    rawIdentifiers: IdentifierInput[],
    entityType?: 'person' | 'group' | 'organization' | 'device',
    userId?: string,
  ): Promise<PersonWithIdentifiers> {
    // Normalize + deduplicate identifiers
    const seen = new Set<string>();
    const identifiers: IdentifierInput[] = [];
    for (const raw of rawIdentifiers) {
      const norm = normalizeIdentifier(raw);
      if (!norm) continue;
      const key = `${norm.type}::${norm.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identifiers.push(norm);
    }
    const nameAliases = identifiers.filter((i) => i.type === 'name');
    const identityIdentifiers = identifiers.filter((i) => i.type !== 'name');

    // Find existing contacts matching structured identifiers only
    // Names are too ambiguous for matching — only use email, phone, slack_id, etc.
    const matchedContactIds = new Set<string>();

    if (identityIdentifiers.length) {
      // Build OR conditions for all structured identifiers using HMAC blind index
      const orConditions = identityIdentifiers.map(
        (i) =>
          sql`(${personIdentifiers.identifierType} = ${i.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(i.value)})`,
      );
      const whereClause = userId
        ? and(or(...orConditions), eq(people.userId, userId))
        : or(...orConditions);
      const rows = userId
        ? await this.dbService.withCurrentUser((db) =>
            db
              .select({ personId: personIdentifiers.personId })
              .from(personIdentifiers)
              .innerJoin(people, eq(people.id, personIdentifiers.personId))
              .where(whereClause!),
          )
        : await this.dbService.withCurrentUser((db) =>
            db
              .select({ personId: personIdentifiers.personId })
              .from(personIdentifiers)
              .where(whereClause!),
          );
      for (const row of rows) {
        matchedContactIds.add(row.personId);
      }
    }

    if (!matchedContactIds.size && entityType && entityType !== 'person' && nameAliases[0]) {
      const nameHash = this.crypto.hmac(nameAliases[0].value.toLowerCase());
      const conditions = [eq(people.entityType, entityType), eq(people.displayNameHash, nameHash)];
      if (userId) conditions.push(eq(people.userId, userId));
      const rows = await this.dbService.withCurrentUser((db) =>
        db
          .select({ id: people.id })
          .from(people)
          .where(and(...conditions))
          .limit(1),
      );
      if (rows[0]?.id) matchedContactIds.add(rows[0].id);
    }

    if (!matchedContactIds.size && (!entityType || entityType === 'person') && nameAliases[0]) {
      const exactNameKey = exactDisplayNameAutoMergeKey(nameAliases[0].value);
      if (exactNameKey && hasDurablePersonIdentifier(identityIdentifiers)) {
        const rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ id: people.id })
            .from(people)
            .innerJoin(personIdentifiers, eq(personIdentifiers.personId, people.id))
            .where(
              and(
                eq(people.entityType, 'person'),
                eq(people.displayNameHash, this.crypto.hmac(exactNameKey)),
                userId ? eq(people.userId, userId) : undefined,
                sql`${personIdentifiers.identifierType} != 'name'`,
                sql`${personIdentifiers.identifierType} NOT IN ('whatsapp_group_jid', 'imessage_group_id', 'slack_channel_id', 'telegram_group_id')`,
              ),
            )
            .limit(2),
        );
        const exactNameMatches = [...new Set(rows.map((row) => row.id))];
        if (exactNameMatches.length === 1) {
          matchedContactIds.add(exactNameMatches[0]);
        }
      }
    }

    const matchedIds = Array.from(matchedContactIds);
    let personId: string;
    const resolvingPerson = !entityType || entityType === 'person';
    let shouldCheckDuplicateStructuredIdentifiers = matchedIds.length > 1;

    if (matchedIds.length === 0) {
      if (resolvingPerson && !hasDurablePersonIdentifier(identityIdentifiers)) {
        throw new Error('Refusing to create person without a durable identifier');
      }

      // Create new contact
      personId = randomUUID();
      const now = new Date();
      const nameIdent = nameAliases[0];
      const displayName = nameIdent?.value || identifiers[0]?.value || 'Unknown';

      await this.dbService.withCurrentUser((db) =>
        db.insert(people).values({
          id: personId,
          displayName: this.crypto.encrypt(displayName)!,
          displayNameHash: this.crypto.hmac(displayName.toLowerCase()),
          entityType: entityType || 'person',
          metadata: this.encryptJsonb(this.buildNameAliasMetadata({}, nameAliases)),
          userId: userId || null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      // Name-only matches are intentionally not auto-merged. Strong identifiers
      // below (email, phone, connector ids) are the only automatic merge evidence.
    } else if (matchedIds.length === 1) {
      personId = matchedIds[0];
    } else {
      // Multiple contacts matched — merge them into the first one
      personId = matchedIds[0];
      const otherIds = matchedIds.slice(1);

      for (const otherId of otherIds) {
        try {
          await this.mergePeople(personId, otherId);
        } catch {
          // Concurrent merge may have already handled this — ignore
        }
      }
    }

    // Add any new identifiers that don't already exist.
    // The contact may be deleted by a concurrent merge — if so, find where
    // our identifiers ended up and switch to that contact.
    let identInsertAttempts = 0;
    while (identInsertAttempts < 3) {
      try {
        const existingIdents = await this.dbService.withCurrentUser((db) =>
          db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
        );

        // Compare using HMAC hashes so we can check against encrypted stored values
        const existingKeys = new Set(
          existingIdents.map((e) => `${e.identifierType}::${e.identifierValueHash || ''}`),
        );
        const newIdents = identityIdentifiers.filter(
          (i) => !existingKeys.has(`${i.type}::${this.crypto.hmac(i.value)}`),
        );
        if (newIdents.length) {
          shouldCheckDuplicateStructuredIdentifiers = true;
          const now = new Date();
          await this.dbService.withCurrentUser((db) =>
            db
              .insert(personIdentifiers)
              .values(
                newIdents.map((ident) => ({
                  id: randomUUID(),
                  personId,
                  identifierType: ident.type,
                  identifierValue: this.crypto.encrypt(ident.value)!,
                  identifierValueHash: this.crypto.hmac(ident.value),
                  connectorType: ident.connectorType || null,
                  createdAt: now,
                })),
              )
              .onConflictDoNothing(),
          );
        }
        break; // Success
      } catch (err: unknown) {
        identInsertAttempts++;
        if ((err as { code?: string }).code === '23503' && identInsertAttempts < 3) {
          // Contact was merged/deleted concurrently — find where identifiers went
          const probe = identityIdentifiers[0];
          if (probe) {
            const rows = await this.dbService.withCurrentUser((db) =>
              db
                .select({ personId: personIdentifiers.personId })
                .from(personIdentifiers)
                .innerJoin(people, eq(people.id, personIdentifiers.personId))
                .where(
                  and(
                    sql`${personIdentifiers.identifierType} = ${probe.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(probe.value)}`,
                    userId ? eq(people.userId, userId) : undefined,
                  ),
                )
                .limit(1),
            );
            if (rows.length) {
              personId = rows[0].personId;
              continue; // Retry with the new contactId
            }
          }
        }
        throw err;
      }
    }

    // Update display name only when the incoming label is clearly an improvement.
    const nameIdent = nameAliases[0];
    if (nameIdent) {
      const existing = await this.dbService.withCurrentUser((db) =>
        db
          .select({ displayName: people.displayName, metadata: people.metadata })
          .from(people)
          .where(eq(people.id, personId)),
      );
      if (!existing.length) {
        return (await this.getById(personId))!;
      }
      const rawName = existing[0]?.displayName || '';
      const currentName = this.crypto.decrypt(rawName) ?? rawName;
      const patch: Partial<typeof people.$inferInsert> = {};
      if (!this.metadataHasNameAlias(existing[0]?.metadata, nameIdent.value)) {
        patch.metadata = this.encryptJsonb(
          this.buildNameAliasMetadata(this.decryptJsonb(existing[0]?.metadata), nameAliases),
        );
      }
      if (
        isCompatiblePersonAlias(currentName, nameIdent.value) &&
        shouldUpdateDisplayName(currentName, nameIdent.value)
      ) {
        patch.displayName = this.crypto.encrypt(nameIdent.value)!;
        patch.displayNameHash = this.crypto.hmac(nameIdent.value.toLowerCase());
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = new Date();
        await this.dbService.withCurrentUser((db) =>
          db.update(people).set(patch).where(eq(people.id, personId)),
        );
      }
    }

    // Update entityType if caller provides a non-person type and contact is currently person-typed
    if (entityType && entityType !== 'person' && !hasDurablePersonIdentifier(identityIdentifiers)) {
      const current = await this.dbService.withCurrentUser((db) =>
        db.select({ entityType: people.entityType }).from(people).where(eq(people.id, personId)),
      );
      if (current.length && (!current[0].entityType || current[0].entityType === 'person')) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({ entityType, updatedAt: new Date() })
            .where(eq(people.id, personId)),
        );
      }
    }

    // Auto-merge: if any non-name identifier on this contact also belongs to
    // another contact, absorb that contact automatically.
    // Capped at 5 merges per resolve to prevent infinite loops from circular references.
    try {
      if (!shouldCheckDuplicateStructuredIdentifiers) {
        return (await this.getById(personId))!;
      }
      const allIdentsForContact = await this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
      );

      const MAX_MERGES_PER_RESOLVE = 5;

      // Find all duplicate contacts in a single query
      const structuredContactIdents = allIdentsForContact.filter(
        (i) => i.identifierType !== 'name',
      );
      let dupeContactIds: string[] = [];
      if (structuredContactIdents.length) {
        const orConds = structuredContactIdents.map(
          (i) =>
            sql`(${personIdentifiers.identifierType} = ${i.identifierType} AND ${personIdentifiers.identifierValueHash} = ${i.identifierValueHash})`,
        );
        const dupeRows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ personId: personIdentifiers.personId })
            .from(personIdentifiers)
            .innerJoin(people, eq(people.id, personIdentifiers.personId))
            .where(
              and(
                or(...orConds),
                sql`${personIdentifiers.personId} != ${personId}`,
                userId ? eq(people.userId, userId) : undefined,
              ),
            ),
        );
        dupeContactIds = [...new Set(dupeRows.map((r) => r.personId))];
      }

      let mergeCount = 0;
      for (const dupeId of dupeContactIds) {
        if (mergeCount >= MAX_MERGES_PER_RESOLVE) break;
        await this.mergePeople(personId, dupeId);
        mergeCount++;
      }

      if (mergeCount >= MAX_MERGES_PER_RESOLVE) {
        this.logger.warn(
          `[resolvePerson] hit merge cap (${MAX_MERGES_PER_RESOLVE}) for contact ${personId} — skipping remaining`,
        );
      }
    } catch (err) {
      // Auto-merge is best-effort — don't fail the resolve
      this.logger.debug(
        `[resolvePerson] auto-merge skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = await this.getById(personId);
    if (!result) {
      // Contact was deleted by a concurrent merge — it was absorbed into another contact.
      // Find where our identifiers ended up.
      const movedIdent = identityIdentifiers[0];
      if (movedIdent) {
        const rows = await this.dbService.withCurrentUser((db) =>
          db
            .select({ personId: personIdentifiers.personId })
            .from(personIdentifiers)
            .innerJoin(people, eq(people.id, personIdentifiers.personId))
            .where(
              and(
                sql`${personIdentifiers.identifierType} = ${movedIdent.type} AND ${personIdentifiers.identifierValueHash} = ${this.crypto.hmac(movedIdent.value)}`,
                userId ? eq(people.userId, userId) : undefined,
              ),
            )
            .limit(1),
        );
        if (rows.length) {
          return this.getById(rows[0].personId) as Promise<PersonWithIdentifiers>;
        }
      }
      throw new Error(`Contact ${personId} was deleted during resolution`);
    }
    return result;
  }

  async upsertRelationship(input: PersonRelationshipInput): Promise<void> {
    if (input.sourcePersonId === input.targetPersonId) return;

    const now = new Date();
    const values = {
      id: randomUUID(),
      userId: input.userId || null,
      sourcePersonId: input.sourcePersonId,
      targetPersonId: input.targetPersonId,
      relationshipType: input.relationshipType,
      connectorType: input.connectorType || null,
      sourceId: input.sourceId,
      confidence: input.confidence ?? 1.0,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    await this.dbService.withCurrentUser((db) =>
      db
        .insert(personRelationships)
        .values(values)
        .onConflictDoUpdate({
          target: [
            personRelationships.sourcePersonId,
            personRelationships.targetPersonId,
            personRelationships.relationshipType,
            personRelationships.connectorType,
            personRelationships.sourceId,
          ],
          set: {
            userId: values.userId,
            confidence: values.confidence,
            metadata: values.metadata,
            updatedAt: now,
          },
        }),
    );
  }

  async getById(id: string): Promise<PersonWithIdentifiers | null> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, id)),
    );
    if (!rows.length) return null;

    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, id)),
    );

    return {
      ...rows[0],
      displayName: this.crypto.decrypt(rows[0].displayName) ?? rows[0].displayName,
      avatars: this.decryptJsonb(rows[0].avatars),
      metadata: this.decryptJsonb(rows[0].metadata),
      identifiers: idents.map((i) => ({
        id: i.id,
        identifierType: i.identifierType,
        identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
        connectorType: i.connectorType,
        confidence: i.confidence,
      })),
    };
  }

  /**
   * Get a contact by ID with user ownership validation.
   * Throws (treated as 404) to prevent enumeration if not owned by user.
   */
  async getByIdForUser(id: string, userId: string): Promise<PersonWithIdentifiers> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(people)
        .where(and(eq(people.id, id), eq(people.userId, userId))),
    );
    if (!rows.length) {
      throw new Error('Contact not found');
    }

    const idents = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: personIdentifiers.id,
          personId: personIdentifiers.personId,
          identifierType: personIdentifiers.identifierType,
          identifierValue: personIdentifiers.identifierValue,
          identifierValueHash: personIdentifiers.identifierValueHash,
          connectorType: personIdentifiers.connectorType,
          confidence: personIdentifiers.confidence,
          createdAt: personIdentifiers.createdAt,
        })
        .from(personIdentifiers)
        .innerJoin(people, eq(people.id, personIdentifiers.personId))
        .where(and(eq(personIdentifiers.personId, id), eq(people.userId, userId))),
    );

    return {
      ...rows[0],
      displayName: this.crypto.decrypt(rows[0].displayName) ?? rows[0].displayName,
      avatars: this.decryptJsonb(rows[0].avatars),
      metadata: this.decryptJsonb(rows[0].metadata),
      identifiers: idents.map((i) => ({
        id: i.id,
        identifierType: i.identifierType,
        identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
        connectorType: i.connectorType,
        confidence: i.confidence,
      })),
    };
  }

  /**
   * Check if an identifier is a device-format identifier (e.g., "amr/iphone" from OwnTracks).
   * Device identifiers should not appear in the people list.
   */
  private isDeviceIdentifier(ident: typeof personIdentifiers.$inferSelect): boolean {
    const { identifierType } = ident;
    const identifierValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;

    // OwnTracks device format: 'user/device' (e.g., 'amr/iphone')
    if (identifierType === 'device' && identifierValue.includes('/')) return true;

    // Handle format 'connector:user/device' stored as handle
    if (identifierType === 'handle' && /^[\w]+\/[\w]+$/.test(identifierValue)) {
      // Conservative: could be device format, but also could be legitimate handle
      // Only filter if confidence is very low or from owntracks connector
      return true;
    }

    return false;
  }

  /**
   * Check if a contact is device-only (all identifiers are device identifiers).
   */
  private isDeviceOnlyContact(identifiers: (typeof personIdentifiers.$inferSelect)[]): boolean {
    if (identifiers.length === 0) return false;
    return identifiers.every((i) => this.isDeviceIdentifier(i));
  }

  private isGroupLikeContact(
    contact: { entityType?: string | null; displayName?: string | null },
    identifiers: Array<{ identifierType: string; identifierValue: string }>,
  ): boolean {
    if (contact.entityType === 'group') return true;
    const displayName =
      typeof contact.displayName === 'string'
        ? (this.crypto.decrypt(contact.displayName) ?? contact.displayName)
        : '';
    if (displayName && looksLikeGroupName(displayName)) return true;
    return identifiers.some((ident) =>
      isGroupLikeIdentifier(
        ident.identifierType,
        this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue,
      ),
    );
  }

  async list(
    params: { limit?: number; offset?: number; entityType?: string; userId?: string } = {},
  ): Promise<{
    items: PersonWithIdentifiers[];
    total: number;
  }> {
    const limit = params.limit || 50;
    const offset = params.offset || 0;

    const conditions: (SQLWrapper | undefined)[] = [];
    if (params.entityType) conditions.push(eq(people.entityType, params.entityType));
    if (params.userId) conditions.push(eq(people.userId, params.userId));
    const where = conditions.length ? and(...conditions) : undefined;

    // Get total count without fetching all rows
    const countResult = await this.dbService.withCurrentUser((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(people)
        .where(where),
    );
    const total = Number(countResult[0]?.count) || 0;

    // Get selfPersonId to pin it first. Self identity is scoped per user.
    let selfPersonId = '';
    if (params.userId) {
      const userId = params.userId;
      const perUserRow = await this.dbService.withCurrentUser((db) =>
        db
          .select({ value: settings.value })
          .from(settings)
          .where(
            and(
              eq(settings.userId, userId),
              inArray(settings.key, ['selfPersonId', 'selfContactId']),
            ),
          )
          .limit(1),
      );
      selfPersonId = perUserRow[0]?.value || '';
    }

    // Paginate: self-contact first, then by cached memory count desc
    const paged = await this.dbService.withCurrentUser((db) =>
      db
        .select({
          id: people.id,
          displayName: people.displayName,
          entityType: people.entityType,
          avatars: people.avatars,
          metadata: people.metadata,
          memoryCount: people.memoryCount,
          createdAt: people.createdAt,
          updatedAt: people.updatedAt,
        })
        .from(people)
        .where(where)
        .orderBy(
          sql`CASE WHEN ${people.id} = ${selfPersonId} THEN 0 ELSE 1 END`,
          sql`${people.memoryCount} DESC`,
          sql`${people.updatedAt} DESC`,
        )
        .limit(limit)
        .offset(offset),
    );

    if (paged.length === 0) {
      return { items: [], total };
    }

    // Batch-fetch all identifiers for this page in one query
    const pagedIds = paged.map((c) => c.id);
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, pagedIds)),
    );

    // Group identifiers by contactId
    const identsByContact = new Map<string, typeof allIdents>();
    for (const ident of allIdents) {
      const list = identsByContact.get(ident.personId) || [];
      list.push(ident);
      identsByContact.set(ident.personId, list);
    }

    // Filter out device-only contacts
    const filteredPaged = paged.filter((c) => {
      const idents = identsByContact.get(c.id) || [];
      if (this.isDeviceOnlyContact(idents)) return false;
      const groupLike = this.isGroupLikeContact(c, idents);
      if (params.entityType === 'person' && groupLike) return false;
      if (params.entityType === 'group' && !groupLike) return false;
      return true;
    });

    const items: PersonWithIdentifiers[] = filteredPaged.map((c) => {
      const idents = identsByContact.get(c.id) || [];
      return {
        ...c,
        displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
        avatars: this.decryptJsonb(c.avatars),
        metadata: this.decryptJsonb(c.metadata),
        identifiers: idents.map((i) => ({
          id: i.id,
          identifierType: i.identifierType,
          identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
          connectorType: i.connectorType,
          confidence: i.confidence,
        })),
      };
    });

    return { items, total };
  }

  async search(
    query: string,
    userId?: string,
    entityType?: string,
    limit = 25,
  ): Promise<PersonWithIdentifiers[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const maxResults = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 25, 100));
    const lowerQuery = trimmedQuery.toLowerCase();
    const normQuery = trimmedQuery
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    // Since display names and identifier values are encrypted, we can't use SQL LIKE.
    // Fetch contacts (scoped to user) and filter in-memory after decryption.
    const conditions: SQLWrapper[] = [];
    if (userId) conditions.push(eq(people.userId, userId));
    if (entityType && entityType !== 'person' && entityType !== 'group') {
      conditions.push(eq(people.entityType, entityType));
    }
    const allContactRows = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(people)
        .where(conditions.length ? and(...conditions) : undefined),
    );

    const contactById = new Map(allContactRows.map((contact) => [contact.id, contact]));
    const matches = new Map<string, { score: number; order: number }>();
    const addMatch = (id: string, score: number, order: number) => {
      const existing = matches.get(id);
      if (
        !existing ||
        score > existing.score ||
        (score === existing.score && order < existing.order)
      ) {
        matches.set(id, { score, order });
      }
    };

    for (let index = 0; index < allContactRows.length; index++) {
      const c = allContactRows[index];
      const decryptedName = this.crypto.decrypt(c.displayName) ?? c.displayName;
      const lowerName = decryptedName.toLowerCase();
      const normName = decryptedName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      if (lowerName.includes(lowerQuery) || normName.includes(normQuery)) {
        const exact = lowerName === lowerQuery || normName === normQuery;
        const prefix = lowerName.startsWith(lowerQuery) || normName.startsWith(normQuery);
        addMatch(c.id, exact ? 100 : prefix ? 80 : 60, index);
      }
    }

    const contactIds = allContactRows.map((contact) => contact.id);
    const allIdentRows = await this.dbService.withCurrentUser((db) =>
      contactIds.length
        ? db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, contactIds))
        : Promise.resolve([]),
    );

    // Build identifier lookup by contactId
    const identsByContact = new Map<string, typeof allIdentRows>();
    for (const ident of allIdentRows) {
      const list = identsByContact.get(ident.personId) || [];
      list.push(ident);
      identsByContact.set(ident.personId, list);
    }

    for (let index = 0; index < allContactRows.length; index++) {
      const c = allContactRows[index];
      const idents = identsByContact.get(c.id) || [];
      const groupLike = this.isGroupLikeContact(c, idents);
      if (entityType === 'person' && groupLike) continue;
      if (entityType === 'group' && !groupLike) continue;
      for (const i of idents) {
        const decryptedValue = this.crypto.decrypt(i.identifierValue) ?? i.identifierValue;
        const lowerValue = decryptedValue.toLowerCase();
        if (lowerValue.includes(lowerQuery)) {
          const exact = lowerValue === lowerQuery;
          const prefix = lowerValue.startsWith(lowerQuery);
          addMatch(c.id, exact ? 95 : prefix ? 75 : 55, index);
        }
      }
    }

    const matchedIds = [...matches.entries()]
      .filter(([id]) => {
        const c = contactById.get(id);
        if (!c) return false;
        const groupLike = this.isGroupLikeContact(c, identsByContact.get(id) || []);
        if (entityType === 'person' && groupLike) return false;
        if (entityType === 'group' && !groupLike) return false;
        return true;
      })
      .sort(([aId, a], [bId, b]) => {
        const aContact = contactById.get(aId);
        const bContact = contactById.get(bId);
        return (
          b.score - a.score ||
          (bContact?.memoryCount ?? 0) - (aContact?.memoryCount ?? 0) ||
          a.order - b.order
        );
      })
      .slice(0, maxResults)
      .map(([id]) => id);

    const results: PersonWithIdentifiers[] = [];
    for (const id of matchedIds) {
      const c = contactById.get(id);
      if (!c) continue;
      const idents = identsByContact.get(c.id) || [];
      results.push({
        ...c,
        displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
        avatars: this.decryptJsonb(c.avatars),
        metadata: this.decryptJsonb(c.metadata),
        identifiers: idents.map((i) => ({
          id: i.id,
          identifierType: i.identifierType,
          identifierValue: this.crypto.decrypt(i.identifierValue) ?? i.identifierValue,
          connectorType: i.connectorType,
          confidence: i.confidence,
        })),
      });
    }
    return results;
  }

  /**
   * Download avatar image and store as base64 data URI in the contact's avatars array.
   * Falls back to storing the URL if download fails.
   */
  async updateAvatar(
    personId: string,
    avatar: { url: string; source: string },
    fetchHeaders?: Record<string, string>,
  ): Promise<void> {
    const rows = await this.dbService.withCurrentUser((db) =>
      db.select({ avatars: people.avatars }).from(people).where(eq(people.id, personId)),
    );
    if (!rows.length) return;

    const existing: Array<{ url: string; source: string }> =
      (this.decryptJsonb(rows[0].avatars) as Array<{ url: string; source: string }>) || [];

    // Skip if we already have an avatar from this source
    if (existing.some((a) => a.source === avatar.source)) return;

    // Download image and convert to data URI
    let storedAvatar = avatar;
    try {
      const res = await fetch(avatar.url, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
        storedAvatar = { url: dataUri, source: avatar.source };
      }
    } catch {
      // Fall back to storing the URL
    }

    // Immich face thumbnails get priority — prepend to front
    const updated =
      avatar.source === 'immich' ? [storedAvatar, ...existing] : [...existing, storedAvatar];

    await this.dbService.withCurrentUser((db) =>
      db
        .update(people)
        .set({ avatars: this.encryptJsonb(updated), updatedAt: new Date() })
        .where(eq(people.id, personId)),
    );
  }

  /**
   * Backfill: download all URL-based avatars and convert to base64 data URIs in-place.
   */
  async backfillAvatarData(userId?: string): Promise<{ converted: number; failed: number }> {
    const allContacts = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: people.id, avatars: people.avatars })
        .from(people)
        .where(
          userId
            ? and(
                eq(people.userId, userId),
                sql`${people.avatars} IS NOT NULL AND ${people.avatars}::text != '[]' AND ${people.avatars}::text != '""'`,
              )
            : sql`${people.avatars} IS NOT NULL AND ${people.avatars}::text != '[]' AND ${people.avatars}::text != '""'`,
        ),
    );

    // Build auth headers for Immich
    let immichHeaders: Record<string, string> = {};
    try {
      const allAccounts = await this.accountsService.getAll(userId);
      const photosAccount = allAccounts.find((a) => a.connectorType === 'photos');
      if (photosAccount?.authContext) {
        const auth =
          typeof photosAccount.authContext === 'string'
            ? JSON.parse(photosAccount.authContext)
            : photosAccount.authContext;
        if (auth?.accessToken) immichHeaders = { 'x-api-key': auth.accessToken };
      }
    } catch {
      // No immich account
    }

    let converted = 0;
    let failed = 0;

    for (const contact of allContacts) {
      const avatars =
        (this.decryptJsonb(contact.avatars) as Array<{ url: string; source: string }>) || [];
      if (!avatars.length) continue;

      let changed = false;
      const updated: Array<{ url: string; source: string }> = [];

      for (const avatar of avatars) {
        if (avatar.url.startsWith('data:')) {
          updated.push(avatar);
          continue;
        }

        // Download and convert
        const headers: Record<string, string> = {};
        if (avatar.source === 'immich') Object.assign(headers, immichHeaders);

        try {
          const res = await fetch(avatar.url, { headers, signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const contentType = res.headers.get('content-type') || 'image/jpeg';
            const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
            updated.push({ url: dataUri, source: avatar.source });
            changed = true;
            converted++;
          } else {
            updated.push(avatar); // Keep URL as fallback
            failed++;
          }
        } catch {
          updated.push(avatar);
          failed++;
        }
      }

      if (changed) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({ avatars: this.encryptJsonb(updated), updatedAt: new Date() })
            .where(eq(people.id, contact.id)),
        );
      }
    }

    return { converted, failed };
  }

  async linkMemory(memoryId: string, personId: string, role: string): Promise<void> {
    try {
      await this.dbService.withCurrentUser((db) =>
        db.insert(memoryPeople).values({
          id: randomUUID(),
          memoryId,
          personId,
          role,
        }),
      );
      // Increment cached memory count
      await this.dbService.withCurrentUser((db) =>
        db
          .update(people)
          .set({ memoryCount: sql`${people.memoryCount} + 1` })
          .where(eq(people.id, personId)),
      );
    } catch (err: unknown) {
      // Contact may have been merged/deleted concurrently — skip silently
      if ((err as { code?: string }).code === '23503') return;
      throw err;
    }
  }

  async linkMemoryBatch(memoryId: string, links: MemoryPersonLinkInput[]): Promise<number> {
    const unique = new Map<string, MemoryPersonLinkInput>();
    for (const link of links) {
      if (!link.personId || !link.role) continue;
      unique.set(`${link.personId}:${link.role}`, link);
    }
    const values = [...unique.values()];
    if (!values.length) return 0;

    try {
      const inserted = await this.dbService.withCurrentUser((db) =>
        db
          .insert(memoryPeople)
          .values(
            values.map((link) => ({
              id: randomUUID(),
              memoryId,
              personId: link.personId,
              role: link.role,
            })),
          )
          .onConflictDoNothing()
          .returning({ personId: memoryPeople.personId }),
      );

      const counts = new Map<string, number>();
      for (const row of inserted) {
        counts.set(row.personId, (counts.get(row.personId) || 0) + 1);
      }

      for (const [personId, count] of counts) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({ memoryCount: sql`${people.memoryCount} + ${count}` })
            .where(eq(people.id, personId)),
        );
      }

      return inserted.length;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23503') return 0;
      throw err;
    }
  }

  async getMemories(
    personId: string,
    limit = 50,
    userId?: string,
  ): Promise<Record<string, unknown>[]> {
    const conditions = [eq(memoryPeople.personId, personId)];
    if (userId) {
      // Filter memories to only those belonging to user's accounts
      conditions.push(
        sql`${memories.accountId} IN (SELECT id FROM accounts WHERE user_id = ${userId})`,
      );
    }

    const mems = await this.dbService.withCurrentUser((db) =>
      db
        .select({ memory: memories })
        .from(memoryPeople)
        .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
        .where(and(...conditions))
        .limit(limit),
    );

    let userKey: Buffer | null = null;
    if (userId) {
      userKey = await this.userKeyService.getDek(userId);
    }
    return mems.map((r) => this.decryptMemory(r.memory, userId, userKey));
  }

  private decryptMemory<
    T extends {
      text: string;
      entities: string;
      claims: string;
      metadata: string;
    },
  >(mem: T, userId?: string, userKey?: Buffer | null): T {
    if (userKey) {
      return this.crypto.decryptMemoryFieldsWithKey(mem, userKey);
    }
    if (this.crypto.isEncrypted(mem.text)) {
      return {
        ...mem,
        text: '[Encrypted — enter your recovery key to view]',
        entities: '[]',
        claims: '[]',
      };
    }
    return mem;
  }

  async updatePerson(
    id: string,
    updates: {
      displayName?: string;
      avatars?: Array<{ url: string; source: string }>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PersonWithIdentifiers | null> {
    // Check contact exists
    const existing = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, id)),
    );
    if (!existing.length) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.displayName !== undefined) {
      patch.displayName = this.crypto.encrypt(updates.displayName)!;
      patch.displayNameHash = this.crypto.hmac(updates.displayName.toLowerCase());
    }
    if (updates.avatars !== undefined) patch.avatars = this.encryptJsonb(updates.avatars);
    if (updates.metadata !== undefined) patch.metadata = this.encryptJsonb(updates.metadata);

    await this.dbService.withCurrentUser((db) =>
      db.update(people).set(patch).where(eq(people.id, id)),
    );

    return this.getById(id);
  }

  async mergePeople(targetId: string, sourceId: string): Promise<PersonWithIdentifiers> {
    // Retry on deadlock up to 3 times
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.dbService.withCurrentUser(
          async (db) =>
            await db.transaction(async (tx) => {
              const targetRows = await tx.select().from(people).where(eq(people.id, targetId));
              const sourceRows = await tx.select().from(people).where(eq(people.id, sourceId));

              if (!targetRows.length || !sourceRows.length) return; // Either side already merged/deleted -- nothing to do

              const target = targetRows[0];
              const source = sourceRows[0];
              if (target.userId !== source.userId) {
                throw new Error('Refusing to merge people across different users');
              }

              const sourceIds = await tx
                .select()
                .from(personIdentifiers)
                .where(eq(personIdentifiers.personId, sourceId));
              const targetIds = await tx
                .select()
                .from(personIdentifiers)
                .where(eq(personIdentifiers.personId, targetId));
              if (
                this.isGroupLikeContact(target, targetIds) ||
                this.isGroupLikeContact(source, sourceIds)
              ) {
                throw new Error('Refusing to merge groups through the people merge path');
              }

              // Merge avatars (target first, then source, dedup by url)
              const targetAvatars = this.mergeAvatarLists(
                this.decryptJsonb(target.avatars),
                this.decryptJsonb(source.avatars),
              );

              // Prefer a real name over phone numbers / raw IDs
              // Decrypt display names for comparison
              const decryptedSourceName =
                this.crypto.decrypt(source.displayName) ?? source.displayName;
              const decryptedTargetName =
                this.crypto.decrypt(target.displayName) ?? target.displayName;
              const isPhone = (s: string) => /^\+?\d[\d\s-]{5,}$/.test(s.trim());
              const isRawId = (s: string) => /\bU[A-Z0-9]{8,}\b/.test(s);
              const sourceIsName =
                !isPhone(decryptedSourceName) &&
                !isRawId(decryptedSourceName) &&
                decryptedSourceName !== 'Unknown';
              const targetIsName =
                !isPhone(decryptedTargetName) &&
                !isRawId(decryptedTargetName) &&
                decryptedTargetName !== 'Unknown';
              let chosenName: string;
              if (sourceIsName && !targetIsName) {
                chosenName = decryptedSourceName;
              } else if (targetIsName && !sourceIsName) {
                chosenName = decryptedTargetName;
              } else {
                // Both are names or both aren't — keep the longer one
                chosenName =
                  decryptedSourceName.length > decryptedTargetName.length
                    ? decryptedSourceName
                    : decryptedTargetName;
              }
              // Re-encrypt the chosen name for storage
              const displayName = this.crypto.encrypt(chosenName)!;
              const displayNameHash = this.crypto.hmac(chosenName.toLowerCase());

              // Move identifiers from source to target, skipping duplicates
              const targetIdKeys = new Set(
                targetIds.map((i) => `${i.identifierType}::${i.identifierValueHash || ''}`),
              );
              const dupeIdentIds = sourceIds
                .filter((i) =>
                  targetIdKeys.has(`${i.identifierType}::${i.identifierValueHash || ''}`),
                )
                .map((i) => i.id);
              const moveIdentIds = sourceIds
                .filter(
                  (i) => !targetIdKeys.has(`${i.identifierType}::${i.identifierValueHash || ''}`),
                )
                .map((i) => i.id);
              if (dupeIdentIds.length) {
                await tx
                  .delete(personIdentifiers)
                  .where(inArray(personIdentifiers.id, dupeIdentIds));
              }
              if (moveIdentIds.length) {
                await tx
                  .update(personIdentifiers)
                  .set({ personId: targetId })
                  .where(inArray(personIdentifiers.id, moveIdentIds));
              }

              // Deduplicate memoryPeople: delete source rows where target already has the same memoryId+role
              const sourceMemLinks = await tx
                .select()
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, sourceId));
              const targetMemLinks = await tx
                .select()
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, targetId));
              const targetMemKeys = new Set(targetMemLinks.map((m) => `${m.memoryId}::${m.role}`));

              const dupeMemLinkIds = sourceMemLinks
                .filter((m) => targetMemKeys.has(`${m.memoryId}::${m.role}`))
                .map((m) => m.id);
              if (dupeMemLinkIds.length) {
                await tx.delete(memoryPeople).where(inArray(memoryPeople.id, dupeMemLinkIds));
              }

              // Move remaining source memoryPeople to target
              await tx
                .update(memoryPeople)
                .set({ personId: targetId })
                .where(eq(memoryPeople.personId, sourceId));

              // Move relationship edges before deleting the source person. Dedupe first because
              // source/target rewrites can collide with an existing target relationship.
              await tx.execute(sql`
                DELETE FROM person_relationships rel
                WHERE (
                  rel.source_person_id = ${sourceId}
                  AND (
                    rel.target_person_id = ${targetId}
                    OR EXISTS (
                      SELECT 1
                      FROM person_relationships existing
                      WHERE existing.source_person_id = ${targetId}
                        AND existing.target_person_id = rel.target_person_id
                        AND existing.relationship_type = rel.relationship_type
                        AND existing.connector_type IS NOT DISTINCT FROM rel.connector_type
                        AND existing.source_id = rel.source_id
                    )
                  )
                )
              `);
              await tx
                .update(personRelationships)
                .set({ sourcePersonId: targetId })
                .where(eq(personRelationships.sourcePersonId, sourceId));

              await tx.execute(sql`
                DELETE FROM person_relationships rel
                WHERE (
                  rel.target_person_id = ${sourceId}
                  AND (
                    rel.source_person_id = ${targetId}
                    OR EXISTS (
                      SELECT 1
                      FROM person_relationships existing
                      WHERE existing.target_person_id = ${targetId}
                        AND existing.source_person_id = rel.source_person_id
                        AND existing.relationship_type = rel.relationship_type
                        AND existing.connector_type IS NOT DISTINCT FROM rel.connector_type
                        AND existing.source_id = rel.source_id
                    )
                  )
                )
              `);
              await tx
                .update(personRelationships)
                .set({ targetPersonId: targetId })
                .where(eq(personRelationships.targetPersonId, sourceId));

              await tx
                .delete(personRelationships)
                .where(eq(personRelationships.sourcePersonId, personRelationships.targetPersonId));

              // Recompute target memory count after link moves
              const [{ count: newMemCount }] = await tx
                .select({ count: sql<number>`count(*)` })
                .from(memoryPeople)
                .where(eq(memoryPeople.personId, targetId));

              // Update target contact
              await tx
                .update(people)
                .set({
                  displayName,
                  displayNameHash,
                  avatars: this.encryptJsonb(targetAvatars),
                  memoryCount: newMemCount,
                  updatedAt: new Date(),
                })
                .where(eq(people.id, targetId));

              // Clean up dismissals referencing source
              await tx
                .delete(mergeDismissals)
                .where(
                  or(
                    eq(mergeDismissals.personId1, sourceId),
                    eq(mergeDismissals.personId2, sourceId),
                  )!,
                );

              // If the deleted source was pinned as the user's self identity, keep
              // that setting pointing at the surviving merged person.
              await tx
                .update(settings)
                .set({ value: targetId })
                .where(
                  and(
                    eq(settings.userId, target.userId ?? SYSTEM_SETTINGS_USER_ID),
                    inArray(settings.key, ['selfContactId', 'selfPersonId']),
                    eq(settings.value, sourceId),
                  ),
                );

              // Delete any remaining children (race condition: concurrent workers may have added new ones)
              await tx.delete(personIdentifiers).where(eq(personIdentifiers.personId, sourceId));
              await tx.delete(memoryPeople).where(eq(memoryPeople.personId, sourceId));

              // Delete source contact
              await tx.delete(people).where(eq(people.id, sourceId));
            }),
        );
        // Success — return
        return this.getById(targetId) as Promise<PersonWithIdentifiers>;
      } catch (err: unknown) {
        lastError = err;
        // Deadlock (40P01) or FK violation (23503) from concurrent inserts — retry
        if (
          ((err as { code?: string }).code === '40P01' ||
            (err as { code?: string }).code === '23503') &&
          attempt < 3
        ) {
          // Wait a small amount before retrying
          await new Promise((r) => setTimeout(r, Math.random() * 100 + 50 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async deletePerson(id: string): Promise<void> {
    await this.dbService.withCurrentUser(async (db) => {
      await db.delete(memoryPeople).where(eq(memoryPeople.personId, id));
      await db.delete(personIdentifiers).where(eq(personIdentifiers.personId, id));
      await db
        .delete(mergeDismissals)
        .where(or(eq(mergeDismissals.personId1, id), eq(mergeDismissals.personId2, id))!);
      await db.delete(people).where(eq(people.id, id));
    });
  }

  async getSuggestions(userId?: string): Promise<
    Array<{
      contact1: PersonWithIdentifiers;
      contact2: PersonWithIdentifiers;
      reason: string;
      confidence: number;
      positiveEvidence: string[];
      negativeEvidence: string[];
      sharedIdentifiers: string[];
      aliasSimilarity: number;
      cooccurrenceConflicts: string[];
      sourceConnectors: string[];
      sampleMemoryIds: string[];
    }>
  > {
    // Load contacts — filter by userId if provided, decrypt display names
    const rawContacts = await this.dbService.withCurrentUser((db) =>
      userId ? db.select().from(people).where(eq(people.userId, userId)) : db.select().from(people),
    );
    let allContacts = rawContacts
      .map((c) => ({
        ...c,
        displayName: this.crypto.decrypt(c.displayName) ?? c.displayName,
      }))
      .filter(
        (c) =>
          isMergeSuggestionEligibleEntity(c.entityType) &&
          !looksLikeGroupName(c.displayName) &&
          !looksLikeCombinedPersonName(c.displayName),
      );

    // Scope identifiers, dismissals, and memory links to this user's contacts
    const contactIds = allContacts.map((c) => c.id);
    if (contactIds.length === 0) return [];

    // Run all 3 queries in parallel
    const [allIdentifiers, allDismissals, allMemoryContacts] = await Promise.all([
      this.dbService.withCurrentUser((db) =>
        db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, contactIds)),
      ),
      this.dbService.withCurrentUser((db) =>
        db
          .select()
          .from(mergeDismissals)
          .where(
            or(
              inArray(mergeDismissals.personId1, contactIds),
              inArray(mergeDismissals.personId2, contactIds),
            )!,
          ),
      ),
      this.dbService.withCurrentUser((db) =>
        db.select().from(memoryPeople).where(inArray(memoryPeople.personId, contactIds)),
      ),
    ]);

    // Build identifiers map for quick lookup
    const contactIdentsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = contactIdentsMap.get(ident.personId) || [];
      list.push(ident);
      contactIdentsMap.set(ident.personId, list);
    }
    const hasDurableIdentifier = (personId: string): boolean =>
      (contactIdentsMap.get(personId) || []).some((ident) => ident.identifierType !== 'name');
    const sortMergeTargets = (a: (typeof allContacts)[0], b: (typeof allContacts)[0]): number => {
      const aIdentifiers = (contactIdentsMap.get(a.id) || []).filter(
        (ident) => ident.identifierType !== 'name',
      ).length;
      const bIdentifiers = (contactIdentsMap.get(b.id) || []).filter(
        (ident) => ident.identifierType !== 'name',
      ).length;
      if (aIdentifiers !== bIdentifiers) return bIdentifiers - aIdentifiers;
      const aAvatars = ((this.decryptJsonb(a.avatars) as unknown[]) || []).length;
      const bAvatars = ((this.decryptJsonb(b.avatars) as unknown[]) || []).length;
      if (aAvatars !== bAvatars) return bAvatars - aAvatars;
      const memoryDelta = (b.memoryCount ?? 0) - (a.memoryCount ?? 0);
      if (memoryDelta !== 0) return memoryDelta;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    };

    const contactById = new Map(allContacts.map((contact) => [contact.id, contact]));
    const byExactIdentifier = new Map<string, Set<string>>();
    for (const ident of allIdentifiers) {
      if (!contactById.has(ident.personId)) continue;
      const decryptedValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;
      if (!isExactIdentifierAutoMergeEligible(ident.identifierType, decryptedValue)) continue;
      const key = `${ident.identifierType}::${ident.identifierValueHash || ident.identifierValue}`;
      const ids = byExactIdentifier.get(key) ?? new Set<string>();
      ids.add(ident.personId);
      byExactIdentifier.set(key, ids);
    }

    const parent = new Map<string, string>();
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) {
        parent.set(id, id);
        return id;
      }
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (a: string, b: string) => {
      parent.set(find(b), find(a));
    };
    for (const ids of byExactIdentifier.values()) {
      const [first, ...rest] = [...ids];
      if (!first) continue;
      find(first);
      for (const id of rest) union(first, id);
    }

    const exactIdentifierComponents = new Map<string, string[]>();
    for (const id of contactById.keys()) {
      if (!parent.has(id)) continue;
      const root = find(id);
      const ids = exactIdentifierComponents.get(root) ?? [];
      ids.push(id);
      exactIdentifierComponents.set(root, ids);
    }

    const mergedAway = new Set<string>();
    for (const ids of exactIdentifierComponents.values()) {
      const active = ids
        .filter((id) => !mergedAway.has(id) && contactById.has(id))
        .map((id) => contactById.get(id)!)
        .sort(sortMergeTargets);
      if (active.length < 2) continue;
      const target = active[0];
      for (const source of active.slice(1)) {
        try {
          await this.mergePeople(target.id, source.id);
          mergedAway.add(source.id);
          contactById.delete(source.id);
        } catch (err) {
          this.logger.warn(
            `[getSuggestions] exact identifier auto-merge failed for ${source.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    if (mergedAway.size > 0) {
      allContacts = allContacts.filter((contact) => !mergedAway.has(contact.id));
    }

    const exactNameGroups = new Map<string, typeof allContacts>();
    for (const contact of allContacts) {
      if (!hasDurableIdentifier(contact.id)) continue;
      const key = exactDisplayNameAutoMergeKey(contact.displayName);
      if (!key) continue;
      const group = exactNameGroups.get(key) || [];
      group.push(contact);
      exactNameGroups.set(key, group);
    }

    for (const group of exactNameGroups.values()) {
      const active = group
        .filter((contact) => !mergedAway.has(contact.id) && contactById.has(contact.id))
        .sort(sortMergeTargets);
      if (active.length < 2) continue;
      const target = active[0];
      for (const source of active.slice(1)) {
        try {
          await this.mergePeople(target.id, source.id);
          mergedAway.add(source.id);
          contactById.delete(source.id);
        } catch (err) {
          this.logger.warn(
            `[getSuggestions] exact display name auto-merge failed for ${source.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    if (mergedAway.size > 0) {
      allContacts = allContacts.filter((contact) => !mergedAway.has(contact.id));
    }

    const activeContactIds = new Set(allContacts.map((contact) => contact.id));

    // Build contact -> connector types map
    const contactConnectors = new Map<string, Set<string>>();
    for (const ident of allIdentifiers) {
      if (!activeContactIds.has(ident.personId)) continue;
      if (ident.connectorType) {
        const set = contactConnectors.get(ident.personId) || new Set();
        set.add(ident.connectorType);
        contactConnectors.set(ident.personId, set);
      }
    }

    // Build dismissed pairs set (sorted id pair as key)
    const dismissedPairs = new Set<string>();
    for (const d of allDismissals) {
      const key = [d.personId1, d.personId2].sort().join('::');
      dismissedPairs.add(key);
    }

    // Build co-occurrence map: contacts that appear in the same memories
    const memoryToContacts = new Map<string, Set<string>>();
    for (const mc of allMemoryContacts) {
      if (!activeContactIds.has(mc.personId)) continue;
      const set = memoryToContacts.get(mc.memoryId) || new Set();
      set.add(mc.personId);
      memoryToContacts.set(mc.memoryId, set);
    }
    const coOccurrence = new Set<string>();
    for (const [, contactIds] of memoryToContacts) {
      if (contactIds.size < 2) continue;
      const ids = Array.from(contactIds);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          coOccurrence.add([ids[i], ids[j]].sort().join('::'));
        }
      }
    }

    const suggestedPairs = new Set<string>();
    const suggestions: Array<{
      contact1: PersonWithIdentifiers;
      contact2: PersonWithIdentifiers;
      reason: string;
      confidence: number;
      positiveEvidence: string[];
      negativeEvidence: string[];
      sharedIdentifiers: string[];
      aliasSimilarity: number;
      cooccurrenceConflicts: string[];
      sourceConnectors: string[];
      sampleMemoryIds: string[];
    }> = [];

    const addSuggestion = (
      c1: (typeof allContacts)[0],
      c2: (typeof allContacts)[0],
      reason: string,
      evidence: MergeEvidence,
    ) => {
      const pairKey = [c1.id, c2.id].sort().join('::');
      if (dismissedPairs.has(pairKey) || suggestedPairs.has(pairKey)) return;
      suggestedPairs.add(pairKey);

      const idents1 = contactIdentsMap.get(c1.id) || [];
      const idents2 = contactIdentsMap.get(c2.id) || [];
      const sourceConnectors = [
        ...new Set([
          ...(contactConnectors.get(c1.id) ?? new Set<string>()),
          ...(contactConnectors.get(c2.id) ?? new Set<string>()),
        ]),
      ];
      const sampleMemoryIds = [...memoryToContacts.entries()]
        .filter(([, ids]) => ids.has(c1.id) && ids.has(c2.id))
        .map(([memoryId]) => memoryId)
        .slice(0, 5);
      suggestions.push({
        contact1: {
          ...c1,
          avatars: this.decryptJsonb(c1.avatars),
          metadata: this.decryptJsonb(c1.metadata),
          identifiers: idents1.map((id) => ({
            id: id.id,
            identifierType: id.identifierType,
            identifierValue: this.crypto.decrypt(id.identifierValue) ?? id.identifierValue,
            connectorType: id.connectorType,
            confidence: id.confidence,
          })),
        },
        contact2: {
          ...c2,
          avatars: this.decryptJsonb(c2.avatars),
          metadata: this.decryptJsonb(c2.metadata),
          identifiers: idents2.map((id) => ({
            id: id.id,
            identifierType: id.identifierType,
            identifierValue: this.crypto.decrypt(id.identifierValue) ?? id.identifierValue,
            connectorType: id.connectorType,
            confidence: id.confidence,
          })),
        },
        reason,
        confidence: evidence.confidence,
        positiveEvidence: evidence.positiveEvidence,
        negativeEvidence: evidence.negativeEvidence,
        sharedIdentifiers: evidence.sharedIdentifiers,
        aliasSimilarity: evidence.aliasSimilarity,
        cooccurrenceConflicts: evidence.cooccurrenceConflicts,
        sourceConnectors,
        sampleMemoryIds,
      });
    };

    // GENERIC_NAMES is exported at module level

    // Helper: check if two contacts share a non-name identifier
    const shareNonNameIdentifier = (id1: string, id2: string): boolean => {
      const idents1 = contactIdentsMap.get(id1) || [];
      const idents2 = contactIdentsMap.get(id2) || [];
      for (const i1 of idents1) {
        if (i1.identifierType === 'name') continue;
        for (const i2 of idents2) {
          if (i2.identifierType === 'name') continue;
          if (
            i1.identifierType === i2.identifierType &&
            i1.identifierValueHash === i2.identifierValueHash
          )
            return true;
        }
      }
      return false;
    };

    // looksLikeIdentifier and isMultiWordName are exported module-level functions

    // Index contacts by exact name and normalized tokens to avoid O(n²) while
    // still catching "AMR ESSAM" inside "HALA AMR ESSAM" style aliases.
    const byToken = new Map<string, typeof allContacts>();
    for (const c of allContacts) {
      const name = c.displayName.toLowerCase().trim();
      if (name.length < 3 || GENERIC_NAMES.has(name)) continue;

      if (looksLikeIdentifierLabel(c.displayName)) continue;
      for (const token of new Set(normalizeNameForMerge(c.displayName))) {
        if (token.length < 3 || GENERIC_NAMES.has(token)) continue;
        const tokenList = byToken.get(token) || [];
        tokenList.push(c);
        byToken.set(token, tokenList);
      }
    }

    // --- Phase 2: Generate suggestions for remaining (ambiguous) pairs ---
    const comparePair = (c1: (typeof allContacts)[0], c2: (typeof allContacts)[0]) => {
      const pairKey = [c1.id, c2.id].sort().join('::');
      if (dismissedPairs.has(pairKey) || suggestedPairs.has(pairKey)) return;
      const exactNameKey1 = exactDisplayNameAutoMergeKey(c1.displayName);
      const exactNameKey2 = exactDisplayNameAutoMergeKey(c2.displayName);
      if (exactNameKey1 && exactNameKey1 === exactNameKey2) return;
      if (
        (looksLikeIdentifierLabel(c1.displayName) || looksLikeIdentifierLabel(c2.displayName)) &&
        !shareNonNameIdentifier(c1.id, c2.id)
      ) {
        return;
      }

      const nameA = c1.displayName.toLowerCase().trim();
      const nameB = c2.displayName.toLowerCase().trim();
      const connectors1 = contactConnectors.get(c1.id) || new Set();
      const connectors2 = contactConnectors.get(c2.id) || new Set();
      const sameConnector =
        connectors1.size === 1 &&
        connectors2.size === 1 &&
        [...connectors1][0] === [...connectors2][0];
      const isVisionConnector = sameConnector && [...connectors1][0] === 'photos';

      const evidence = scoreNameOnlyMerge(c1.displayName, c2.displayName);
      if (coOccurrence.has(pairKey)) {
        evidence.cooccurrenceConflicts.push('both people appear separately in the same memory');
        evidence.negativeEvidence.push('co-occurrence conflict');
        evidence.confidence = Math.max(0, evidence.confidence - 0.25);
      }
      if (shareNonNameIdentifier(c1.id, c2.id)) {
        evidence.confidence = Math.max(evidence.confidence, 0.95);
        evidence.positiveEvidence.push('shared strong identifier');
      }
      if (sameConnector && !isVisionConnector && !shareNonNameIdentifier(c1.id, c2.id)) {
        evidence.confidence = Math.max(0, evidence.confidence - 0.15);
        evidence.negativeEvidence.push('same non-vision connector without shared identifier');
      }
      if (connectors1.has('photos') && connectors2.has('photos')) {
        evidence.positiveEvidence.push('both appear in photos');
      }
      if (nameA === nameB || evidence.confidence >= 0.55) {
        addSuggestion(
          c1,
          c2,
          `Name similarity: "${c1.displayName}" and "${c2.displayName}"`,
          evidence,
        );
      }
    };

    // Compare contacts sharing at least one normalized token. Large common-name
    // buckets are allowed through the scorer only when another signal is strong.
    for (const [, group] of byToken) {
      if (group.length < 2 || group.length > 100) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          comparePair(group[i], group[j]);
        }
      }
    }

    return suggestions;
  }

  /**
   * Normalize all existing identifiers in the DB: trim, lowercase, reclassify,
   * then deduplicate and merge contacts that now share identifiers.
   */
  async normalizeAll(
    userId?: string,
  ): Promise<{ normalized: number; deduped: number; merged: number }> {
    const allIdents = await this.dbService.withCurrentUser((db) =>
      userId
        ? db
            .select({
              id: personIdentifiers.id,
              personId: personIdentifiers.personId,
              identifierType: personIdentifiers.identifierType,
              identifierValue: personIdentifiers.identifierValue,
              identifierValueHash: personIdentifiers.identifierValueHash,
              connectorType: personIdentifiers.connectorType,
              confidence: personIdentifiers.confidence,
              createdAt: personIdentifiers.createdAt,
            })
            .from(personIdentifiers)
            .innerJoin(people, eq(people.id, personIdentifiers.personId))
            .where(eq(people.userId, userId))
        : db.select().from(personIdentifiers),
    );

    let normalized = 0;
    let deduped = 0;
    let merged = 0;

    // Pass 1: Normalize values and reclassify types
    for (const ident of allIdents) {
      const decryptedValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;
      const norm = normalizeIdentifier({
        type: ident.identifierType,
        value: decryptedValue,
      });

      if (!norm) {
        // Empty after normalization — delete it
        await this.dbService.withCurrentUser((db) =>
          db.delete(personIdentifiers).where(eq(personIdentifiers.id, ident.id)),
        );
        deduped++;
        continue;
      }

      if (norm.type !== ident.identifierType || norm.value !== decryptedValue) {
        await this.dbService.withCurrentUser((db) =>
          db
            .update(personIdentifiers)
            .set({
              identifierType: norm.type,
              identifierValue: this.crypto.encrypt(norm.value)!,
              identifierValueHash: this.crypto.hmac(norm.value),
            })
            .where(eq(personIdentifiers.id, ident.id)),
        );
        normalized++;
      }
    }

    // Pass 2: Remove duplicate identifiers (same contact, same type+hash)
    const remaining = await this.dbService.withCurrentUser((db) =>
      userId
        ? db
            .select({
              id: personIdentifiers.id,
              personId: personIdentifiers.personId,
              identifierType: personIdentifiers.identifierType,
              identifierValue: personIdentifiers.identifierValue,
              identifierValueHash: personIdentifiers.identifierValueHash,
              connectorType: personIdentifiers.connectorType,
              confidence: personIdentifiers.confidence,
              createdAt: personIdentifiers.createdAt,
            })
            .from(personIdentifiers)
            .innerJoin(people, eq(people.id, personIdentifiers.personId))
            .where(eq(people.userId, userId))
        : db.select().from(personIdentifiers),
    );
    const seenPerContact = new Map<string, Set<string>>();
    for (const ident of remaining) {
      const contactSeen = seenPerContact.get(ident.personId) || new Set();
      const dedupKey = `${ident.identifierType}::${ident.identifierValueHash || ''}`;
      if (contactSeen.has(dedupKey)) {
        await this.dbService.withCurrentUser((db) =>
          db.delete(personIdentifiers).where(eq(personIdentifiers.id, ident.id)),
        );
        deduped++;
      } else {
        contactSeen.add(dedupKey);
        seenPerContact.set(ident.personId, contactSeen);
      }
    }

    // Pass 3: Merge contacts that now share non-name identifiers
    const afterDedup = await this.dbService.withCurrentUser((db) =>
      userId
        ? db
            .select({
              id: personIdentifiers.id,
              personId: personIdentifiers.personId,
              identifierType: personIdentifiers.identifierType,
              identifierValue: personIdentifiers.identifierValue,
              identifierValueHash: personIdentifiers.identifierValueHash,
              connectorType: personIdentifiers.connectorType,
              confidence: personIdentifiers.confidence,
              createdAt: personIdentifiers.createdAt,
            })
            .from(personIdentifiers)
            .innerJoin(people, eq(people.id, personIdentifiers.personId))
            .where(eq(people.userId, userId))
        : db.select().from(personIdentifiers),
    );
    const idsByPerson = new Map<
      string,
      Array<{ identifierType: string; identifierValue: string }>
    >();
    for (const ident of afterDedup) {
      const list = idsByPerson.get(ident.personId) || [];
      list.push({
        identifierType: ident.identifierType,
        identifierValue: this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue,
      });
      idsByPerson.set(ident.personId, list);
    }
    const peopleForMerge = await this.dbService.withCurrentUser((db) => {
      const ids = Array.from(idsByPerson.keys());
      if (ids.length === 0) return Promise.resolve([]);
      return db.select().from(people).where(inArray(people.id, ids));
    });
    const groupLikePersonIds = new Set(
      peopleForMerge
        .filter((person) => this.isGroupLikeContact(person, idsByPerson.get(person.id) || []))
        .map((person) => person.id),
    );

    // Build value → contactIds map (skip name identifiers) using HMAC hashes
    const valueToContacts = new Map<string, Set<string>>();
    for (const ident of afterDedup) {
      if (ident.identifierType === 'name') continue;
      if (groupLikePersonIds.has(ident.personId)) continue;
      const key = `${ident.identifierType}::${ident.identifierValueHash || ''}`;
      const set = valueToContacts.get(key) || new Set();
      set.add(ident.personId);
      valueToContacts.set(key, set);
    }

    // Merge groups where multiple contacts share an identifier
    const mergedInto = new Map<string, string>(); // sourceId → targetId
    for (const [, contactIds] of valueToContacts) {
      if (contactIds.size <= 1) continue;
      const ids = Array.from(contactIds).filter((id) => !mergedInto.has(id));
      if (ids.length <= 1) continue;

      // Resolve chains: find the ultimate target for each id
      const resolveTarget = (id: string): string => {
        while (mergedInto.has(id)) id = mergedInto.get(id)!;
        return id;
      };
      const targets = [...new Set(ids.map(resolveTarget))];
      if (targets.length <= 1) continue;

      const targetId = targets[0];
      for (const sourceId of targets.slice(1)) {
        await this.mergePeople(targetId, sourceId);
        mergedInto.set(sourceId, targetId);
        merged++;
      }
    }

    return { normalized, deduped, merged };
  }

  /**
   * Reclassify contacts whose entityType is 'person' by cross-referencing
   * entity data from their linked memories. If a contact's displayName
   * appears as a non-person entity type in linked memories, update
   * the contact's entityType to the most common non-person type found.
   */
  async reclassifyEntityTypes(userId?: string): Promise<{
    reclassified: number;
    details: Array<{ personId: string; displayName: string; oldType: string; newType: string }>;
  }> {
    const NON_PERSON_TYPES = [
      'organization',
      'product',
      'location',
      'event',
      'topic',
      'pet',
      'group',
      'device',
    ];

    // Get all person-typed contacts (including NULL/empty coalesced to person)
    const personContacts = await this.dbService.withCurrentUser((db) =>
      db
        .select()
        .from(people)
        .where(
          userId
            ? and(
                eq(people.userId, userId),
                sql`COALESCE(${people.entityType}, 'person') = 'person'`,
              )
            : sql`COALESCE(${people.entityType}, 'person') = 'person'`,
        ),
    );

    const details: Array<{
      personId: string;
      displayName: string;
      oldType: string;
      newType: string;
    }> = [];

    for (const contact of personContacts) {
      // Skip contacts whose displayName is a phone number, Slack ID, or too short
      const name = contact.displayName.trim();
      if (name.length < 2) continue;
      if (/^[+\d\s()-]+$/.test(name)) continue; // Phone numbers
      if (/^u[a-z0-9]{8,}$/i.test(name)) continue; // Slack user IDs

      // Get all memories linked to this contact
      const linkedMemories = await this.dbService.withCurrentUser((db) =>
        db
          .select({ entities: memories.entities })
          .from(memoryPeople)
          .innerJoin(memories, eq(memoryPeople.memoryId, memories.id))
          .where(eq(memoryPeople.personId, contact.id)),
      );

      // Count ALL entity type occurrences matching this contact's name
      const typeCounts = new Map<string, number>();
      const contactNameLower = contact.displayName.toLowerCase();

      for (const mem of linkedMemories) {
        let entitiesArr: Array<{ value: string; type: string }>;
        try {
          entitiesArr = JSON.parse(mem.entities || '[]');
        } catch {
          continue;
        }
        if (!Array.isArray(entitiesArr)) continue;

        for (const entity of entitiesArr) {
          if (!entity.value || !entity.type) continue;
          if (typeof entity.value !== 'string') continue;
          if (entity.value.toLowerCase() === contactNameLower) {
            typeCounts.set(entity.type, (typeCounts.get(entity.type) || 0) + 1);
          }
        }
      }

      // Only consider non-person types
      const nonPersonCounts = new Map<string, number>();
      for (const [type, count] of typeCounts) {
        if (NON_PERSON_TYPES.includes(type)) {
          nonPersonCounts.set(type, count);
        }
      }
      if (nonPersonCounts.size === 0) continue;

      // Find the most common non-person type
      let bestType = '';
      let bestCount = 0;
      for (const [type, count] of nonPersonCounts) {
        if (count > bestCount) {
          bestType = type;
          bestCount = count;
        }
      }

      // Only reclassify if overwhelmingly non-person:
      // - Zero person-type matches and at least 2 non-person matches, OR
      // - Non-person count >= 3x person count (very strong signal)
      const personCount = typeCounts.get('person') || 0;
      if (personCount === 0 && bestCount < 2) continue;
      if (personCount > 0 && bestCount < personCount * 3) continue;

      // Update the contact
      await this.dbService.withCurrentUser((db) =>
        db
          .update(people)
          .set({ entityType: bestType, updatedAt: new Date() })
          .where(eq(people.id, contact.id)),
      );

      details.push({
        personId: contact.id,
        displayName: contact.displayName,
        oldType: contact.entityType || 'person',
        newType: bestType,
      });
    }

    return { reclassified: details.length, details };
  }

  async removeIdentifier(personId: string, identifierId: string): Promise<PersonWithIdentifiers> {
    // Verify identifier exists and belongs to contact
    const idents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
    );

    if (!idents.length) throw new Error(`Contact ${personId} has no identifiers`);

    const target = idents.find((i) => i.id === identifierId);
    if (!target)
      throw new Error(`Identifier ${identifierId} does not belong to contact ${personId}`);

    // Prevent removing last identifier
    if (idents.length <= 1) throw new Error('Cannot remove the last identifier from a contact');

    // Delete the identifier
    await this.dbService.withCurrentUser((db) =>
      db.delete(personIdentifiers).where(eq(personIdentifiers.id, identifierId)),
    );

    // If removed identifier was name type matching displayName, update display name
    if (target.identifierType === 'name') {
      const contact = await this.dbService.withCurrentUser((db) =>
        db.select().from(people).where(eq(people.id, personId)),
      );
      const decryptedContactName = contact.length
        ? (this.crypto.decrypt(contact[0].displayName) ?? contact[0].displayName)
        : '';
      const decryptedTargetValue =
        this.crypto.decrypt(target.identifierValue) ?? target.identifierValue;
      if (contact.length && decryptedContactName === decryptedTargetValue) {
        const remaining = idents.filter((i) => i.id !== identifierId);
        const nextName = remaining.find((i) => i.identifierType === 'name');
        const decryptedNextName = nextName
          ? (this.crypto.decrypt(nextName.identifierValue) ?? nextName.identifierValue)
          : null;
        const decryptedRemainingFirst = remaining[0]
          ? (this.crypto.decrypt(remaining[0].identifierValue) ?? remaining[0].identifierValue)
          : 'Unknown';
        const newDisplayName = decryptedNextName || decryptedRemainingFirst;
        await this.dbService.withCurrentUser((db) =>
          db
            .update(people)
            .set({
              displayName: this.crypto.encrypt(newDisplayName)!,
              displayNameHash: this.crypto.hmac(newDisplayName.toLowerCase()),
              updatedAt: new Date(),
            })
            .where(eq(people.id, personId)),
        );
      }
    }

    return this.getById(personId) as Promise<PersonWithIdentifiers>;
  }

  async splitPerson(
    personId: string,
    identifierIds: string[],
    userId?: string,
  ): Promise<PersonWithIdentifiers> {
    // Validate source contact exists
    const sourceRows = await this.dbService.withCurrentUser((db) =>
      db.select().from(people).where(eq(people.id, personId)),
    );
    if (!sourceRows.length) throw new Error(`Contact ${personId} not found`);

    // Validate all identifierIds belong to this contact
    const allIdents = await this.dbService.withCurrentUser((db) =>
      db.select().from(personIdentifiers).where(eq(personIdentifiers.personId, personId)),
    );

    const toMove = allIdents.filter((i) => identifierIds.includes(i.id));
    if (toMove.length !== identifierIds.length) {
      throw new Error('Some identifier IDs do not belong to this contact');
    }

    // Prevent splitting ALL identifiers (source must keep at least one)
    if (toMove.length >= allIdents.length) {
      throw new Error('Cannot split all identifiers — source contact must keep at least one');
    }

    // Create new contact
    const newId = randomUUID();
    const now = new Date();
    const nameIdent = toMove.find((i) => i.identifierType === 'name');
    const decryptedName = nameIdent
      ? (this.crypto.decrypt(nameIdent.identifierValue) ?? nameIdent.identifierValue)
      : toMove[0]
        ? (this.crypto.decrypt(toMove[0].identifierValue) ?? toMove[0].identifierValue)
        : 'Unknown';

    await this.dbService.withCurrentUser((db) =>
      db.insert(people).values({
        id: newId,
        userId: userId ?? sourceRows[0].userId,
        displayName: this.crypto.encrypt(decryptedName)!,
        displayNameHash: this.crypto.hmac(decryptedName.toLowerCase()),
        entityType: sourceRows[0].entityType || 'person',
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Move selected identifiers to new contact
    await this.dbService.withCurrentUser((db) =>
      db
        .update(personIdentifiers)
        .set({ personId: newId })
        .where(inArray(personIdentifiers.id, identifierIds)),
    );

    return this.getById(newId) as Promise<PersonWithIdentifiers>;
  }

  /**
   * Legacy no-op kept for callers that still invoke the old endpoint path.
   * Person records must never be merged by display name alone; only durable
   * identifiers such as email, phone, or platform ids are acceptable evidence.
   */
  async deduplicateByExactName(displayName: string, userId?: string): Promise<string | undefined> {
    const trimmed = displayName.trim();
    if (!trimmed || looksLikeIdentifierLabel(trimmed) || looksLikeCombinedPersonName(trimmed)) {
      return undefined;
    }
    const conditions = [
      sql`${people.displayNameHash} = ${this.crypto.hmac(trimmed.toLowerCase())}`,
    ];
    if (userId) conditions.push(eq(people.userId, userId));
    const matches = await this.dbService.withCurrentUser((db) =>
      db
        .select({ id: people.id })
        .from(people)
        .where(and(...conditions)),
    );
    return matches[0]?.id;
  }

  /** Auto-merge duplicate people that share an exact normalized identifier. */
  async autoMerge(userId?: string): Promise<{
    merged: number;
    byRule: { nonPerson: number; sparseToRich: number; exactMultiWordName: number };
    details: Array<{ targetId: string; sourceId: string; targetName: string; rule: string }>;
  }> {
    const maxMs = Math.max(
      500,
      Math.min(Number(process.env.BOTMEM_AUTO_MERGE_MAX_MS ?? 15000), 25000),
    );
    const deadline = Date.now() + maxMs;
    const hasBudget = () => Date.now() < deadline;

    const allContacts = await this.dbService.withCurrentUser((db) =>
      userId ? db.select().from(people).where(eq(people.userId, userId)) : db.select().from(people),
    );
    const contactIds = allContacts.map((contact) => contact.id);
    const allIdentifiers = await this.dbService.withCurrentUser((db) =>
      contactIds.length
        ? db.select().from(personIdentifiers).where(inArray(personIdentifiers.personId, contactIds))
        : Promise.resolve([]),
    );
    const contactById = new Map(allContacts.map((contact) => [contact.id, contact]));
    const contactIdentsMap = new Map<string, typeof allIdentifiers>();
    for (const ident of allIdentifiers) {
      const list = contactIdentsMap.get(ident.personId) || [];
      list.push(ident);
      contactIdentsMap.set(ident.personId, list);
    }
    const hasDurableIdentifier = (personId: string): boolean =>
      (contactIdentsMap.get(personId) || []).some((ident) => ident.identifierType !== 'name');
    const decryptedDisplayName = (contact: (typeof allContacts)[0]): string =>
      this.crypto.decrypt(contact.displayName) ?? contact.displayName;
    const sortMergeTargets = (a: (typeof allContacts)[0], b: (typeof allContacts)[0]): number => {
      const aIdentifiers = (contactIdentsMap.get(a.id) || []).filter(
        (ident) => ident.identifierType !== 'name',
      ).length;
      const bIdentifiers = (contactIdentsMap.get(b.id) || []).filter(
        (ident) => ident.identifierType !== 'name',
      ).length;
      if (aIdentifiers !== bIdentifiers) return bIdentifiers - aIdentifiers;
      const aAvatars = ((this.decryptJsonb(a.avatars) as unknown[]) || []).length;
      const bAvatars = ((this.decryptJsonb(b.avatars) as unknown[]) || []).length;
      if (aAvatars !== bAvatars) return bAvatars - aAvatars;
      const memoryDelta = (b.memoryCount ?? 0) - (a.memoryCount ?? 0);
      if (memoryDelta !== 0) return memoryDelta;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    };

    const result = {
      merged: 0,
      byRule: { nonPerson: 0, sparseToRich: 0, exactMultiWordName: 0 },
      details: [] as Array<{
        targetId: string;
        sourceId: string;
        targetName: string;
        rule: string;
      }>,
    };

    const byStrongIdentifier = new Map<string, Set<string>>();
    for (const ident of allIdentifiers) {
      if (!hasBudget()) return result;
      const decryptedValue = this.crypto.decrypt(ident.identifierValue) ?? ident.identifierValue;
      if (!isExactIdentifierAutoMergeEligible(ident.identifierType, decryptedValue)) continue;
      const key = `${ident.identifierType}::${ident.identifierValueHash || ident.identifierValue}`;
      const ids = byStrongIdentifier.get(key) ?? new Set<string>();
      ids.add(ident.personId);
      byStrongIdentifier.set(key, ids);
    }

    const parent = new Map<string, string>();
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) {
        parent.set(id, id);
        return id;
      }
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const union = (a: string, b: string) => {
      parent.set(find(b), find(a));
    };
    for (const ids of byStrongIdentifier.values()) {
      const [first, ...rest] = [...ids];
      if (!first) continue;
      find(first);
      for (const id of rest) union(first, id);
    }

    const identifierComponents = new Map<string, string[]>();
    for (const id of contactById.keys()) {
      if (!parent.has(id)) continue;
      const root = find(id);
      const ids = identifierComponents.get(root) ?? [];
      ids.push(id);
      identifierComponents.set(root, ids);
    }

    const mergedAway = new Set<string>();
    for (const ids of identifierComponents.values()) {
      if (!hasBudget()) return result;
      const active = ids
        .filter((id) => !mergedAway.has(id) && contactById.has(id))
        .map((id) => contactById.get(id)!)
        .sort(sortMergeTargets);
      if (active.length < 2) continue;
      const target = active[0];
      for (const source of active.slice(1)) {
        if (!hasBudget()) return result;
        try {
          await this.mergePeople(target.id, source.id);
          mergedAway.add(source.id);
          contactById.delete(source.id);
          result.merged++;
          result.byRule.sparseToRich++;
          result.details.push({
            targetId: target.id,
            sourceId: source.id,
            targetName: decryptedDisplayName(target),
            rule: 'strongIdentifier',
          });
        } catch {
          // Concurrent merge or already merged — continue
        }
      }
    }

    const byExactName = new Map<string, typeof allContacts>();
    for (const contact of contactById.values()) {
      if (!hasBudget()) return result;
      if (mergedAway.has(contact.id) || contact.entityType !== 'person') continue;
      if (!hasDurableIdentifier(contact.id)) continue;
      const key = exactDisplayNameAutoMergeKey(decryptedDisplayName(contact));
      if (!key) continue;
      const group = byExactName.get(key) || [];
      group.push(contact);
      byExactName.set(key, group);
    }

    for (const group of byExactName.values()) {
      if (!hasBudget()) return result;
      const active = group
        .filter((contact) => !mergedAway.has(contact.id) && contactById.has(contact.id))
        .sort(sortMergeTargets);
      if (active.length < 2) continue;
      const target = active[0];
      for (const source of active.slice(1)) {
        if (!hasBudget()) return result;
        try {
          await this.mergePeople(target.id, source.id);
          mergedAway.add(source.id);
          contactById.delete(source.id);
          result.merged++;
          result.byRule.exactMultiWordName++;
          result.details.push({
            targetId: target.id,
            sourceId: source.id,
            targetName: decryptedDisplayName(target),
            rule: 'exactMultiWordName',
          });
        } catch {
          // Concurrent merge or already merged — continue
        }
      }
    }

    return result;
  }

  async dismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const [id1, id2] = [contactId1, contactId2].sort();
    try {
      await this.dbService.withCurrentUser((db) =>
        db.insert(mergeDismissals).values({
          id: randomUUID(),
          personId1: id1,
          personId2: id2,
          createdAt: new Date(),
        }),
      );
    } catch (err: unknown) {
      // Contact was already merged/deleted — dismissal is moot
      if ((err as { code?: string }).code === '23503') return;
      throw err;
    }
  }

  async undismissSuggestion(contactId1: string, contactId2: string): Promise<void> {
    const [id1, id2] = [contactId1, contactId2].sort();
    await this.dbService.withCurrentUser((db) =>
      db
        .delete(mergeDismissals)
        .where(and(eq(mergeDismissals.personId1, id1), eq(mergeDismissals.personId2, id2))),
    );
  }
}
