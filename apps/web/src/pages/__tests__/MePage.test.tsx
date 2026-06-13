import { describe, expect, it } from 'vitest';
import { formatMemoryStatDate } from '../MePage';

describe('formatMemoryStatDate', () => {
  it('hides missing, invalid, and epoch-ish dates', () => {
    expect(formatMemoryStatDate(null)).toBeNull();
    expect(formatMemoryStatDate('not-a-date')).toBeNull();
    expect(formatMemoryStatDate('1970-01-01T00:00:00.000Z')).toBeNull();
  });

  it('formats plausible memory dates', () => {
    expect(formatMemoryStatDate('2026-03-04T12:00:00.000Z')).toBe('Mar 4, 2026');
  });
});
