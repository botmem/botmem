import { describe, it, expect } from 'vitest';
import {
  generateContacts,
  generateMemories,
  generateHeroMemories,
  DEMO_SEARCH_EXAMPLES,
  scanForPII,
  randomVector,
} from '../fake-data';

describe('fake-data', () => {
  const contacts = generateContacts(12);

  describe('generateContacts', () => {
    it('generates the requested number of contacts', () => {
      expect(contacts).toHaveLength(12);
    });

    it('all contacts have unique display names', () => {
      const names = contacts.map((c) => c.displayName);
      expect(new Set(names).size).toBe(names.length);
    });

    it('contacts have valid entity types', () => {
      for (const c of contacts) {
        expect(['person', 'group', 'organization']).toContain(c.entityType);
      }
    });

    it('contacts have at least one identifier', () => {
      for (const c of contacts) {
        expect(c.identifiers.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('contacts have UUIDs as ids', () => {
      for (const c of contacts) {
        expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  });

  describe('generateHeroMemories', () => {
    const heroes = generateHeroMemories(contacts);

    it('generates exactly 5 hero memories', () => {
      expect(heroes).toHaveLength(5);
    });

    it('covers all 5 connector types', () => {
      const types = new Set(heroes.map((h) => h.connectorType));
      expect(types).toContain('gmail');
      expect(types).toContain('slack');
      expect(types).toContain('whatsapp');
      expect(types).toContain('imessage');
      expect(types).toContain('photos-immich');
    });

    it('hero memories have deterministic, known searchable content', () => {
      const gmailHero = heroes.find((h) => h.connectorType === 'gmail');
      expect(gmailHero?.text).toContain('GITEX');
      expect(gmailHero?.text).toContain('Budget Review');

      const slackHero = heroes.find((h) => h.connectorType === 'slack');
      expect(slackHero?.text).toContain('deployed');
      expect(slackHero?.text).toContain('production');

      const waHero = heroes.find((h) => h.connectorType === 'whatsapp');
      expect(waHero?.text).toContain('Zuma');
      expect(waHero?.text).toContain('Friday');

      const imsgHero = heroes.find((h) => h.connectorType === 'imessage');
      expect(imsgHero?.text).toContain('Mediclinic');
      expect(imsgHero?.text).toContain('appointment');

      const photoHero = heroes.find((h) => h.connectorType === 'photos-immich');
      expect(photoHero?.text).toContain('Burj Khalifa');
      expect(photoHero?.text).toContain('Group photo');
    });

    it('each hero has valid FakeMemory shape', () => {
      for (const hero of heroes) {
        expect(hero.id).toBeTruthy();
        expect(hero.text).toBeTruthy();
        expect(hero.sourceType).toBeTruthy();
        expect(hero.sourceId).toBeTruthy();
        expect(hero.eventTime).toBeInstanceOf(Date);
        expect(hero.entities).toBeInstanceOf(Array);
        expect(hero.claims).toBeInstanceOf(Array);
        expect(hero.factuality).toHaveProperty('label');
        expect(hero.weights).toHaveProperty('importance');
      }
    });
  });

  describe('DEMO_SEARCH_EXAMPLES', () => {
    it('has 5 search examples', () => {
      expect(DEMO_SEARCH_EXAMPLES).toHaveLength(5);
    });

    it('each example matches a hero memory text', () => {
      const heroes = generateHeroMemories(contacts);
      for (const example of DEMO_SEARCH_EXAMPLES) {
        const hero = heroes.find((h) => h.connectorType === example.connectorType);
        expect(hero).toBeDefined();
        // At least one keyword from the query should appear in the hero text
        const keywords = example.query.split(' ');
        const matchesAny = keywords.some((kw) =>
          hero!.text.toLowerCase().includes(kw.toLowerCase()),
        );
        expect(matchesAny).toBe(true);
      }
    });

    it('each example has query, description, and connectorType', () => {
      for (const ex of DEMO_SEARCH_EXAMPLES) {
        expect(ex.query).toBeTruthy();
        expect(ex.description).toBeTruthy();
        expect(ex.connectorType).toBeTruthy();
      }
    });
  });

  describe('generateMemories', () => {
    const memories = generateMemories(contacts, {
      gmail: 8,
      slack: 6,
      whatsapp: 6,
      imessage: 5,
      photos: 5,
    });

    it('generates the expected total count (30)', () => {
      expect(memories).toHaveLength(30);
    });

    it('includes hero memories as the first entries', () => {
      // Heroes should be in the memories list
      const gmailMemories = memories.filter((m) => m.connectorType === 'gmail');
      const hasGitexHero = gmailMemories.some((m) => m.text.includes('GITEX'));
      expect(hasGitexHero).toBe(true);
    });

    it('all memories have valid shape', () => {
      for (const mem of memories) {
        expect(mem.id).toBeTruthy();
        expect(mem.connectorType).toBeTruthy();
        expect(mem.sourceType).toBeTruthy();
        expect(mem.text).toBeTruthy();
        expect(mem.eventTime).toBeInstanceOf(Date);
      }
    });

    it('respects per-connector counts', () => {
      const counts: Record<string, number> = {};
      for (const m of memories) {
        counts[m.connectorType] = (counts[m.connectorType] || 0) + 1;
      }
      expect(counts['gmail']).toBe(8);
      expect(counts['slack']).toBe(6);
      expect(counts['whatsapp']).toBe(6);
      expect(counts['imessage']).toBe(5);
      expect(counts['photos-immich']).toBe(5);
    });
  });

  describe('scanForPII', () => {
    it('flags real email domains', () => {
      const result = scanForPII(['test@gmail.com']);
      expect(result.clean).toBe(false);
      expect(result.flagged.length).toBeGreaterThan(0);
    });

    it('flags known names', () => {
      const result = scanForPII(['Hello Amr Essam']);
      expect(result.clean).toBe(false);
    });

    it('passes clean on fake data', () => {
      const memories = generateMemories(contacts, {
        gmail: 8,
        slack: 6,
        whatsapp: 6,
        imessage: 5,
        photos: 5,
      });
      const result = scanForPII(memories.map((m) => m.text));
      expect(result.clean).toBe(true);
    });
  });

  describe('randomVector', () => {
    it('generates a vector of requested dimensions', () => {
      const vec = randomVector(1024);
      expect(vec).toHaveLength(1024);
    });

    it('generates a normalized vector (magnitude ~1)', () => {
      const vec = randomVector(768);
      const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 3);
    });
  });
});
