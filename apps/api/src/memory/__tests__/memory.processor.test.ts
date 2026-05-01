import { describe, expect, it } from 'vitest';
import { shouldMergeEntityResolutionBucket } from '../memory.processor';

describe('shouldMergeEntityResolutionBucket', () => {
  it('never fuses person entities before person resolution', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'person',
        'participant',
        {
          entityType: 'person',
          role: 'participant',
          identifiers: [
            { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
            { type: 'phone', value: '+971502284498', connectorType: 'whatsapp' },
          ],
        },
        [
          { type: 'name', value: 'Amr', connectorType: 'whatsapp' },
          { type: 'phone', value: '+971504024690', connectorType: 'whatsapp' },
        ],
      ),
    ).toBe(false);
  });

  it('uses typed identifier equality for non-person entity buckets', () => {
    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(true);

    expect(
      shouldMergeEntityResolutionBucket(
        'group',
        'group',
        {
          entityType: 'group',
          role: 'group',
          identifiers: [{ type: 'name', value: '120363', connectorType: 'whatsapp' }],
        },
        [{ type: 'whatsapp_group_jid', value: '120363', connectorType: 'whatsapp' }],
      ),
    ).toBe(false);
  });
});
