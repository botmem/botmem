import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '../config/config.service';

export interface EmbedPart {
  type: 'text' | 'image' | 'pdf' | 'audio';
  text?: string;
  base64?: string;
  mimeType?: string;
}

@Injectable()
export class GeminiEmbedService implements OnModuleInit {
  private readonly logger = new Logger(GeminiEmbedService.name);
  private client: GoogleGenAI | null = null;
  private model: string;
  private mediaModel: string;
  private dimensions: number;

  constructor(private readonly config: ConfigService) {
    this.model = config.geminiEmbedModel;
    this.mediaModel = config.geminiMediaModel;
    this.dimensions = config.geminiEmbedDimensions;
  }

  onModuleInit() {
    if (this.config.embedBackend !== 'gemini') {
      this.logger.log('Gemini embed backend not active — skipping init');
      return;
    }
    if (!this.config.geminiApiKey) {
      throw new Error(
        'GEMINI_API_KEY is required when EMBED_BACKEND=gemini. ' +
          'Get a free key at https://aistudio.google.com/apikey',
      );
    }
    this.client = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
    this.logger.log(
      `Gemini embed configured — model: ${this.model}, dimensions: ${this.dimensions}`,
    );
  }

  private ensureClient(): GoogleGenAI {
    if (!this.client) {
      throw new Error('GeminiEmbedService not initialized — is EMBED_BACKEND=gemini set?');
    }
    return this.client;
  }

  async embed(text: string, retries = 3): Promise<number[]> {
    const t0 = Date.now();
    const input = text.length > 8000 ? text.slice(0, 8000) : text;
    return this.withRetry(retries, async () => {
      const client = this.ensureClient();
      const result = await client.models.embedContent({
        model: this.model,
        contents: input,
        config: { outputDimensionality: this.dimensions },
      });
      const values = result.embeddings?.[0]?.values;
      if (!values?.length) throw new Error('Gemini returned empty embedding');
      this.logger.log(
        `llm_request provider=gemini model=${this.model} op=embed duration_ms=${Date.now() - t0} input_chars=${input.length}`,
      );
      return values;
    });
  }

  async embedMultimodal(parts: EmbedPart[], retries = 3): Promise<number[]> {
    const t0 = Date.now();
    return this.withRetry(retries, async () => {
      const client = this.ensureClient();
      const contentParts = parts.map((part) => {
        if (part.type === 'text') {
          const text = part.text || '';
          return { text: text.length > 8000 ? text.slice(0, 8000) : text };
        }
        return {
          inlineData: {
            data: part.base64!,
            mimeType: part.mimeType || this.inferMime(part.type),
          },
        };
      });

      const result = await client.models.embedContent({
        model: this.model,
        contents: { parts: contentParts },
        config: { outputDimensionality: this.dimensions },
      });
      const values = result.embeddings?.[0]?.values;
      if (!values?.length) throw new Error('Gemini returned empty multimodal embedding');
      this.logger.log(
        `llm_request provider=gemini model=${this.model} op=embed_multimodal duration_ms=${Date.now() - t0} parts=${parts.length}`,
      );
      return values;
    });
  }

  async generateFromParts(prompt: string, parts: EmbedPart[], retries = 2): Promise<string> {
    const t0 = Date.now();
    return this.withRetry(retries, async () => {
      const client = this.ensureClient();
      const contentParts = [
        { text: prompt },
        ...parts.map((part) => {
          if (part.type === 'text') {
            const text = part.text || '';
            return { text: text.length > 8000 ? text.slice(0, 8000) : text };
          }
          return {
            inlineData: {
              data: part.base64!,
              mimeType: part.mimeType || this.inferMime(part.type),
            },
          };
        }),
      ];

      const result = await client.models.generateContent({
        model: this.mediaModel,
        contents: { parts: contentParts },
      });
      const text = result.text?.trim();
      if (!text) throw new Error('Gemini returned empty media extraction');
      this.logger.log(
        `llm_request provider=gemini model=${this.mediaModel} op=generate_media duration_ms=${Date.now() - t0} parts=${parts.length}`,
      );
      return text;
    });
  }

  async generate(
    prompt: string,
    images?: string[],
    retries = 2,
    format?: Record<string, unknown>,
  ): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
    const t0 = Date.now();
    return this.withRetry(retries, async () => {
      const client = this.ensureClient();
      const contentParts = [
        { text: prompt },
        ...(images || []).map((image) => ({
          inlineData: {
            data: image.includes(',') ? image.split(',').pop()! : image,
            mimeType: this.inferImageMime(image),
          },
        })),
      ];

      const result = await client.models.generateContent({
        model: this.mediaModel,
        contents: { parts: contentParts },
        config: format ? { responseMimeType: 'application/json' } : undefined,
      });

      const text = result.text?.trim();
      if (!text) throw new Error('Gemini returned empty generation');

      const usage = result.usageMetadata;
      this.logger.log(
        `llm_request provider=gemini model=${this.mediaModel} op=${images?.length ? 'generate_vl' : 'generate'} duration_ms=${Date.now() - t0} input_tokens=${usage?.promptTokenCount ?? 0} output_tokens=${usage?.candidatesTokenCount ?? 0}`,
      );

      return {
        text,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
      };
    });
  }

  private inferMime(type: string): string {
    switch (type) {
      case 'image':
        return 'image/jpeg';
      case 'pdf':
        return 'application/pdf';
      case 'audio':
        return 'audio/wav';
      default:
        return 'application/octet-stream';
    }
  }

  private inferImageMime(image: string): string {
    const match = image.match(/^data:([^;]+);base64,/);
    return match?.[1] || 'image/jpeg';
  }

  private async withRetry<T>(retries: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
        const isRetryable = is429 || msg.includes('503') || msg.includes('UNAVAILABLE');

        if (attempt < retries && isRetryable) {
          const delay = is429
            ? Math.min(2000 * Math.pow(2, attempt), 30_000) // 429: longer backoff
            : 1000 * (attempt + 1);
          this.logger.warn(
            `Gemini embed attempt ${attempt + 1}/${retries + 1} failed (${msg.slice(0, 100)}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }
}
