import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

/**
 * RerankService — pluggable reranking backends.
 *
 * Backends:
 *   tei    — HuggingFace Text Embeddings Inference /rerank endpoint (fastest, recommended)
 *   ollama — batch relevance scoring via the configured reranker model
 *   jina   — Jina AI Reranker API (jina-reranker-v3), configure JINA_API_KEY
 *   none   — no-op, returns zeros (search falls back to semantic-only scoring)
 *
 * Set RERANKER_BACKEND=tei|ollama|jina|none (default: tei if RERANKER_URL set, else ollama)
 * Set RERANKER_URL for the tei backend (e.g. http://192.168.10.250:8081)
 * Set JINA_API_KEY for the jina backend.
 */
@Injectable()
export class RerankService implements OnModuleInit {
  private readonly logger = new Logger(RerankService.name);
  private backend: 'ollama' | 'jina' | 'tei' | 'none';

  constructor(private readonly config: ConfigService) {
    this.backend = config.rerankerBackend;
  }

  onModuleInit() {
    if (this.backend === 'jina' && !this.config.jinaApiKey) {
      this.logger.warn('RERANKER_BACKEND=jina but JINA_API_KEY is not set — falling back to none');
      this.backend = 'none';
      return;
    }
    if (this.backend === 'tei' && !this.config.rerankerUrl) {
      this.logger.warn('RERANKER_BACKEND=tei but RERANKER_URL is not set — falling back to ollama');
      this.backend = 'ollama';
      return;
    }
    this.logger.log(
      `Reranker backend: ${this.backend}${this.backend === 'tei' ? ` (${this.config.rerankerUrl})` : ''}`,
    );
  }

  /**
   * Rerank documents against a query.
   * Returns an array of relevance scores (0–1) in the same order as the input.
   * Always resolves — never throws. Returns zeros on failure.
   */
  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (!documents.length) return [];

    try {
      switch (this.backend) {
        case 'tei':
          return await this.rerankTei(query, documents);
        case 'ollama':
          return await this.rerankOllama(query, documents);
        case 'jina':
          return await this.rerankJina(query, documents);
        default:
          return new Array(documents.length).fill(0);
      }
    } catch (err: any) {
      this.logger.error(`Reranker failed, using zero scores: ${err?.message}`, err?.stack);
      return new Array(documents.length).fill(0);
    }
  }

  /**
   * TEI backend: calls HuggingFace Text Embeddings Inference /rerank endpoint.
   * Fast, batch, returns scores indexed by position.
   */
  private async rerankTei(query: string, documents: string[]): Promise<number[]> {
    const res = await fetch(`${this.config.rerankerUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        texts: documents.map((d) => d.slice(0, 512)),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`TEI rerank HTTP ${res.status}: ${await res.text()}`);

    const data: Array<{ index: number; score: number }> = await res.json();
    const scores = new Array(documents.length).fill(0);
    for (const result of data) {
      scores[result.index] = result.score;
    }
    return scores;
  }

  /**
   * Ollama backend: single batch call to the configured reranker model.
   * Asks the model to score each document 0.0–1.0 and return JSON.
   */
  private async rerankOllama(query: string, documents: string[]): Promise<number[]> {
    const docList = documents.map((d, i) => `${i + 1}. ${d.slice(0, 300)}`).join('\n');
    const prompt = `Rate the relevance of each document to the query. Output ONLY a JSON array of ${documents.length} scores from 0.0 to 1.0, in order. No explanation.

Query: ${query}

Documents:
${docList}

JSON array:`;

    const res = await fetch(`${this.config.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.ollamaRerankerModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0, num_ctx: 2048 },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`Ollama rerank HTTP ${res.status}`);

    const data = await res.json();
    const content: string = (data.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();

    // Try JSON.parse first, fall back to regex extraction
    let scores: number[];
    try {
      const parsed = JSON.parse(content);
      scores = Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      const match = content.match(/\[[\d.,\s[\]]+\]/);
      if (!match) {
        this.logger.error(`Unexpected rerank response: ${content.slice(0, 200)}`);
        throw new Error(`Unexpected rerank response: ${content.slice(0, 100)}`);
      }
      scores = JSON.parse(match[0]);
    }

    // Pad or truncate to match document count
    if (scores.length < documents.length) {
      scores.push(...new Array(documents.length - scores.length).fill(0));
    } else if (scores.length > documents.length) {
      scores = scores.slice(0, documents.length);
    }

    // Normalise to 0–1 just in case the model outputs 0–10
    const max = Math.max(...scores);
    return max > 1 ? scores.map((s) => s / max) : scores;
  }

  /**
   * Jina backend: calls the Jina AI Reranker API.
   * Model: jina-reranker-v3 (best BEIR NDCG@10 at 61.94, free tier 10M tokens).
   */
  private async rerankJina(query: string, documents: string[]): Promise<number[]> {
    const res = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.jinaApiKey}`,
      },
      body: JSON.stringify({
        model: 'jina-reranker-v3',
        query,
        documents,
        top_n: documents.length,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`Jina rerank HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const scores = new Array(documents.length).fill(0);
    for (const result of data.results ?? []) {
      scores[result.index] = result.relevance_score;
    }
    return scores;
  }
}
