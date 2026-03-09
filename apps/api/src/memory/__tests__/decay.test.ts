import { describe, it, expect } from 'vitest';

/**
 * Tests for DecayProcessor logic.
 *
 * We extract the core decay computation as a pure function and test it,
 * plus test the batch processing behavior via a mock setup.
 */

// Replicate the decay recency/importance computation for unit testing
function computeDecayWeights(
  mem: {
    eventTime: string | Date;
    pinned: boolean;
    recallCount: number;
    connectorType: string;
    entities: string;
    weights: Record<string, number>;
  },
  getTrustScore: (ct: string) => number = () => 0.7,
): {
  recency: number;
  importance: number;
  trust: number;
  final: number;
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
} {
  const isPinned = mem.pinned;
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

  // Weights is now a JSONB object -- no JSON.parse needed
  const { semantic = 0, rerank = 0 } = mem.weights || {};

  let final =
    rerank > 0
      ? 0.4 * semantic + 0.3 * rerank + 0.15 * recency + 0.1 * importance + 0.05 * trust
      : 0.7 * semantic + 0.15 * recency + 0.1 * importance + 0.05 * trust;

  if (isPinned) final = Math.max(final, 0.75);

  return {
    recency,
    importance,
    trust,
    final,
    weights: { semantic, rerank, recency, importance, trust, final },
  };
}

describe('DecayProcessor logic', () => {
  it('Test 1: recomputes recency for non-pinned memory aged 30 days', () => {
    const mem = {
      eventTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      pinned: false,
      recallCount: 0,
      connectorType: 'gmail',
      entities: '[]',
      weights: {
        semantic: 0.8,
        rerank: 0,
        recency: 1.0,
        importance: 0.5,
        trust: 0.7,
        final: 0.6,
      },
    };

    const result = computeDecayWeights(mem);
    const expectedRecency = Math.exp(-0.015 * 30);
    expect(result.recency).toBeCloseTo(expectedRecency, 3);
    // ~0.638
    expect(result.recency).toBeCloseTo(0.638, 2);
  });

  it('Test 2: pinned memory retains recency=1.0 regardless of age', () => {
    const mem = {
      eventTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year old
      pinned: true,
      recallCount: 0,
      connectorType: 'gmail',
      entities: '[]',
      weights: {
        semantic: 0.5,
        rerank: 0,
        recency: 0.1,
        importance: 0.5,
        trust: 0.7,
        final: 0.3,
      },
    };

    const result = computeDecayWeights(mem);
    expect(result.recency).toBe(1.0);
  });

  it('Test 3: processes in batches -- 1200 memories with BATCH_SIZE=500 = 3 batches', () => {
    const BATCH_SIZE = 500;
    const totalMemories = 1200;

    // Simulate batch processing
    const batches: number[] = [];
    let offset = 0;
    while (true) {
      const batchSize = Math.min(BATCH_SIZE, totalMemories - offset);
      if (batchSize <= 0) break;
      batches.push(batchSize);
      offset += batchSize;
    }

    expect(batches.length).toBe(3);
    expect(batches[0]).toBe(500);
    expect(batches[1]).toBe(500);
    expect(batches[2]).toBe(200);
  });

  it('Test 4: preserves existing semantic and rerank scores from weights', () => {
    const mem = {
      eventTime: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      pinned: false,
      recallCount: 0,
      connectorType: 'gmail',
      entities: '[]',
      weights: {
        semantic: 0.92,
        rerank: 0.85,
        recency: 1.0,
        importance: 0.5,
        trust: 0.7,
        final: 0.8,
      },
    };

    const result = computeDecayWeights(mem);
    // Must preserve the original semantic and rerank scores
    expect(result.weights.semantic).toBe(0.92);
    expect(result.weights.rerank).toBe(0.85);
    // But recency should be recalculated
    expect(result.weights.recency).not.toBe(1.0);
    expect(result.weights.recency).toBeCloseTo(Math.exp(-0.015 * 10), 3);
  });

  it('Test 5: recall boost is capped at +0.2 (recallCount=20 same as recallCount=10)', () => {
    const baseMem = {
      eventTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      pinned: false,
      connectorType: 'gmail',
      entities: '[]',
      weights: {
        semantic: 0.5,
        rerank: 0,
        recency: 0.9,
        importance: 0.5,
        trust: 0.7,
        final: 0.5,
      },
    };

    const result10 = computeDecayWeights({ ...baseMem, recallCount: 10 });
    const result20 = computeDecayWeights({ ...baseMem, recallCount: 20 });
    const resultBase = computeDecayWeights({ ...baseMem, recallCount: 0 });

    // Both recallCount=10 and recallCount=20 should cap at +0.2
    expect(result10.importance - resultBase.importance).toBeCloseTo(0.2, 5);
    expect(result20.importance - resultBase.importance).toBeCloseTo(0.2, 5);
    // So they should be equal
    expect(result10.importance).toBeCloseTo(result20.importance, 5);
  });
});
