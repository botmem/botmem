import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterService } from '../openrouter.service';
import { ConfigService } from '../../config/config.service';

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    openrouterApiKey: 'test-api-key',
    openrouterEmbedModel: 'google/gemini-embedding-001',
    openrouterTextModel: 'mistralai/mistral-nemo',
    openrouterVlModel: 'google/gemma-3-4b-it',
    ...overrides,
  } as ConfigService;
}

describe('OpenRouterService', () => {
  let service: OpenRouterService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    service = new OpenRouterService(createMockConfig());
  });

  describe('onModuleInit', () => {
    it('logs warning when API key is not set', async () => {
      const svc = new OpenRouterService(createMockConfig({ openrouterApiKey: '' } as Partial<ConfigService>));
      // Should not throw
      await svc.onModuleInit();
    });

    it('logs config when API key is set', async () => {
      await service.onModuleInit();
      // No error thrown
    });
  });

  describe('embed', () => {
    it('calls OpenRouter embeddings endpoint with correct headers and body', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });

      const result = await service.embed('hello world');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
            'HTTP-Referer': 'https://botmem.xyz',
            'X-Title': 'Botmem',
          }),
        }),
      );

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.model).toBe('google/gemini-embedding-001');
      expect(callBody.input).toBe('hello world');
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('truncates input longer than 8000 chars', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [0.1] }] }),
      });

      const longText = 'a'.repeat(10000);
      await service.embed(longText);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.input.length).toBe(8000);
    });

    it('halves input on context length error from response body', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          text: () => Promise.resolve('context length exceeded'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [{ embedding: [0.5] }] }),
        });

      const result = await service.embed('hello world', 1);

      expect(result).toEqual([0.5]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws on empty embedding response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{}] }),
      });

      await expect(service.embed('test', 0)).rejects.toThrow('Empty embedding response');
    });

    it('throws on HTTP error after retries exhausted', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('server error'),
      });

      await expect(service.embed('test', 0)).rejects.toThrow('server error');
    });

    it('throws on network error after retries exhausted', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.embed('test', 0)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('generate', () => {
    it('calls chat/completions with text model for text-only prompt', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'generated text' } }],
          }),
      });

      const result = await service.generate('hello');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/chat/completions',
        expect.objectContaining({ method: 'POST' }),
      );

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.model).toBe('mistralai/mistral-nemo');
      expect(callBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(result).toBe('generated text');
    });

    it('uses VL model and image_url format when images provided', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'image description' } }],
          }),
      });

      await service.generate('describe', ['base64data']);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.model).toBe('google/gemma-3-4b-it');
      expect(callBody.messages[0].content).toEqual([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,base64data' } },
      ]);
    });

    it('adds system message and response_format for JSON format', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"key": "value"}' } }],
          }),
      });

      await service.generate('extract', undefined, 2, { type: 'json_object' });

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(callBody.messages[0]).toEqual({
        role: 'system',
        content: 'Respond in JSON format.',
      });
      expect(callBody.response_format).toEqual({ type: 'json_object' });
      expect(callBody.max_tokens).toBe(512);
    });

    it('strips <think> tags from response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: '<think>reasoning here</think>\nactual response',
                },
              },
            ],
          }),
      });

      const result = await service.generate('prompt');

      expect(result).toBe('actual response');
    });

    it('returns empty string when no content in response', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: {} }] }),
      });

      const result = await service.generate('prompt');
      expect(result).toBe('');
    });

    it('throws on HTTP error after retries exhausted', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('internal error'),
      });

      await expect(service.generate('test', undefined, 0)).rejects.toThrow(
        'OpenRouter generate failed (500): internal error',
      );
    });

    it('retries on failure before exhaustion', async () => {
      fetchSpy
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'success' } }],
            }),
        });

      const result = await service.generate('test', undefined, 1);
      expect(result).toBe('success');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('rerank', () => {
    it('returns array of zeros (not supported)', async () => {
      const result = await service.rerank('query', ['doc1', 'doc2', 'doc3']);

      expect(result).toEqual([0, 0, 0]);
    });
  });
});
