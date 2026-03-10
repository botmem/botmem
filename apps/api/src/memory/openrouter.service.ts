import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class OpenRouterService implements OnModuleInit {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly baseUrl = 'https://openrouter.ai/api';
  private apiKey: string;
  private embedModel: string;
  private textModel: string;
  private vlModel: string;

  constructor(config: ConfigService) {
    this.apiKey = config.openrouterApiKey;
    this.embedModel = config.openrouterEmbedModel;
    this.textModel = config.openrouterTextModel;
    this.vlModel = config.openrouterVlModel;
  }

  async onModuleInit() {
    if (!this.apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not set — OpenRouterService will not function');
      return;
    }
    this.logger.log(
      `OpenRouter configured — embed: ${this.embedModel}, text: ${this.textModel}, vl: ${this.vlModel}`,
    );
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://botmem.xyz',
      'X-Title': 'Botmem',
    };
  }

  async embed(text: string, retries = 3): Promise<number[]> {
    let input = text.length > 8000 ? text.slice(0, 8000) : text;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ model: this.embedModel, input }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!res.ok) {
          const body = await res.text();
          if (body.includes('context length') || body.includes('too long')) {
            input = input.slice(0, Math.floor(input.length * 0.5));
            continue;
          }
          throw new Error(body || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data.data?.[0]?.embedding) {
          throw new Error(`Empty embedding response for ${input.length} chars`);
        }
        return data.data[0].embedding;
      } catch (err: any) {
        if (err?.message?.includes('context length') || err?.message?.includes('too long')) {
          input = input.slice(0, Math.floor(input.length * 0.5));
          continue;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable');
  }

  async generate(
    prompt: string,
    images?: string[],
    retries = 2,
    format?: Record<string, unknown>,
  ): Promise<string> {
    const hasImages = images?.length;
    const model = hasImages ? this.vlModel : this.textModel;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Build message content
        let content: unknown;
        if (hasImages) {
          const parts: unknown[] = [{ type: 'text', text: prompt }];
          for (const image of images!) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${image}` },
            });
          }
          content = parts;
        } else {
          content = prompt;
        }

        const messages: unknown[] = [];

        // When JSON format is requested, add a system message
        if (format) {
          messages.push({ role: 'system', content: 'Respond in JSON format.' });
        }

        messages.push({ role: 'user', content });

        const body: Record<string, unknown> = { model, messages };
        if (format) {
          body.response_format = { type: 'json_object' };
        }

        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`OpenRouter generate failed (${res.status}): ${text}`);
        }

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content || '';
        // Strip <think>...</think> reasoning tags
        return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
      } catch (err) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Rerank is not supported via OpenRouter — graceful degradation returns zeros.
   */
  async rerank(_query: string, documents: string[]): Promise<number[]> {
    return new Array(documents.length).fill(0);
  }
}
