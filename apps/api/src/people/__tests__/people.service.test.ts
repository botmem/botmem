import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  normalizeIdentifier,
  looksLikeIdentifier,
  isMultiWordName,
  GENERIC_NAMES,
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

  describe('should auto-merge (multi-word names)', () => {
    it('full names with first + last auto-merge', () => {
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

// NOTE: Integration tests for PeopleService.getSuggestions() (auto-merge execution,
// dismissed pair handling, shareNonNameIdentifier, comparePair) require a real
// PostgreSQL database via TEST_DATABASE_URL.
// These tests are deferred until integration test infrastructure is set up.
