import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { PeopleController } from '../people.controller';

describe('PeopleController', () => {
  it('returns 200 for read-only POST search', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PeopleController.prototype.search)).toBe(200);
  });
});
