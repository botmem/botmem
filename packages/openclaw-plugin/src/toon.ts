/**
 * Toon encoding helper for LLM-optimized output.
 * Copied from packages/cli/src/format.ts — 40-60% token savings vs JSON.
 */

import { encode } from '@toon-format/toon';

export function toonify(data: unknown): string {
  const cleaned = parseJsonStringsDeep(data);
  return encode(cleaned);
}

function parseJsonStringsDeep(val: unknown): unknown {
  if (val == null) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parseJsonStringsDeep(parsed);
    } catch {
      /* not JSON */
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(parseJsonStringsDeep);
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v != null) out[k] = parseJsonStringsDeep(v);
    }
    return out;
  }
  return val;
}
