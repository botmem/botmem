import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaService } from '../ollama.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaEmbedModel: 'qwen3-embedding:8b',
    ollamaTextModel: 'qwen3:0.6b',
    ollamaVlModel: 'qwen3-vl:8b',
    ollamaRerankerModel: '',
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

      // Pass retries=0 to avoid retry delays
      await expect(service.embed('test', 0)).rejects.toThrow();
    });

    it('throws on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      // Pass retries=0 to avoid retry delays
      await expect(service.embed('test', 0)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('generate', () => {
    it('calls Ollama chat endpoint with prompt', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: { content: '{"entities": []}' } }),
      });

      const result = await service.generate('extract entities from: hello');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/chat',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      // Text-only prompts use the text model
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.model).toBe('qwen3:0.6b');
      expect(result).toEqual(expect.objectContaining({ text: '{"entities": []}' }));
    });

    it('passes images when provided and uses VL model', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ message: { content: 'a sunset photo' } }),
      });

      await service.generate('describe this image', ['base64data']);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.messages[0].images).toEqual(['base64data']);
      expect(callBody.model).toBe('qwen3-vl:8b');
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('model loading'),
      });

      // Pass retries=0 to avoid retry delays
      await expect(service.generate('test', undefined, 0)).rejects.toThrow();
    });
  });
});
