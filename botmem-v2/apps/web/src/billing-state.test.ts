import { describe, expect, it } from 'vitest';
import { loadBillingDraft, rememberBillingDraft } from './billing-state.js';

describe('billing draft storage', () => {
  it('never blocks Checkout or completion when browser storage is denied', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage;

    expect(() =>
      rememberBillingDraft(blocked, {
        email: 'owner@example.test',
        workspaceName: 'Memory',
      }),
    ).not.toThrow();
    expect(loadBillingDraft(blocked)).toBeNull();
  });
});
