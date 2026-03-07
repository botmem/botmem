import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaService } from '../ollama.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaEmbedModel: 'nomic-embed-text',
    ollamaTextModel: 'qwen3:0.6b',
    ollamaVlModel: 'qwen3-vl:2b',
    ollamaRerankerModel: 'sam860/qwen3-reranker:0.6b-Q8_0',
    ...overrides,
  } as ConfigService;
}

describe('OllamaService.rerank', () => {
  let service: OllamaService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    service = new OllamaService(createMockConfig());
  });

  it('returns array of scores between 0 and 1 for given documents (logprobs)', async () => {
    // Simulate Ollama response with logprobs where "yes" has high probability
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        response: 'yes',
        logprobs: [{
          top_logprobs: [
            { token: 'yes', logprob: -0.1 },   // ~0.905
            { token: 'no', logprob: -2.5 },     // ~0.082
            { token: 'Yes', logprob: -3.0 },
            { token: 'true', logprob: -4.0 },
            { token: 'No', logprob: -4.5 },
          ],
        }],
      }),
    });

    const scores = await service.rerank('what is the weather?', ['It is sunny today.', 'The sky is blue.']);

    expect(scores).toHaveLength(2);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // Both calls got the same mock response with high "yes" prob, so scores should be high
    expect(scores[0]).toBeGreaterThan(0.8);
  });

  it('returns array of zeros when Ollama returns HTTP error (model not available)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('model not found'),
    });

    const scores = await service.rerank('query', ['doc1', 'doc2', 'doc3']);

    expect(scores).toEqual([0, 0, 0]);
  });

  it('returns array of zeros when fetch times out', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const scores = await service.rerank('query', ['doc1']);

    expect(scores).toEqual([0]);
  });

  it('falls back to text parsing when logprobs field is undefined (older Ollama)', async () => {
    // First call: response starts with "yes" -> 0.8
    // Second call: response starts with "no" -> 0.2
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'yes' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'no' }),
      });

    const scores = await service.rerank('query', ['relevant doc', 'irrelevant doc']);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toBe(0.8);
    expect(scores[1]).toBe(0.2);
  });

  it('processes exactly the number of documents passed (no more, no less)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        response: 'yes',
        logprobs: [{
          top_logprobs: [
            { token: 'yes', logprob: -0.5 },
            { token: 'no', logprob: -1.5 },
          ],
        }],
      }),
    });

    const docs = ['doc1', 'doc2', 'doc3', 'doc4', 'doc5'];
    const scores = await service.rerank('query', docs);

    expect(scores).toHaveLength(5);
    // Should have made exactly 5 fetch calls (one per document)
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});
