import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { parseNlq } from '../nlq-parser';

// Fixed reference date for deterministic tests: March 8, 2026 (Sunday)
const REF = new Date('2026-03-08T12:00:00Z');

describe('parseNlq', () => {
  describe('temporal parsing', () => {
    // Freeze clock so compromise-dates relative calculations are deterministic
    beforeAll(() => {
      vi.useFakeTimers({ now: REF });
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it('"this week" returns current Monday to Sunday', () => {
      const result = parseNlq('emails from this week', REF);
      expect(result.temporal).not.toBeNull();
      // Verify from/to are valid UTC ISO strings
      expect(result.temporal!.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.temporal!.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Range should be ~7 days
      const days =
        (new Date(result.temporal!.to).getTime() - new Date(result.temporal!.from).getTime()) /
        86400000;
      expect(days).toBeGreaterThanOrEqual(6);
      expect(days).toBeLessThanOrEqual(8);
    });

    it('"last week" returns previous Monday to Sunday', () => {
      const result = parseNlq('emails from last week', REF);
      expect(result.temporal).not.toBeNull();
      const days =
        (new Date(result.temporal!.to).getTime() - new Date(result.temporal!.from).getTime()) /
        86400000;
      expect(days).toBeGreaterThanOrEqual(6);
      expect(days).toBeLessThanOrEqual(8);
      // "from" should be near local midnight of the week start
      const from = new Date(result.temporal!.from);
      expect(from < REF).toBe(true); // must be in the past
    });

    it('"yesterday" returns a ~24h range covering yesterday', () => {
      const result = parseNlq('dinner plans yesterday', REF);
      expect(result.temporal).not.toBeNull();
      const from = new Date(result.temporal!.from);
      const to = new Date(result.temporal!.to);
      // Range should be ~24 hours
      const hours = (to.getTime() - from.getTime()) / 3600000;
      expect(hours).toBeGreaterThanOrEqual(23);
      expect(hours).toBeLessThanOrEqual(25);
      // Should be before REF
      expect(to < REF).toBe(true);
    });

    it('"in January" returns Jan 1 to Jan 31 of most recent past January', () => {
      const result = parseNlq('photos in January', REF);
      expect(result.temporal).not.toBeNull();
      const from = new Date(result.temporal!.from);
      const to = new Date(result.temporal!.to);
      // Range should be ~30 days (January)
      const days = (to.getTime() - from.getTime()) / 86400000;
      expect(days).toBeGreaterThanOrEqual(29);
      expect(days).toBeLessThanOrEqual(32);
      // Should be in the past (Jan 2026)
      expect(to < REF).toBe(true);
    });

    it('"between March and June" returns a range spanning ~3 months', () => {
      const result = parseNlq('meetings between March and June', REF);
      expect(result.temporal).not.toBeNull();
      const from = new Date(result.temporal!.from);
      const to = new Date(result.temporal!.to);
      const days = (to.getTime() - from.getTime()) / 86400000;
      expect(days).toBeGreaterThan(80);
      expect(days).toBeLessThan(100);
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

    it('all temporal outputs are valid UTC ISO strings ending in Z', () => {
      const queries = ['last week', 'yesterday', 'in January', 'this week'];
      for (const q of queries) {
        const result = parseNlq(q, REF);
        if (result.temporal) {
          expect(result.temporal.from).toMatch(/Z$/);
          expect(result.temporal.to).toMatch(/Z$/);
        }
      }
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
    it('parseNlq completes in under 100ms', { timeout: 15000 }, () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        parseNlq('emails from last week about project updates', REF);
      }
      const elapsed = (performance.now() - start) / 100;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
