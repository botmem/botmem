import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class OllamaService {
  private baseUrl: string;
  private embedModel: string;
  private textModel: string;
  private vlModel: string;
  private rerankerModel: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.ollamaBaseUrl;
    this.embedModel = config.ollamaEmbedModel;
    this.textModel = config.ollamaTextModel;
    this.vlModel = config.ollamaVlModel;
    this.rerankerModel = config.ollamaRerankerModel;
  }

  async embed(text: string, retries = 3): Promise<number[]> {
    let input = text;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      } catch (err: any) {
        // Also catch context length errors that come through as thrown errors
        if (err?.message?.includes('context length')) {
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

  async generate(prompt: string, images?: string[], retries = 2): Promise<string> {
    // Use VL model for images, text model with /no_think for text-only
    const hasImages = images?.length;
    const model = hasImages ? this.vlModel : this.textModel;
    const finalPrompt = hasImages ? prompt : `${prompt} /no_think`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model,
          prompt: finalPrompt,
          stream: false,
        };
        if (hasImages) {
          body.images = images;
        }

        const res = await fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama generate failed (${res.status}): ${text}`);
        }

        const data = await res.json();
        // Strip <think>...</think> reasoning tags from model output
        return (data.response || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '');
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
    const scores: number[] = [];

    for (const doc of documents) {
      try {
        const prompt = `<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".\n<|im_end|>\n<|im_start|>user\n<Instruct>: Given a personal memory search query, retrieve relevant memories that answer the query\n<Query>: ${query}\n<Document>: ${doc}\n<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;

        const res = await fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

        if (!res.ok) {
          scores.push(0);
          continue;
        }

        const data = await res.json();

        // Try logprobs-based scoring first (preferred)
        if (data.logprobs?.[0]?.top_logprobs) {
          const topLogprobs: Array<{ token: string; logprob: number }> = data.logprobs[0].top_logprobs;
          let yesProb = 0;
          let noProb = 0;

          for (const entry of topLogprobs) {
            const token = entry.token.toLowerCase().trim();
            if (token === 'yes') yesProb += Math.exp(entry.logprob);
            if (token === 'no') noProb += Math.exp(entry.logprob);
          }

          // Softmax-style normalization
          const total = yesProb + noProb;
          scores.push(total > 0 ? yesProb / total : 0);
        } else {
          // Fallback: parse text response for older Ollama versions without logprobs
          const response = (data.response || '').toLowerCase().trim();
          scores.push(response.startsWith('yes') ? 0.8 : 0.2);
        }
      } catch {
        scores.push(0);
      }
    }

    return scores;
  }
}
