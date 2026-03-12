import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiEmbedService } from '../gemini-embed.service';
import { ConfigService } from '../../config/config.service';

// Mock the @google/genai module
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        embedContent: vi.fn(),
      },
    })),
  };
});

function createMockConfig(overrides: Partial<ConfigService> = {}): ConfigService {
  return {
    embedBackend: 'gemini',
    geminiApiKey: 'test-gemini-key',
    geminiEmbedModel: 'gemini-embedding-2-preview',
    geminiEmbedDimensions: 3072,
    ...overrides,
  } as ConfigService;
}

describe('GeminiEmbedService', () => {
  let service: GeminiEmbedService;
  let mockEmbedContent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new GeminiEmbedService(createMockConfig());
    service.onModuleInit();

    // Get the mock embedContent function from the initialized client
    const client = (service as unknown as { client: { models: { embedContent: ReturnType<typeof vi.fn> } } }).client;
    mockEmbedContent = client.models.embedContent;
  });

  describe('onModuleInit', () => {
    it('skips init when embedBackend is not gemini', () => {
      const svc = new GeminiEmbedService(createMockConfig({ embedBackend: 'ollama' } as Partial<ConfigService>));
      svc.onModuleInit();

      // Client should remain null
      expect((svc as unknown as { client: unknown }).client).toBeNull();
    });

    it('throws when gemini backend is active but no API key', () => {
      const svc = new GeminiEmbedService(
        createMockConfig({ geminiApiKey: '' } as Partial<ConfigService>),
      );

      expect(() => svc.onModuleInit()).toThrow('GEMINI_API_KEY is required');
    });

    it('initializes client when backend is gemini and key is present', () => {
      // Already initialized in beforeEach
      expect((service as unknown as { client: unknown }).client).not.toBeNull();
    });
  });

  describe('embed', () => {
    it('calls embedContent with correct model, text, and dimensions', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      });

      const result = await service.embed('hello world');

      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: 'gemini-embedding-2-preview',
        contents: 'hello world',
        config: { outputDimensionality: 3072 },
      });
      expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    it('truncates text longer than 8000 chars', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.1] }],
      });

      const longText = 'a'.repeat(10000);
      await service.embed(longText);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: 'a'.repeat(8000),
        }),
      );
    });

    it('throws on empty embedding response', async () => {
      mockEmbedContent.mockResolvedValue({ embeddings: [{ values: [] }] });

      await expect(service.embed('test', 0)).rejects.toThrow('Gemini returned empty embedding');
    });

    it('throws on null embeddings', async () => {
      mockEmbedContent.mockResolvedValue({ embeddings: [] });

      await expect(service.embed('test', 0)).rejects.toThrow('Gemini returned empty embedding');
    });

    it('throws when client is not initialized', async () => {
      const svc = new GeminiEmbedService(createMockConfig({ embedBackend: 'ollama' } as Partial<ConfigService>));
      svc.onModuleInit(); // Skipped init

      await expect(svc.embed('test', 0)).rejects.toThrow('GeminiEmbedService not initialized');
    });
  });

  describe('embedMultimodal', () => {
    it('handles text parts', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.5, 0.6] }],
      });

      const result = await service.embedMultimodal([
        { type: 'text', text: 'hello' },
      ]);

      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: 'gemini-embedding-2-preview',
        contents: { parts: [{ text: 'hello' }] },
        config: { outputDimensionality: 3072 },
      });
      expect(result).toEqual([0.5, 0.6]);
    });

    it('handles image parts with inlineData', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.7] }],
      });

      await service.embedMultimodal([
        { type: 'image', base64: 'aW1hZ2VkYXRh', mimeType: 'image/png' },
      ]);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: {
            parts: [
              { inlineData: { data: 'aW1hZ2VkYXRh', mimeType: 'image/png' } },
            ],
          },
        }),
      );
    });

    it('infers mime type for image when not specified', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.7] }],
      });

      await service.embedMultimodal([{ type: 'image', base64: 'data' }]);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: {
            parts: [{ inlineData: { data: 'data', mimeType: 'image/jpeg' } }],
          },
        }),
      );
    });

    it('infers mime type for pdf', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.7] }],
      });

      await service.embedMultimodal([{ type: 'pdf', base64: 'data' }]);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: {
            parts: [{ inlineData: { data: 'data', mimeType: 'application/pdf' } }],
          },
        }),
      );
    });

    it('infers mime type for audio', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.7] }],
      });

      await service.embedMultimodal([{ type: 'audio', base64: 'data' }]);

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: {
            parts: [{ inlineData: { data: 'data', mimeType: 'audio/wav' } }],
          },
        }),
      );
    });

    it('truncates text parts longer than 8000 chars', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.1] }],
      });

      await service.embedMultimodal([{ type: 'text', text: 'x'.repeat(10000) }]);

      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.contents.parts[0].text.length).toBe(8000);
    });

    it('handles mixed parts (text + image)', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.9] }],
      });

      await service.embedMultimodal([
        { type: 'text', text: 'describe this' },
        { type: 'image', base64: 'imgdata', mimeType: 'image/jpeg' },
      ]);

      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.contents.parts).toHaveLength(2);
      expect(call.contents.parts[0]).toEqual({ text: 'describe this' });
      expect(call.contents.parts[1]).toEqual({
        inlineData: { data: 'imgdata', mimeType: 'image/jpeg' },
      });
    });

    it('throws on empty multimodal embedding', async () => {
      mockEmbedContent.mockResolvedValue({ embeddings: [{ values: [] }] });

      await expect(
        service.embedMultimodal([{ type: 'text', text: 'test' }], 0),
      ).rejects.toThrow('Gemini returned empty multimodal embedding');
    });
  });

  describe('retry behavior', () => {
    it('retries on 429 error', async () => {
      mockEmbedContent
        .mockRejectedValueOnce(new Error('429 RESOURCE_EXHAUSTED'))
        .mockResolvedValueOnce({ embeddings: [{ values: [0.1] }] });

      const result = await service.embed('test', 1);

      expect(result).toEqual([0.1]);
      expect(mockEmbedContent).toHaveBeenCalledTimes(2);
    });

    it('retries on 503 error', async () => {
      mockEmbedContent
        .mockRejectedValueOnce(new Error('503 UNAVAILABLE'))
        .mockResolvedValueOnce({ embeddings: [{ values: [0.2] }] });

      const result = await service.embed('test', 1);

      expect(result).toEqual([0.2]);
      expect(mockEmbedContent).toHaveBeenCalledTimes(2);
    });

    it('does not retry on non-retryable error', async () => {
      mockEmbedContent.mockRejectedValue(new Error('invalid request'));

      await expect(service.embed('test', 2)).rejects.toThrow('invalid request');
      expect(mockEmbedContent).toHaveBeenCalledTimes(1);
    });
  });
});
