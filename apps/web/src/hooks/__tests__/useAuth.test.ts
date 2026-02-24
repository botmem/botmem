import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuth } from '../useAuth';

describe('useAuth', () => {
  it('returns auth store', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current).toBeDefined();
    expect(typeof result.current.login).toBe('function');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.signup).toBe('function');
  });
});
