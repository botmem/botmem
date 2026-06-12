import { describe, expect, it } from 'vitest';
import { JOBS_REMOVE_ON_COMPLETE } from '../jobs.module';

describe('JobsModule queue defaults', () => {
  it('bounds completed BullMQ job retention', () => {
    expect(JOBS_REMOVE_ON_COMPLETE).toEqual({ age: 86400, count: 1000 });
  });
});
