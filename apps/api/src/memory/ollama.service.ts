import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class OllamaService implements OnModuleInit {
  private readonly logger = new Logger(OllamaService.name);
  private baseUrl: string;
  private embedModel: string;
  private textModel: string;
  private vlModel: string;
  private rerankerModel: string;
  private authHeaders: Record<string, string>;

  constructor(config: ConfigService) {
    this.baseUrl = config.ollamaBaseUrl;
    this.embedModel = config.ollamaEmbedModel;
    this.textModel = config.ollamaTextModel;
    this.vlModel = config.ollamaVlModel;
    this.rerankerModel = config.ollamaRerankerModel;
    const username = config.ollamaUsername;
    const password = config.ollamaPassword;
    this.authHeaders =
      username && password
        ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
        : {};
  }

  async onModuleInit() {
    // Pre-warm embedding model so first search isn't slow
    try {
      await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify({ model: this.embedModel, input: 'warmup' }),
        signal: AbortSignal.timeout(30_000),
      });
      this.logger.log(`Pre-warmed embedding model: ${this.embedModel}`);
    } catch {
      this.logger.warn('Failed to pre-warm embedding model');
    }
  }

  async embed(text: string, retries = 3): Promise<number[]> {
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
  ): Promise<string> {
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
        return (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '');
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
   * Rerank documents against a query using Qwen3-Reranker via Ollama generate API.
   * Returns an array of relevance scores (0-1) in the same order as the input documents.
   * Gracefully degrades: returns 0 for any document that fails (timeout, model unavailable, etc.).
   */
  async rerank(query: string, documents: string[]): Promise<number[]> {
    const results = await Promise.allSettled(documents.map((doc) => this.rerankOne(query, doc)));
    return results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
  }

  private async rerankOne(query: string, doc: string): Promise<number> {
    const prompt = `<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".\n<|im_end|>\n<|im_start|>user\n<Instruct>: Given a personal memory search query, retrieve relevant memories that answer the query\n<Query>: ${query}\n<Document>: ${doc}\n<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify({
          model: this.rerankerModel,
          prompt,
          raw: true,
          stream: false,
          options: {
            temperature: 0,
            num_predict: 1,
            logprobs: true,
            top_logprobs: 5,
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) return 0;

      const data = await res.json();

      if (data.logprobs?.[0]?.top_logprobs) {
        const topLogprobs: Array<{ token: string; logprob: number }> =
          data.logprobs[0].top_logprobs;
        let yesProb = 0;
        let noProb = 0;
        for (const entry of topLogprobs) {
          const token = entry.token.toLowerCase().trim();
          if (token === 'yes') yesProb += Math.exp(entry.logprob);
          if (token === 'no') noProb += Math.exp(entry.logprob);
        }
        const total = yesProb + noProb;
        return total > 0 ? yesProb / total : 0;
      }

      const response = (data.response || '').toLowerCase().trim();
      return response.startsWith('yes') ? 0.8 : 0.2;
    } catch {
      return 0;
    }
  }
}
