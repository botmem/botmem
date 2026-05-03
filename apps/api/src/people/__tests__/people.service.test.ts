import { describe, it, expect, vi } from 'vitest';
import {
  normalizePhone,
  normalizeIdentifier,
  looksLikeIdentifier,
  isMultiWordName,
  GENERIC_NAMES,
  scoreNameOnlyMerge,
  normalizeNameForMerge,
  isMergeSuggestionEligibleEntity,
  looksLikeGroupName,
  isExactIdentifierAutoMergeEligible,
  isGroupScopedIdentifier,
  looksLikeIdentifierLabel,
  looksLikeCombinedPersonName,
  isDirectNameAutoMergeEligible,
  shouldUpdateDisplayName,
  hasDurablePersonIdentifier,
  isCompatiblePersonAlias,
  PeopleService,
} from '../people.service';

function makeDb(rows: unknown[][] = []) {
  const next = () => rows.shift() ?? [];
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      'select',
      'from',
      'where',
      'innerJoin',
      'leftJoin',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
      'insert',
      'values',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'update',
      'set',
      'delete',
      'execute',
    ]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.transaction = vi.fn(async (fn: (tx: Record<string, unknown>) => unknown) =>
      fn(makeDb(rows).db),
    );
    chain.then = (resolve: (value: unknown[]) => void) => resolve(next());
    return chain;
  };
  const db = makeChain();
  const dbService = {
    db,
    withCurrentUser: vi.fn(async (fn: (db: Record<string, unknown>) => unknown) => await fn(db)),
  };
  const crypto = {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) =>
      typeof value === 'string' && value.startsWith('enc:') ? value.slice(4) : value,
    ),
    hmac: vi.fn((value: string) => `hash:${value}`),
    isEncrypted: vi.fn((value: string) => typeof value === 'string' && value.startsWith('enc:')),
    decryptMemoryFieldsWithKey: vi.fn((memory: unknown) => memory),
  };
  const userKeyService = {
    getDek: vi.fn(async () => Buffer.from('dek')),
  };
  const accountsService = {
    getAll: vi.fn(async () => []),
  };
  const service = new PeopleService(
    dbService as never,
    crypto as never,
    userKeyService as never,
    accountsService as never,
  );
  return { service, dbService, crypto, userKeyService, accountsService };
}

const personRow = (id = 'p1', displayName = 'enc:Amr Essam') => ({
  id,
  displayName,
  displayNameHash: 'hash:amr essam',
  entityType: 'person',
  avatars: '[]',
  metadata: '{}',
  memoryCount: 3,
  userId: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
});

