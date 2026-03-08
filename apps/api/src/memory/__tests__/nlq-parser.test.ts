import { describe, it, expect } from 'vitest';
import { parseNlq, type NlqParsed } from '../nlq-parser';

// Fixed reference date for deterministic tests: March 8, 2026 (Sunday)
const REF = new Date('2026-03-08T12:00:00Z');

describe('parseNlq', () => {
  describe('temporal parsing', () => {
    it('"last week" returns previous Monday to Sunday', () => {
      const result = parseNlq('emails from last week', REF);
      expect(result.temporal).not.toBeNull();
      // Last week relative to March 8 (Sun) = Feb 23 Mon - Mar 1 Sun
      expect(result.temporal!.from).toMatch(/2026-02-23/);
      expect(result.temporal!.to).toMatch(/2026-03-01/);
    });

    it('"yesterday" returns yesterday 00:00 to 23:59:59', () => {
      const result = parseNlq('dinner plans yesterday', REF);
      expect(result.temporal).not.toBeNull();
      expect(result.temporal!.from).toMatch(/2026-03-07T00:00/);
      expect(result.temporal!.to).toMatch(/2026-03-07T23:59:59/);
    });

    it('"in January" returns Jan 1 to Jan 31 of most recent past January', () => {
      const result = parseNlq('photos in January', REF);
      expect(result.temporal).not.toBeNull();
      expect(result.temporal!.from).toMatch(/2026-01-01/);
      expect(result.temporal!.to).toMatch(/2026-01-31/);
    });

    it('"between March and June" returns March 1 to June 30', () => {
      const result = parseNlq('meetings between March and June', REF);
      expect(result.temporal).not.toBeNull();
      expect(result.temporal!.from).toMatch(/03-01/);
      expect(result.temporal!.to).toMatch(/06-30/);
    });

    it('bare number "5 things" does NOT produce temporal filter', () => {
      const result = parseNlq('5 things', REF);
      expect(result.temporal).toBeNull();
    });

    it('ambiguous low-confidence parse is ignored', () => {
      const result = parseNlq('project alpha updates', REF);
      expect(result.temporal).toBeNull();
      expect(result.cleanQuery).toBe('project alpha updates');
    });
  });

  describe('intent classification', () => {
    it('"what did John say about the project" -> recall', () => {
      expect(parseNlq('what did John say about the project', REF).intent).toBe('recall');
    });

    it('"who said something about X" -> recall', () => {
      expect(parseNlq('who said something about X', REF).intent).toBe('recall');
    });

    it('"tell me about dinner" -> recall', () => {
      expect(parseNlq('tell me about dinner', REF).intent).toBe('recall');
    });

    it('"show me recent photos" -> browse', () => {
      expect(parseNlq('show me recent photos', REF).intent).toBe('browse');
    });

    it('"list all emails" -> browse', () => {
      expect(parseNlq('list all emails', REF).intent).toBe('browse');
    });

    it('"find Sarah\'s phone number" -> find', () => {
      expect(parseNlq("find Sarah's phone number", REF).intent).toBe('find');
    });

    it('"Sarah\'s email" -> find', () => {
      expect(parseNlq("Sarah's email", REF).intent).toBe('find');
    });

    it('"dinner plans" (no pattern match) -> recall (default)', () => {
      expect(parseNlq('dinner plans', REF).intent).toBe('recall');
    });
  });

  describe('source type detection', () => {
    it('"photos from last week" -> sourceTypeHint "photo"', () => {
      expect(parseNlq('photos from last week', REF).sourceTypeHint).toBe('photo');
    });

    it('"recent emails" -> sourceTypeHint "email"', () => {
      expect(parseNlq('recent emails', REF).sourceTypeHint).toBe('email');
    });

    it('"messages from John" -> sourceTypeHint "message"', () => {
      expect(parseNlq('messages from John', REF).sourceTypeHint).toBe('message');
    });

    it('no source hint for "dinner plans"', () => {
      expect(parseNlq('dinner plans', REF).sourceTypeHint).toBeNull();
    });
  });

  describe('clean query', () => {
    it('"emails from last week" strips temporal and dangling "from"', () => {
      const result = parseNlq('emails from last week', REF);
      expect(result.cleanQuery).toBe('emails');
    });

    it('"photos in January" strips temporal and dangling "in"', () => {
      const result = parseNlq('photos in January', REF);
      expect(result.cleanQuery).toBe('photos');
    });

    it('purely temporal "last week" falls back to original query', () => {
      const result = parseNlq('last week', REF);
      expect(result.cleanQuery).toBe('last week');
    });

    it('"dinner plans yesterday" strips "yesterday"', () => {
      const result = parseNlq('dinner plans yesterday', REF);
      expect(result.cleanQuery).toBe('dinner plans');
    });
  });

  describe('performance', () => {
    it('parseNlq completes in under 5ms', () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        parseNlq('emails from last week about project updates', REF);
      }
      const elapsed = (performance.now() - start) / 100;
      expect(elapsed).toBeLessThan(5);
    });
  });
});
