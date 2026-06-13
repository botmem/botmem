import { describe, expect, it } from 'vitest';
import { axisLabel } from '../StreamGraph';

describe('axisLabel', () => {
  it('includes the year at the first bucket and year boundaries', () => {
    expect(axisLabel('2025-12-31')).toBe('12-31-2025');
    expect(axisLabel('2026-01-01', '2025-12-31')).toBe('01-01-2026');
    expect(axisLabel('2026-01-02', '2026-01-01')).toBe('01-02');
  });
});
