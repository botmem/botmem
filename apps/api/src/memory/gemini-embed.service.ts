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
  private dimensions: number;

  constructor(private readonly config: ConfigService) {
    this.model = config.geminiEmbedModel;
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
      return values;
    });
  }

  async embedMultimodal(parts: EmbedPart[], retries = 3): Promise<number[]> {
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
      return values;
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
