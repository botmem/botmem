import { describe, expect, it } from 'vitest';
import {
  loadBillingDraft,
  loadBrowserBillingDraft,
  rememberBillingDraft,
  rememberBrowserBillingDraft,
} from './billing-state.js';

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

  it('guards access to the browser storage capability itself', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(() =>
        rememberBrowserBillingDraft({
          email: 'owner@example.test',
          workspaceName: 'Memory',
        }),
      ).not.toThrow();
      expect(loadBrowserBillingDraft()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
      else Reflect.deleteProperty(window, 'sessionStorage');
    }
  });
});
