import { describe, expect, it } from 'vitest';
import { formatCompactNumber, formatIntegerNumber } from '../formatNumber';

describe('formatCompactNumber', () => {
  it('matches the dashboard compact number rules', () => {
    expect(formatCompactNumber(100)).toBe('100');
    expect(formatCompactNumber(9999)).toBe('9,999');
    expect(formatCompactNumber(10_000)).toBe('10.0k');
    expect(formatCompactNumber(11_525)).toBe('11.5k');
    expect(formatCompactNumber(100_000)).toBe('100k');
    expect(formatCompactNumber(1_000_000)).toBe('1.0M');
    expect(formatCompactNumber(123_000_000)).toBe('123M');
  });

  it('guards invalid or negative input for count displays', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('0');
    expect(formatCompactNumber(-10)).toBe('0');
  });

  it('accepts numeric strings from API count payloads', () => {
    expect(formatCompactNumber('44800')).toBe('44.8k');
    expect(formatIntegerNumber('215380')).toBe('215,380');
  });
});
