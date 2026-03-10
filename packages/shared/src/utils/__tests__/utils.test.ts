import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cn, formatTime, formatDate, formatRelative, truncate, CONNECTOR_COLORS } from '../index.js';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    const condition = false;
    expect(cn('base', condition && 'hidden', 'active')).toBe('base active');
  });

  it('merges tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('handles empty inputs', () => {
    expect(cn()).toBe('');
  });

  it('handles undefined/null', () => {
    expect(cn('a', undefined, null, 'b')).toBe('a b');
  });
});

describe('formatTime', () => {
  it('formats ISO to HH:MM:SS', () => {
    const result = formatTime('2026-02-23T14:30:45Z');
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('returns valid time string', () => {
    const result = formatTime('2026-01-01T00:00:00Z');
    expect(result).toBeTruthy();
  });
});

describe('formatDate', () => {
  it('formats ISO to readable date', () => {
    const result = formatDate('2026-02-23T14:30:45Z');
    expect(result).toContain('2026');
  });

  it('includes month and day', () => {
    const result = formatDate('2026-06-15T00:00:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('15');
  });
});

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for < 1 min', () => {
    expect(formatRelative('2026-02-23T11:59:30Z')).toBe('just now');
  });

  it('returns minutes ago', () => {
    expect(formatRelative('2026-02-23T11:55:00Z')).toBe('5m ago');
  });

  it('returns hours ago', () => {
    expect(formatRelative('2026-02-23T09:00:00Z')).toBe('3h ago');
  });

  it('returns days ago', () => {
    expect(formatRelative('2026-02-21T12:00:00Z')).toBe('2d ago');
  });

  it('handles edge case at exactly 1 min', () => {
    expect(formatRelative('2026-02-23T11:59:00Z')).toBe('1m ago');
  });

  it('handles edge case at exactly 60 min', () => {
    expect(formatRelative('2026-02-23T11:00:00Z')).toBe('1h ago');
  });

  it('handles edge case at exactly 24 hours', () => {
    expect(formatRelative('2026-02-22T12:00:00Z')).toBe('1d ago');
  });
});

describe('truncate', () => {
  it('returns string unchanged if shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('returns string unchanged if equal to limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('CONNECTOR_COLORS', () => {
  it('has gmail color', () => {
    expect(CONNECTOR_COLORS.gmail).toBe('#FF6B9D');
  });

  it('has whatsapp color', () => {
    expect(CONNECTOR_COLORS.whatsapp).toBe('#22C55E');
  });

  it('has slack color', () => {
    expect(CONNECTOR_COLORS.slack).toBe('#A855F7');
  });

  it('has imessage color', () => {
    expect(CONNECTOR_COLORS.imessage).toBe('#4ECDC4');
  });

  it('has photos color', () => {
    expect(CONNECTOR_COLORS.photos).toBe('#FFE66D');
  });

  it('has all color entries', () => {
    expect(Object.keys(CONNECTOR_COLORS)).toHaveLength(12);
  });
});
