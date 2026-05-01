import { describe, it, expect } from 'vitest';
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
} from '../people.service';

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
  it('allows exact name identifiers, including single-token names', () => {
    expect(isExactIdentifierAutoMergeEligible('name', 'Amelie')).toBe(true);
    expect(isExactIdentifierAutoMergeEligible('name', 'Mohamed')).toBe(true);
    expect(isExactIdentifierAutoMergeEligible('name', 'DM WITH AMELIE')).toBe(true);
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

  it('rejects empty identifiers only', () => {
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
