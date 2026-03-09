import { describe, it, expect } from 'vitest';

/**
 * Tests for computeWeights scoring logic with pinning and recall boost.
 *
 * We test the pure scoring function by extracting its logic.
 * The function signature: computeWeights(semanticScore, rerankScore, mem) =>
 *   { score, weights: { semantic, rerank, recency, importance, trust, final } }
 */

// Replicate the scoring logic as a pure function for unit testing
function computeWeights(
  semanticScore: number,
  rerankScore: number,
  mem: {
    eventTime: string | Date;
    entities: string;
    connectorType: string;
    pinned?: boolean;
    recallCount?: number;
  },
  getTrustScore: (ct: string) => number = () => 0.7,
): {
  score: number;
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
} {
  const isPinned = mem.pinned === true;
  const recallCount = mem.recallCount || 0;

  const eventDate = mem.eventTime instanceof Date ? mem.eventTime : new Date(mem.eventTime);
  const ageDays = (Date.now() - eventDate.getTime()) / (1000 * 60 * 60 * 24);
  const recency = isPinned ? 1.0 : Math.exp(-0.015 * ageDays);

  let entityCount = 0;
  try {
    entityCount = JSON.parse(mem.entities).length;
  } catch {
    /* empty */
  }
  const baseImportance = 0.5 + Math.min(entityCount * 0.1, 0.4);
  const importance = baseImportance + Math.min(recallCount * 0.02, 0.2);
  const trust = getTrustScore(mem.connectorType);

  let final =
    rerankScore > 0
      ? 0.4 * semanticScore + 0.3 * rerankScore + 0.15 * recency + 0.1 * importance + 0.05 * trust
      : 0.7 * semanticScore + 0.15 * recency + 0.1 * importance + 0.05 * trust;

  if (isPinned) final = Math.max(final, 0.75);

  return {
    score: final,
    weights: { semantic: semanticScore, rerank: rerankScore, recency, importance, trust, final },
  };
}

describe('computeWeights with pinning and recall', () => {
  const baseMem = {
    eventTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days old
    entities: '[]',
    connectorType: 'gmail',
    pinned: false,
    recallCount: 0,
  };

  it('Test 1: pinned=true returns score >= 0.75 (score floor)', () => {
    const result = computeWeights(0.3, 0, { ...baseMem, pinned: true });
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.weights.final).toBeGreaterThanOrEqual(0.75);
  });

  it('Test 2: pinned=true uses recency=1.0 regardless of age', () => {
    const result = computeWeights(0.5, 0, { ...baseMem, pinned: true });
    expect(result.weights.recency).toBe(1.0);
  });

  it('Test 3: recallCount=5 boosts importance by 0.10 (5 * 0.02)', () => {
    const withRecall = computeWeights(0.5, 0, { ...baseMem, recallCount: 5 });
    const without = computeWeights(0.5, 0, { ...baseMem, recallCount: 0 });
    const importanceDiff = withRecall.weights.importance - without.weights.importance;
    expect(importanceDiff).toBeCloseTo(0.1, 5);
  });

  it('Test 4: recallCount=15 caps importance boost at 0.20 (not 0.30)', () => {
    const withRecall = computeWeights(0.5, 0, { ...baseMem, recallCount: 15 });
    const without = computeWeights(0.5, 0, { ...baseMem, recallCount: 0 });
    const importanceDiff = withRecall.weights.importance - without.weights.importance;
    expect(importanceDiff).toBeCloseTo(0.2, 5);
  });

  it('Test 5: pinned=false and recallCount=0 behaves same as before (no floor, normal recency)', () => {
    const result = computeWeights(0.5, 0, baseMem);
    // 90-day-old memory should have recency < 1.0
    expect(result.weights.recency).toBeLessThan(1.0);
    expect(result.weights.recency).toBeGreaterThan(0);
    // No pin floor — score should be whatever the formula produces
    const expectedRecency = Math.exp(-0.015 * 90);
    expect(result.weights.recency).toBeCloseTo(expectedRecency, 2);
    // Score should NOT be forced to 0.75
    const expectedFinal = 0.7 * 0.5 + 0.15 * expectedRecency + 0.1 * 0.5 + 0.05 * 0.7;
    expect(result.score).toBeCloseTo(expectedFinal, 2);
  });
});
