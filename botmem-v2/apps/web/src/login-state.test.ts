import { describe, expect, it, vi } from 'vitest';
import {
  loadRememberedWorkspace,
  parseLoginFragment,
  rememberBrowserWorkspace,
  rememberWorkspace,
} from './login-state.js';

const WORKSPACE_ID = '8e5ffcc7-8e8f-4aaa-9c77-b87a979c60cf';
const TOKEN = 'bml_v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('login state', () => {
  it('keepsMagicCredentialsInTheFragmentAndRejectsMalformedValues', () => {
    expect(parseLoginFragment(`#loginToken=${TOKEN}&workspaceId=${WORKSPACE_ID}`)).toEqual({
      token: TOKEN,
      workspaceId: WORKSPACE_ID,
    });
    expect(parseLoginFragment('#loginToken=bad&workspaceId=bad')).toEqual({});
  });

  it('remembersOnlyValidatedWorkspaceIdsAndToleratesBlockedStorage', () => {
    const storage = { getItem: vi.fn().mockReturnValue(WORKSPACE_ID), setItem: vi.fn() };
    expect(loadRememberedWorkspace(storage)).toBe(WORKSPACE_ID);
    rememberWorkspace(storage, WORKSPACE_ID);
    expect(storage.setItem).toHaveBeenCalledWith('botmem.v2.workspace', WORKSPACE_ID);

    expect(
      loadRememberedWorkspace({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('');
  });

  it('does not block auth when browser storage access itself is denied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(() => rememberBrowserWorkspace(WORKSPACE_ID)).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
});