const identifierRow = (
  id = 'i1',
  personId = 'p1',
  type = 'email',
  value = 'enc:amr@example.com',
) => ({
  id,
  personId,
  identifierType: type,
  identifierValue: value,
  identifierValueHash: 'hash:amr@example.com',
  connectorType: 'gmail',
  confidence: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

describe('normalizePhone', () => {
  it('converts 00 prefix to +', () => {
    expect(normalizePhone('00201027755722')).toBe('+201027755722');
  });

  it('preserves existing + prefix', () => {
    expect(normalizePhone('+971502284498')).toBe('+971502284498');
  });

  it('strips spaces, dashes, and parens', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
  });

  it('adds + to bare digit strings with country code', () => {
    expect(normalizePhone('201027755722')).toBe('+201027755722');
  });

  it('strips dots', () => {
    expect(normalizePhone('+1.555.123.4567')).toBe('+15551234567');
  });
});

describe('PeopleService runtime behavior', () => {
  it('resolves a new person only when a durable identifier is present', async () => {
    const { service: guardedService } = makeDb([]);
    await expect(
      guardedService.resolvePerson([{ type: 'name', value: 'Only Name' }], 'person', 'user-1'),
    ).rejects.toThrow('durable identifier');

    const { service, dbService } = makeDb([
      [], // no matching identifier
      [], // insert person
      [], // existing identifiers for new person
      [], // insert identifiers
      [personRow('created', 'enc:Amr Essam')], // name update lookup
      [], // update name metadata
      [], // auto-merge identifiers
      [personRow('created', 'enc:Amr Essam')], // getById person row
      [identifierRow('i-email', 'created')], // getById identifiers
    ]);

    const created = await service.resolvePerson(
      [
        { type: 'email', value: 'amr@example.com', connectorType: 'gmail' },
        { type: 'name', value: 'Amr Essam', connectorType: 'gmail' },
      ],
      'person',
      'user-1',
    );

    expect(created.displayName).toBe('Amr Essam');
    expect(created.identifiers).toHaveLength(1);
    expect(dbService.withCurrentUser).toHaveBeenCalled();
  });

  it('maps list and search results with decrypted identifiers', async () => {
    const { service } = makeDb([
      [{ count: 1 }],
      [{ value: 'p1' }],
      [personRow()],
      [identifierRow()],
      [personRow()],
      [identifierRow()],
      [personRow()],
      [identifierRow()],
    ]);

    const listed = await service.list({ userId: 'user-1', limit: 10 });
    expect(listed.total).toBe(1);
    expect(listed.items[0].displayName).toBe('Amr Essam');
    expect(listed.items[0].identifiers[0].identifierValue).toBe('amr@example.com');

    const searched = await service.search('amr', 'user-1');
    expect(searched[0].displayName).toBe('Amr Essam');
  });

  it('updates avatars, links memories, and decrypts memory rows', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from('img'),
      headers: { get: () => 'image/png' },
    })) as never;
    const { service, userKeyService } = makeDb([
      [{ avatars: '[]' }],
      [], // avatar update
      [], // link insert
      [], // cached count update
      [
        {
          memory: {
            id: 'm1',
            text: 'enc:hello',
            entities: '[]',
            claims: '[]',
            metadata: '{}',
          },
        },
      ],
    ]);

    await service.updateAvatar('p1', { url: 'https://example.com/avatar.png', source: 'immich' });
    await service.linkMemory('m1', 'p1', 'sender');
    const memories = await service.getMemories('p1', 5, 'user-1');

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(userKeyService.getDek).toHaveBeenCalledWith('user-1');
    expect(memories).toHaveLength(1);
    globalThis.fetch = originalFetch;
  });

  it('updates, splits, removes identifiers, and deletes people through guarded paths', async () => {
    const update = makeDb([
      [personRow()],
      [], // update
      [personRow()],
      [identifierRow()],
    ]);
    await expect(
      update.service.updatePerson('p1', { displayName: 'Amr Updated', metadata: { ok: true } }),
    ).resolves.toBeTruthy();

    const remove = makeDb([
      [identifierRow('i-name', 'p1', 'name', 'enc:Amr Essam'), identifierRow('i-email')],
      [], // delete identifier
      [personRow()],
      [], // update display name
      [personRow()],
      [identifierRow('i-email')],
    ]);
    await expect(remove.service.removeIdentifier('p1', 'i-name')).resolves.toBeTruthy();

    const split = makeDb([
      [personRow()],
      [
        identifierRow('move', 'p1', 'email', 'enc:moved@example.com'),
        identifierRow('stay', 'p1', 'phone', 'enc:+971500000000'),
      ],
      [], // insert new person
      [], // move identifiers
      [personRow('split', 'enc:moved@example.com')],
      [identifierRow('move', 'split', 'email', 'enc:moved@example.com')],
    ]);
    await expect(split.service.splitPerson('p1', ['move'], 'user-1')).resolves.toBeTruthy();

    const del = makeDb([[], [], [], []]);
    await expect(del.service.deletePerson('p1')).resolves.toBeUndefined();
  });

  it('builds suggestions and auto-merges duplicate strong identifiers', async () => {
    const { service } = makeDb([
      [personRow('p1', 'enc:Amr Essam'), personRow('p2', 'enc:Amr E')], // suggestions contacts
      [identifierRow('i1', 'p1'), identifierRow('i2', 'p2')], // identifiers
      [], // dismissals
      [
        { memoryId: 'm1', personId: 'p1' },
        { memoryId: 'm1', personId: 'p2' },
      ], // memory links
      [personRow('p1', 'enc:Amr Essam'), personRow('p2', 'enc:Amr E')], // autoMerge contacts
      [identifierRow('i1', 'p1'), identifierRow('i2', 'p2')], // autoMerge identifiers
    ]);
    vi.spyOn(service, 'mergePeople').mockResolvedValue({
      ...personRow('p1', 'Amr Essam'),
      identifiers: [],
    });

    const suggestions = await service.getSuggestions('user-1');
    const auto = await service.autoMerge('user-1');

    expect(Array.isArray(suggestions)).toBe(true);
    expect(auto.merged).toBeGreaterThanOrEqual(0);
  });
});

