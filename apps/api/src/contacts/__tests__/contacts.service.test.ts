import { describe, it, expect } from 'vitest';
import { normalizePhone, normalizeIdentifier } from '../contacts.service';

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

// NOTE: Integration tests for ContactsService (resolveContact, mergeContacts, etc.)
// require a real PostgreSQL database via TEST_DATABASE_URL.
// These tests are deferred until integration test infrastructure is set up.
