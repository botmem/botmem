import { describe, it, expect } from 'vitest';
import { createMockDbService } from '../../__tests__/helpers/db.helper';

describe('DbService (mock)', () => {
  it('creates a mock DbService with db property', () => {
    const dbService = createMockDbService();
    expect(dbService.db).toBeDefined();
  });

  it('healthCheck resolves to true', async () => {
    const dbService = createMockDbService();
    const result = await dbService.healthCheck();
    expect(result).toBe(true);
  });
});