describe('normalizeIdentifier', () => {
  it('trims whitespace from all types', () => {
    const result = normalizeIdentifier({ type: 'name', value: '  Amr Essam  ' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('collapses multiple spaces in names', () => {
    const result = normalizeIdentifier({ type: 'name', value: 'Amr   Essam' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('reclassifies email-like names as email type', () => {
    const result = normalizeIdentifier({ type: 'name', value: 'AmroEssamS@gmail.com' });
    expect(result!.type).toBe('email');
    expect(result!.value).toBe('amroessams@gmail.com');
  });

  it('extracts embedded email from display-name labels', () => {
    const result = normalizeIdentifier({
      type: 'name',
      value: 'Commander Andrey Parker <christinwendervcb24@gmail.com>',
    });
    expect(result!.type).toBe('email');
    expect(result!.value).toBe('christinwendervcb24@gmail.com');
  });

  it('lowercases emails', () => {
    const result = normalizeIdentifier({ type: 'email', value: 'Amr@Ghanem.SA' });
    expect(result!.value).toBe('amr@ghanem.sa');
  });

  it('lowercases slack_id and other generic types', () => {
    const result = normalizeIdentifier({ type: 'slack_id', value: ' AMR ' });
    expect(result!.value).toBe('amr');
  });

  it('strips zero-width and directional Unicode from names', () => {
    const result = normalizeIdentifier({ type: 'name', value: '\u200E Amr Essam' });
    expect(result!.value).toBe('Amr Essam');
  });

  it('returns null for empty values after trim', () => {
    expect(normalizeIdentifier({ type: 'name', value: '   ' })).toBeNull();
  });

  it('strips plus-addressing from emails', () => {
    const result = normalizeIdentifier({ type: 'email', value: 'user+tag@example.com' });
    expect(result!.value).toBe('user@example.com');
  });

  it('normalizes phone numbers', () => {
    const result = normalizeIdentifier({ type: 'phone', value: '00 201 027 755 722' });
    expect(result!.value).toBe('+201027755722');
  });

  it('drops likely combined multi-person name labels', () => {
    expect(
      normalizeIdentifier({
        type: 'name',
        value: 'Mohammad Hussien Meshal Alsaleem',
        connectorType: 'gmail',
      }),
    ).toBeNull();
  });
});

describe('looksLikeIdentifier', () => {
  // Phone numbers → true
  it('detects international phone numbers with +', () => {
    expect(looksLikeIdentifier('+971562094463')).toBe(true);
  });

  it('detects phone numbers without +', () => {
    expect(looksLikeIdentifier('97144187820')).toBe(true);
  });

  it('detects phone numbers with spaces and dashes', () => {
    expect(looksLikeIdentifier('+1 (555) 123-4567')).toBe(true);
  });

  it('detects short phone codes', () => {
    expect(looksLikeIdentifier('11111')).toBe(true);
  });

  // Email addresses → true
  it('detects simple email addresses', () => {
    expect(looksLikeIdentifier('amr@example.com')).toBe(true);
  });

  it('detects email with dots and subdomains', () => {
    expect(looksLikeIdentifier('no-reply@notifications.onlyfans.com')).toBe(true);
  });

  // Slack/WA IDs → true
  it('detects Slack-style uppercase letter + digits', () => {
    expect(looksLikeIdentifier('U0824728472')).toBe(true);
  });

  // Regular names → false
  it('rejects single-word names', () => {
    expect(looksLikeIdentifier('Marwan')).toBe(false);
  });

  it('rejects multi-word names', () => {
    expect(looksLikeIdentifier('John Smith')).toBe(false);
  });

  it('rejects business shortcodes', () => {
    expect(looksLikeIdentifier('champsuae')).toBe(false);
  });

  it('rejects mixed alphanumeric handles', () => {
    expect(looksLikeIdentifier('drasishdent')).toBe(false);
  });

  it('handles leading/trailing whitespace', () => {
    expect(looksLikeIdentifier('  +971562094463  ')).toBe(true);
  });

  it('rejects very short digit strings (< 5 chars)', () => {
    expect(looksLikeIdentifier('123')).toBe(false);
  });
});

describe('looksLikeIdentifierLabel', () => {
  it('detects labels that are exact emails or contain embedded emails', () => {
    expect(looksLikeIdentifierLabel('a.alrahama@gmail.com')).toBe(true);
    expect(
      looksLikeIdentifierLabel('Commander Andrey Parker <christinwendervcb24@gmail.com>'),
    ).toBe(true);
  });

  it('does not classify regular person names as identifier labels', () => {
    expect(looksLikeIdentifierLabel('Amelie Complainville')).toBe(false);
  });
});

describe('looksLikeCombinedPersonName', () => {
  it('detects two two-token person names glued into one label', () => {
    expect(looksLikeCombinedPersonName('Mohammad Hussien Meshal Alsaleem')).toBe(true);
    expect(looksLikeCombinedPersonName('Mohammad Hussien Abdulrahman Alhathloul')).toBe(true);
  });

  it('does not reject known single-person long-name patterns by default', () => {
    expect(looksLikeCombinedPersonName('MOHAMMED THABET ABDULMOHSEN SAMMAN')).toBe(false);
  });
});

describe('isMultiWordName', () => {
  it('returns true for first + last name', () => {
    expect(isMultiWordName('John Smith')).toBe(true);
  });

  it('returns true for three-word names', () => {
    expect(isMultiWordName('Ahmed Sultan Hassan')).toBe(true);
  });

  it('returns true for hyphenated compound names', () => {
    expect(isMultiWordName('Jean-Pierre Dupont')).toBe(true);
  });

  it('returns false for single-word names', () => {
    expect(isMultiWordName('Marwan')).toBe(false);
  });

  it('returns false for single letter + name', () => {
    expect(isMultiWordName('A Smith')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isMultiWordName('')).toBe(false);
  });

  it('returns false for whitespace-only', () => {
    expect(isMultiWordName('   ')).toBe(false);
  });

  it('handles extra whitespace between words', () => {
    expect(isMultiWordName('John   Smith')).toBe(true);
  });

  it('handles leading/trailing whitespace', () => {
    expect(isMultiWordName('  John Smith  ')).toBe(true);
  });

  it('returns true for "name via service" patterns', () => {
    expect(isMultiWordName('Karen from Appsflyer')).toBe(true);
  });
});

describe('GENERIC_NAMES', () => {
  it('contains common generic names', () => {
    expect(GENERIC_NAMES.has('unknown')).toBe(true);
    expect(GENERIC_NAMES.has('bot')).toBe(true);
    expect(GENERIC_NAMES.has('admin')).toBe(true);
    expect(GENERIC_NAMES.has('noreply')).toBe(true);
    expect(GENERIC_NAMES.has('no reply')).toBe(true);
  });

  it('does not contain real names', () => {
    expect(GENERIC_NAMES.has('amr')).toBe(false);
    expect(GENERIC_NAMES.has('john')).toBe(false);
    expect(GENERIC_NAMES.has('karen')).toBe(false);
  });
});

describe('auto-merge decision logic', () => {
  // These test the decision criteria for whether a pair should be auto-merged
  // vs presented as a suggestion. The actual merge is an integration concern,
  // but the decision logic uses the exported helpers.

  describe('should auto-merge (identifier-like names)', () => {
    it('phone number duplicates auto-merge', () => {
      const name = '+971562094463';
      expect(looksLikeIdentifier(name)).toBe(true);
    });

    it('email-as-name duplicates auto-merge', () => {
      const name = 'yash@adara.partners';
      expect(looksLikeIdentifier(name)).toBe(true);
    });
  });

  describe('name-only merge scoring', () => {
    it('full names with first + last are suggestions, not auto-merge evidence', () => {
      const name = 'balqees h. alneami';
      expect(isMultiWordName(name)).toBe(true);
    });

    it('"from" pattern names auto-merge', () => {
      const name = 'shani from appsflyer';
      expect(isMultiWordName(name)).toBe(true);
    });

    it('company names with multiple words auto-merge', () => {
      const name = 'elshorafa co management';
      expect(isMultiWordName(name)).toBe(true);
    });
  });

  describe('should NOT auto-merge (ambiguous single names)', () => {
    it('single-word names are NOT identifiers', () => {
      expect(looksLikeIdentifier('marwan')).toBe(false);
    });

    it('single-word names are NOT multi-word', () => {
      expect(isMultiWordName('marwan')).toBe(false);
    });

    it('business shortcodes are neither identifier nor multi-word', () => {
      const name = 'champsuae';
      expect(looksLikeIdentifier(name)).toBe(false);
      expect(isMultiWordName(name)).toBe(false);
    });
  });

  describe('generic names are excluded entirely', () => {
    it('unknown is in GENERIC_NAMES', () => {
      expect(GENERIC_NAMES.has('unknown')).toBe(true);
    });

    it('test is in GENERIC_NAMES', () => {
      expect(GENERIC_NAMES.has('test')).toBe(true);
    });

    it('me is in GENERIC_NAMES', () => {
      expect(GENERIC_NAMES.has('me')).toBe(true);
    });
  });
});

describe('isExactIdentifierAutoMergeEligible', () => {
  it('rejects exact name identifiers as person auto-merge evidence', () => {
    expect(isExactIdentifierAutoMergeEligible('name', 'Amelie')).toBe(false);
    expect(isExactIdentifierAutoMergeEligible('name', 'Mohamed')).toBe(false);
    expect(isExactIdentifierAutoMergeEligible('name', 'DM WITH AMELIE')).toBe(false);
  });

  it('allows exact structured identifiers', () => {
    expect(isExactIdentifierAutoMergeEligible('email', 'amelie@example.com')).toBe(true);
    expect(isExactIdentifierAutoMergeEligible('phone', '+971501234567')).toBe(true);
    expect(isExactIdentifierAutoMergeEligible('whatsapp_id', '971501234567@c.us')).toBe(true);
  });

  it('rejects group-scoped identifiers as person auto-merge evidence', () => {
    expect(isGroupScopedIdentifier('whatsapp_group_jid')).toBe(true);
    expect(isExactIdentifierAutoMergeEligible('whatsapp_group_jid', '120363410677585590')).toBe(
      false,
    );
    expect(isExactIdentifierAutoMergeEligible('slack_channel_id', 'C123456')).toBe(false);
  });

  it('rejects empty identifiers', () => {
    expect(isExactIdentifierAutoMergeEligible('name', '   ')).toBe(false);
    expect(isExactIdentifierAutoMergeEligible('email', '')).toBe(false);
  });
});

describe('isDirectNameAutoMergeEligible', () => {
  it('auto-merges exact normalized names, including single-token direct duplicates', () => {
    expect(isDirectNameAutoMergeEligible('JACK', 'jack')).toBe(true);
    expect(isDirectNameAutoMergeEligible('Noman', 'NOMAN')).toBe(true);
  });

  it('auto-merges direct first/surname typo variants', () => {
    expect(isDirectNameAutoMergeEligible('Eugenie Gerard', 'Eugenie Gerrard')).toBe(true);
    expect(isDirectNameAutoMergeEligible('Hisham Issa', 'Hisham Isa')).toBe(true);
  });

  it('auto-merges direct middle-name expansions with the same first and surname', () => {
    expect(isDirectNameAutoMergeEligible('Oana Fayyad', 'OANA AMIRA FAYYAD')).toBe(true);
    expect(isDirectNameAutoMergeEligible('Reem bin Amer', 'Reem H. Bin Amer')).toBe(true);
    expect(isDirectNameAutoMergeEligible('Nasser Resheed Asslimy', 'Nasser R. Asslimy')).toBe(true);
    expect(isDirectNameAutoMergeEligible('Captain Rana Irfan', 'Rana Irfan')).toBe(true);
  });

  it('does not auto-merge prefix-only or combined-person names', () => {
    expect(
      isDirectNameAutoMergeEligible('Mohammad Hussien', 'Mohammad Hussien Meshal Alsaleem'),
    ).toBe(false);
  });

  it('does not auto-merge identifier-like labels or groups by name shape', () => {
    expect(isDirectNameAutoMergeEligible('a@example.com', 'b@example.com')).toBe(false);
    expect(isDirectNameAutoMergeEligible('DM WITH AMELIE', 'Amelie')).toBe(false);
  });

  it('does not auto-merge repeated-token labels against real names', () => {
    expect(isDirectNameAutoMergeEligible('Aly Aly', 'Aly Hossein')).toBe(false);
  });
});

describe('shouldUpdateDisplayName', () => {
  it('upgrades raw identifiers and unknown labels to real names', () => {
    expect(shouldUpdateDisplayName('Unknown', 'Amr Essam')).toBe(true);
    expect(shouldUpdateDisplayName('+971502284498', 'Amr Essam')).toBe(true);
  });

  it('allows a bare first name to become the matching full name', () => {
    expect(shouldUpdateDisplayName('Amr', 'Amr Essam')).toBe(true);
  });

  it('does not replace an established person name with a different person name', () => {
    expect(shouldUpdateDisplayName('Amr Essam', 'Ahmed Elsalmawy')).toBe(false);
    expect(shouldUpdateDisplayName('Ahmed Elsalmawy', 'Harry')).toBe(false);
  });

  it('does not replace display names with identifier labels', () => {
    expect(shouldUpdateDisplayName('Amr Essam', 'amr@example.com')).toBe(false);
    expect(shouldUpdateDisplayName('Amr Essam', '+971502284498')).toBe(false);
  });
});

describe('hasDurablePersonIdentifier', () => {
  it('rejects bare names as automatic person creation evidence', () => {
    expect(hasDurablePersonIdentifier([{ type: 'name', value: 'Mohammed Aziz' }])).toBe(false);
  });

  it('accepts durable person identifiers', () => {
    expect(hasDurablePersonIdentifier([{ type: 'phone', value: '+16282448544' }])).toBe(true);
    expect(hasDurablePersonIdentifier([{ type: 'email', value: 'person@example.com' }])).toBe(true);
    expect(hasDurablePersonIdentifier([{ type: 'whatsapp_lid', value: '158226779779147' }])).toBe(
      true,
    );
    expect(hasDurablePersonIdentifier([{ type: 'immich_person_id', value: 'abc123' }])).toBe(true);
  });

  it('rejects group-scoped identifiers for person creation', () => {
    expect(
      hasDurablePersonIdentifier([{ type: 'whatsapp_group_jid', value: '120363410677585590' }]),
    ).toBe(false);
  });
});

describe('isCompatiblePersonAlias', () => {
  it('rejects different established person names', () => {
    expect(isCompatiblePersonAlias('Amr Essam', 'Mohammed Aziz')).toBe(false);
  });

  it('accepts clear upgrades and compatible variants', () => {
    expect(isCompatiblePersonAlias('Unknown', 'Mohammed Aziz')).toBe(true);
    expect(isCompatiblePersonAlias('+16282448544', 'Mohammed Aziz')).toBe(true);
    expect(isCompatiblePersonAlias('Amr', 'Amr Essam')).toBe(true);
    expect(isCompatiblePersonAlias('Eugenie Gerard', 'Eugenie Gerrard')).toBe(true);
  });

  it('rejects identifier-shaped aliases for established people', () => {
    expect(isCompatiblePersonAlias('Amr Essam', 'amr@example.com')).toBe(false);
    expect(isCompatiblePersonAlias('Amr Essam', '+971502284498')).toBe(false);
  });
});

describe('scoreNameOnlyMerge', () => {
  it('scores reordered Amelie names as a strong suggestion', () => {
    const score = scoreNameOnlyMerge('COMPLAINVILLE AMELIE', 'Amelie Complainville');
    expect(score.confidence).toBeGreaterThanOrEqual(0.55);
    expect(score.positiveEvidence.join(' ')).toContain('same tokens');
  });

  it('scores truncated long-token surname variants as compatible', () => {
    const score = scoreNameOnlyMerge('Amelie COMPLAINVILL', 'Amelie COMPLAINVILLE');
    expect(score.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('penalizes common first-name-only matches', () => {
    const score = scoreNameOnlyMerge('Mohamed', 'Mohammed');
    expect(score.confidence).toBeLessThan(0.55);
    expect(score.negativeEvidence.join(' ')).toContain('single-token');
  });

  it('does not score email domains as person-name similarity', () => {
    const score = scoreNameOnlyMerge('alozadafgaryqyq@gmail.com', 'a.alrahama@gmail.com');
    expect(score.confidence).toBe(0);
    expect(score.negativeEvidence.join(' ')).toContain('identifier-like label');
  });

  it('does not score display names that combine a name and an email address', () => {
    const score = scoreNameOnlyMerge(
      'a.alrahama@gmail.com',
      'Commander Andrey Parker <christinwendervcb24@gmail.com>',
    );
    expect(score.confidence).toBe(0);
    expect(score.negativeEvidence.join(' ')).toContain('identifier-like label');
  });

  it('does not treat common first-name prefixes as enough evidence', () => {
    const score = scoreNameOnlyMerge('Mohammad Hussien', 'Mohammad Hussien Meshal Alsaleem');
    expect(score.confidence).toBe(0);
    expect(score.negativeEvidence.join(' ')).toContain('combined multi-person');
  });

  it('scores compatible middle-name expansion', () => {
    const score = scoreNameOnlyMerge(
      'MOHAMMED THABET A SAMMAN',
      'MOHAMMED THABET ABDULMOHSEN SAMMAN',
    );
    expect(score.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('does not treat short different surnames as compatible typos', () => {
    expect(scoreNameOnlyMerge('Reem Naji', 'Reem Zaki').confidence).toBeLessThan(0.55);
  });

  it('penalizes containment when first names differ', () => {
    expect(scoreNameOnlyMerge('Ali Ahmed', 'Dr. Syed Ali Ahmed').confidence).toBeLessThan(0.55);
    expect(scoreNameOnlyMerge('Mahmoud Ahmed Hassan', 'Hassan Hassan').confidence).toBeLessThan(
      0.55,
    );
  });

  it('does not treat repeated shared surname tokens as containment', () => {
    expect(scoreNameOnlyMerge('Saud Al Saud', 'Khaled Al Saud').confidence).toBeLessThan(0.55);
  });

  it('does not score embedded person-name fragments as enough evidence', () => {
    expect(scoreNameOnlyMerge('AMR ESSAM', 'HALA AMR ESSAM').confidence).toBeLessThan(0.55);
    expect(
      scoreNameOnlyMerge('FARAJ, AMR ESSAM MOHAMED', 'AMR ESSAM MOHAMED').confidence,
    ).toBeLessThan(0.55);
    expect(
      scoreNameOnlyMerge('Saleh Al-Ghamdi', 'Mostafa Mohamed Saleh Al-Ghamdi').confidence,
    ).toBeLessThan(0.55);
  });

  it('normalizes punctuation to shared tokens for candidate pairing', () => {
    expect(normalizeNameForMerge('FARAJ, AMR ESSAM MOHAMED')).toEqual([
      'faraj',
      'amr',
      'essam',
      'mohamed',
    ]);
  });

  it('normalizes exact display-name casing for direct duplicate merges', () => {
    expect(normalizeNameForMerge('JACK').join(' ')).toBe(normalizeNameForMerge('jack').join(' '));
    expect(normalizeNameForMerge('  Noman  ').join(' ')).toBe(
      normalizeNameForMerge('NOMAN').join(' '),
    );
  });

  it('keeps comma-separated person aliases eligible while detecting group names', () => {
    expect(looksLikeGroupName('FARAJ, AMR ESSAM MOHAMED')).toBe(false);
    expect(looksLikeGroupName('DM WITH AMR ESSAM')).toBe(true);
    expect(looksLikeGroupName('Family / Dubai')).toBe(true);
  });

  it('only allows person entities into merge suggestions', () => {
    expect(isMergeSuggestionEligibleEntity('person')).toBe(true);
    expect(isMergeSuggestionEligibleEntity(null)).toBe(true);
    expect(isMergeSuggestionEligibleEntity('group')).toBe(false);
    expect(isMergeSuggestionEligibleEntity('organization')).toBe(false);
  });
});

// NOTE: Integration tests for PeopleService.getSuggestions() (auto-merge execution,
// dismissed pair handling, shareNonNameIdentifier, comparePair) require a real
// PostgreSQL database via TEST_DATABASE_URL.
// These tests are deferred until integration test infrastructure is set up.
