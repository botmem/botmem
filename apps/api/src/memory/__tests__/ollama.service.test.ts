import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaService } from '../ollama.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaEmbedModel: 'qwen3-embedding:8b',
    ollamaVlModel: 'qwen3-vl:8b',
    ...overrides,
  } as ConfigService;
}

describe('OllamaService', () => {
  let service: OllamaService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    service = new OllamaService(createMockConfig());
  });

  describe('embed', () => {
    it('calls Ollama embed endpoint with correct model and input', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ embeddings: [mockEmbedding] }),
      });

      const result = await service.embed('hello world');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/embed',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3-embedding:8b', input: 'hello world' }),
        }),
      );
      expect(result).toEqual(mockEmbedding);
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('model not found'),
      });

      await expect(service.embed('test')).rejects.toThrow();
    });

    it('throws on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.embed('test')).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('generate', () => {
    it('calls Ollama generate endpoint with prompt', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: '{"entities": []}' }),
      });

      const result = await service.generate('extract entities from: hello');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('qwen3-vl:8b'),
        }),
      );
      expect(result).toBe('{"entities": []}');
    });

    it('passes images when provided', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'a sunset photo' }),
      });

      await service.generate('describe this image', ['base64data']);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.images).toEqual(['base64data']);
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('model loading'),
      });

      await expect(service.generate('test')).rejects.toThrow();
    });
  });
});
