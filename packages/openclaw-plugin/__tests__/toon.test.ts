import { describe, it, expect, vi } from 'vitest';
import { toonify } from '../src/toon';

vi.mock('@toon-format/toon', () => ({
  encode: (data: unknown) => `TOON:${JSON.stringify(data)}`,
}));

describe('toonify', () => {
  it('encodes plain objects', () => {
    const result = toonify({ name: 'Alice', age: 30 });
    expect(result).toBe('TOON:{"name":"Alice","age":30}');
  });

  it('passes strings through as-is when not JSON', () => {
    const result = toonify({ text: 'hello world' });
    expect(result).toContain('hello world');
  });

  it('filters out null values from objects', () => {
    const result = toonify({ a: 1, b: null, c: 'ok' });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed).toEqual({ a: 1, c: 'ok' });
    expect(parsed).not.toHaveProperty('b');
  });

  it('filters out undefined values from objects', () => {
    const result = toonify({ a: 1, b: undefined });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed).toEqual({ a: 1 });
  });

  it('handles arrays', () => {
    const result = toonify([1, 2, 3]);
    expect(result).toBe('TOON:[1,2,3]');
  });

  it('handles null input', () => {
    const result = toonify(null);
    expect(result).toBe('TOON:null');
  });

  it('handles primitive values', () => {
    const result = toonify(42);
    expect(result).toBe('TOON:42');
  });
});

describe('parseJsonStringsDeep (via toonify)', () => {
  it('unwraps JSON strings in object values', () => {
    const result = toonify({ data: '{"nested":"value"}' });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.data).toEqual({ nested: 'value' });
  });

  it('unwraps deeply nested JSON strings', () => {
    const inner = JSON.stringify({ deep: true });
    const outer = JSON.stringify({ middle: inner });
    const result = toonify({ wrapper: outer });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.wrapper.middle).toEqual({ deep: true });
  });

  it('leaves non-JSON strings alone', () => {
    const result = toonify({ msg: 'just a string' });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.msg).toBe('just a string');
  });

  it('handles arrays with JSON strings', () => {
    const result = toonify(['{"a":1}', 'plain', '{"b":2}']);
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed).toEqual([{ a: 1 }, 'plain', { b: 2 }]);
  });

  it('filters nulls from nested objects', () => {
    const result = toonify({ outer: { inner: null, keep: 'yes' } });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.outer).toEqual({ keep: 'yes' });
  });

  it('does not parse JSON primitive strings as objects', () => {
    // JSON.parse("42") returns 42, but typeof 42 !== 'object', so original string kept
    const result = toonify({ val: '42' });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.val).toBe('42');
  });

  it('does not parse JSON string literals as objects', () => {
    // JSON.parse('"hello"') returns "hello", typeof string !== 'object'
    const result = toonify({ val: '"hello"' });
    const parsed = JSON.parse(result.replace('TOON:', ''));
    expect(parsed.val).toBe('"hello"');
  });
});
