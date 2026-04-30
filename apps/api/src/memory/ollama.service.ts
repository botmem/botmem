import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private baseUrl: string;
  private embedModel: string;
  private textModel: string;
  private vlModel: string;
  private authHeaders: Record<string, string>;

  constructor(config: ConfigService) {
    this.baseUrl = config.ollamaBaseUrl;
    this.embedModel = config.ollamaEmbedModel;
    this.textModel = config.ollamaTextModel;
    this.vlModel = config.ollamaVlModel;
    const username = config.ollamaUsername;
    const password = config.ollamaPassword;
    this.authHeaders =
      username && password
        ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
        : {};
  }

  // No onModuleInit — Ollama models stay loaded in memory.
  // First real embed/generate call handles any cold start naturally.

  async embed(text: string, retries = 3): Promise<number[]> {
    const t0 = Date.now();
    // Truncate long inputs upfront; models will truncate internally if still too long
    let input = text.length > 8000 ? text.slice(0, 8000) : text;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders },
          body: JSON.stringify({ model: this.embedModel, input }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!res.ok) {
          const body = await res.text();
          // If context length exceeded, halve the input and retry immediately
          if (body.includes('context length')) {
            input = input.slice(0, Math.floor(input.length * 0.5));
            continue;
          }
          throw new Error(body || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data.embeddings?.[0]) {
          throw new Error(`Empty embeddings for ${input.length} chars`);
        }
        this.logger.log(
          `llm_request provider=ollama model=${this.embedModel} op=embed duration_ms=${Date.now() - t0} input_chars=${input.length}`,
        );
        return data.embeddings[0];
      } catch (err: unknown) {
        // Also catch context length errors that come through as thrown errors
        if (err instanceof Error && err.message.includes('context length')) {
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
  ): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
    const t0 = Date.now();
    // Use VL model for images, text model for text-only; always disable thinking
    const hasImages = images?.length;
    const model = hasImages ? this.vlModel : this.textModel;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const message: Record<string, unknown> = { role: 'user', content: prompt };
        if (hasImages) {
          message.images = images;
        }

        const body: Record<string, unknown> = {
          model,
          messages: [message],
          stream: false,
          think: false,
          options: { num_ctx: 2048 },
        };
        if (format) body.format = format;

        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama generate failed (${res.status}): ${text}`);
        }

        const data = await res.json();
        // Strip <think>...</think> reasoning tags just in case
        const text = (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '');
        const inputTokens = data.prompt_eval_count as number | undefined;
        const outputTokens = data.eval_count as number | undefined;
        this.logger.log(
          `llm_request provider=ollama model=${model} op=${hasImages ? 'vl' : 'generate'} duration_ms=${Date.now() - t0} input_tokens=${inputTokens ?? 0} output_tokens=${outputTokens ?? 0}`,
        );
        return { text, inputTokens, outputTokens };
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
}
