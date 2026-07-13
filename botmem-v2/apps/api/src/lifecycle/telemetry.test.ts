import { describe, expect, it } from 'vitest';
import { lifecycleOperationalEvent } from './composition.js';

describe('lifecycle operational telemetry', () => {
  it('omits durable job identifiers and bounds arbitrary failure codes', () => {
    const event = lifecycleOperationalEvent('lifecycle_worker', {
      event: 'retry',
      jobId: '880a97f8-d069-4031-a26a-aa56baeb465e',
      kind: 'deletion',
      code: 'driver said user@example.test failed',
    });

    expect(event).toEqual({
      component: 'lifecycle_worker',
      event: 'retry',
      kind: 'deletion',
      code: 'UNEXPECTED_FAILURE',
    });
    expect(JSON.stringify(event)).not.toContain('880a97f8');
    expect(JSON.stringify(event)).not.toContain('example.test');
  });
});
