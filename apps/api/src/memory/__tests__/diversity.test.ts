import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryService } from '../memory.service';

/**
 * Test the private diversityRerank method via (service as any).
 * We construct MemoryService with minimal mocks — only the reranker logic is exercised.
 */

function makeCand(
  id: string,
  score: number,
  connectorType: string,
): { id: string; row: any; score: number; weights: any } {
  return {
    id,
    score,
    row: { connectorType },
    weights: {},
  };
}

describe('diversityRerank', () => {
  let service: MemoryService;

  beforeEach(() => {
    // MemoryService constructor needs several deps — stub them all
    service = new (MemoryService as any)(
      /* dbService */ {},
      /* aiService */ {},
      /* typesenseService */ {},
      /* connectorsService */ {},
      /* pluginRegistry */ {},
      /* cryptoService */ {},
      /* userKeyService */ {},
    );
  });

  const rerank = (
    candidates: ReturnType<typeof makeCand>[],
    limit: number,
    diversityFactor?: number,
  ) => (service as any).diversityRerank(candidates, limit, diversityFactor);

  it('returns empty for empty candidates', () => {
    expect(rerank([], 10)).toEqual([]);
  });

  it('returns single candidate as-is', () => {
    const c = makeCand('a', 0.9, 'gmail');
    const result = rerank([c], 5);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('returns top-K by score when all same connector', () => {
    const candidates = [
      makeCand('a', 0.9, 'gmail'),
      makeCand('b', 0.8, 'gmail'),
      makeCand('c', 0.7, 'gmail'),
      makeCand('d', 0.6, 'gmail'),
    ];
    const result = rerank(candidates, 3);
    expect(result).toHaveLength(3);
    expect(result.map((r: any) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('interleaves two connectors with close scores', () => {
    const candidates = [
      makeCand('g1', 0.9, 'gmail'),
      makeCand('g2', 0.85, 'gmail'),
      makeCand('s1', 0.88, 'slack'),
      makeCand('s2', 0.82, 'slack'),
    ];
    const result = rerank(candidates, 4, 0.15);
    // With diversity, should not be purely score-sorted — expect interleaving
    const types = result.map((r: any) => r.row.connectorType);
    // First pick is best overall (gmail g1), second should be slack (least represented)
    expect(types[0]).toBe('gmail');
    expect(types[1]).toBe('slack');
  });

  it('relevance wins when one connector is far below threshold', () => {
    const candidates = [
      makeCand('g1', 0.95, 'gmail'),
      makeCand('g2', 0.9, 'gmail'),
      makeCand('s1', 0.5, 'slack'), // way below threshold (0.95 - 0.15 = 0.80)
    ];
    const result = rerank(candidates, 3, 0.15);
    // g1 and g2 should come first since slack is below threshold
    expect(result[0].id).toBe('g1');
    expect(result[1].id).toBe('g2');
    // slack only picked when it's the only one left
    expect(result[2].id).toBe('s1');
  });

  it('round-robins across three connectors', () => {
    const candidates = [
      makeCand('g1', 0.9, 'gmail'),
      makeCand('s1', 0.89, 'slack'),
      makeCand('w1', 0.88, 'whatsapp'),
      makeCand('g2', 0.85, 'gmail'),
      makeCand('s2', 0.84, 'slack'),
      makeCand('w2', 0.83, 'whatsapp'),
    ];
    const result = rerank(candidates, 6, 0.15);
    // First three should be one from each connector
    const firstThreeTypes = result.slice(0, 3).map((r: any) => r.row.connectorType);
    expect(new Set(firstThreeTypes).size).toBe(3);
  });

  it('diversityFactor=0 yields pure score sort', () => {
    const candidates = [
      makeCand('g1', 0.9, 'gmail'),
      makeCand('s1', 0.89, 'slack'),
      makeCand('g2', 0.88, 'gmail'),
      makeCand('s2', 0.87, 'slack'),
    ];
    // With factor=0, threshold = bestScore - 0 = bestScore, so only exact-score ties diversify
    // In practice this means the globally best is always picked
    const result = rerank(candidates, 4, 0);
    expect(result.map((r: any) => r.id)).toEqual(['g1', 's1', 'g2', 's2']);
  });

  it('diversityFactor=1 aggressively diversifies', () => {
    const candidates = [
      makeCand('g1', 0.9, 'gmail'),
      makeCand('g2', 0.85, 'gmail'),
      makeCand('g3', 0.8, 'gmail'),
      makeCand('s1', 0.5, 'slack'),
    ];
    // factor=1 means threshold = best - 1.0, so even 0.50 is above threshold (-0.10)
    // Slack should get picked as second item (least represented)
    const result = rerank(candidates, 4, 1);
    expect(result[0].id).toBe('g1');
    expect(result[1].id).toBe('s1'); // aggressive diversity pulls slack up
  });

  it('respects limit parameter', () => {
    const candidates = [
      makeCand('a', 0.9, 'gmail'),
      makeCand('b', 0.8, 'slack'),
      makeCand('c', 0.7, 'whatsapp'),
    ];
    const result = rerank(candidates, 2);
    expect(result).toHaveLength(2);
  });
});
