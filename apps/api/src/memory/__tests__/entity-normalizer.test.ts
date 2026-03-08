import { describe, it, expect } from 'vitest';
import {
  normalizeEntities,
  CANONICAL_ENTITY_TYPES,
  NormalizedEntity,
} from '../entity-normalizer';

describe('normalizeEntities', () => {
  describe('type mapping', () => {
    it('maps greeting to other', () => {
      // Note: "Hello" is not in the garbage list, so it should survive
      expect(normalizeEntities([{ type: 'greeting', value: 'Hello World' }])).toEqual([
        { type: 'other', value: 'Hello World' },
      ]);
    });

    it('maps topic to concept', () => {
      expect(normalizeEntities([{ type: 'topic', value: 'AI' }])).toEqual([
        { type: 'concept', value: 'AI' },
      ]);
    });

    it('maps pet to other', () => {
      expect(normalizeEntities([{ type: 'pet', value: 'Rex' }])).toEqual([
        { type: 'other', value: 'Rex' },
      ]);
    });

    it('maps group to organization', () => {
      expect(normalizeEntities([{ type: 'group', value: 'Engineering' }])).toEqual([
        { type: 'organization', value: 'Engineering' },
      ]);
    });

    it('maps device to product', () => {
      expect(normalizeEntities([{ type: 'device', value: 'iPhone' }])).toEqual([
        { type: 'product', value: 'iPhone' },
      ]);
    });

    it('maps schedule to event', () => {
      expect(normalizeEntities([{ type: 'schedule', value: 'standup' }])).toEqual([
        { type: 'event', value: 'standup' },
      ]);
    });

    it('maps time to date', () => {
      expect(normalizeEntities([{ type: 'time', value: 'March 2024' }])).toEqual([
        { type: 'date', value: 'March 2024' },
      ]);
    });

    it('maps amount to quantity', () => {
      expect(normalizeEntities([{ type: 'amount', value: '$500' }])).toEqual([
        { type: 'quantity', value: '$500' },
      ]);
    });

    it('maps unknown types to other', () => {
      expect(normalizeEntities([{ type: 'foobar', value: 'Test' }])).toEqual([
        { type: 'other', value: 'Test' },
      ]);
    });
  });

  describe('canonical types pass through unchanged', () => {
    const canonicalTypes = [
      'person',
      'organization',
      'location',
      'date',
      'event',
      'product',
      'concept',
      'quantity',
      'language',
      'other',
    ] as const;

    for (const t of canonicalTypes) {
      it(`passes through ${t}`, () => {
        expect(normalizeEntities([{ type: t, value: 'TestValue' }])).toEqual([
          { type: t, value: 'TestValue' },
        ]);
      });
    }
  });

  describe('garbage filtering', () => {
    it('strips empty value', () => {
      expect(normalizeEntities([{ type: 'person', value: '' }])).toEqual([]);
    });

    it('strips single character value', () => {
      expect(normalizeEntities([{ type: 'person', value: 'I' }])).toEqual([]);
    });

    it('strips pronouns', () => {
      expect(normalizeEntities([{ type: 'person', value: 'you' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'person', value: 'He' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'person', value: 'them' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'person', value: 'my' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'person', value: 'Your' }])).toEqual([]);
    });

    it('strips generic terms', () => {
      expect(normalizeEntities([{ type: 'other', value: 'hello' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'other', value: 'Thanks' }])).toEqual([]);
      expect(normalizeEntities([{ type: 'other', value: 'YES' }])).toEqual([]);
    });

    it('strips URLs', () => {
      expect(
        normalizeEntities([{ type: 'other', value: 'https://example.com' }]),
      ).toEqual([]);
      expect(
        normalizeEntities([{ type: 'other', value: 'http://foo.bar/path' }]),
      ).toEqual([]);
    });

    it('strips whitespace-only values', () => {
      expect(normalizeEntities([{ type: 'person', value: '   ' }])).toEqual([]);
    });
  });

  describe('deduplication', () => {
    it('removes exact duplicates', () => {
      expect(
        normalizeEntities([
          { type: 'person', value: 'John' },
          { type: 'person', value: 'John' },
        ]),
      ).toEqual([{ type: 'person', value: 'John' }]);
    });

    it('deduplicates case-insensitively, keeping first occurrence', () => {
      expect(
        normalizeEntities([
          { type: 'person', value: 'John' },
          { type: 'person', value: 'john' },
        ]),
      ).toEqual([{ type: 'person', value: 'John' }]);
    });

    it('does not dedup different types with same value', () => {
      expect(
        normalizeEntities([
          { type: 'person', value: 'Apple' },
          { type: 'organization', value: 'Apple' },
        ]),
      ).toEqual([
        { type: 'person', value: 'Apple' },
        { type: 'organization', value: 'Apple' },
      ]);
    });
  });

  describe('entity cap', () => {
    it('caps at maxEntities (default 30)', () => {
      const entities = Array.from({ length: 50 }, (_, i) => ({
        type: 'person',
        value: `Name${i}`,
      }));
      expect(normalizeEntities(entities)).toHaveLength(30);
    });

    it('respects custom maxEntities', () => {
      const entities = Array.from({ length: 10 }, (_, i) => ({
        type: 'person',
        value: `Name${i}`,
      }));
      expect(normalizeEntities(entities, 5)).toHaveLength(5);
    });
  });

  describe('embed-shape input (type, id, role)', () => {
    it('extracts value from compound id format name:X|email:Y', () => {
      const result = normalizeEntities([
        { type: 'person', id: 'name:John Smith|email:john@x.com', role: 'sender' },
      ]);
      expect(result).toEqual([{ type: 'person', value: 'John Smith' }]);
    });

    it('uses id as-is when no compound format', () => {
      const result = normalizeEntities([
        { type: 'person', id: 'simple-id', role: 'sender' },
      ]);
      expect(result).toEqual([{ type: 'person', value: 'simple-id' }]);
    });

    it('prefers value over id when both present', () => {
      const result = normalizeEntities([
        { type: 'person', value: 'Jane', id: 'name:Other|email:other@x.com', role: 'sender' },
      ]);
      expect(result).toEqual([{ type: 'person', value: 'Jane' }]);
    });
  });

  describe('CANONICAL_ENTITY_TYPES', () => {
    it('contains exactly 10 types', () => {
      expect(CANONICAL_ENTITY_TYPES).toHaveLength(10);
    });

    it('includes all expected types', () => {
      expect(CANONICAL_ENTITY_TYPES).toContain('person');
      expect(CANONICAL_ENTITY_TYPES).toContain('organization');
      expect(CANONICAL_ENTITY_TYPES).toContain('location');
      expect(CANONICAL_ENTITY_TYPES).toContain('date');
      expect(CANONICAL_ENTITY_TYPES).toContain('event');
      expect(CANONICAL_ENTITY_TYPES).toContain('product');
      expect(CANONICAL_ENTITY_TYPES).toContain('concept');
      expect(CANONICAL_ENTITY_TYPES).toContain('quantity');
      expect(CANONICAL_ENTITY_TYPES).toContain('language');
      expect(CANONICAL_ENTITY_TYPES).toContain('other');
    });
  });
});
