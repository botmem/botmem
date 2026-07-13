import { z } from 'zod';
import type { QueryEmbedding, QueryEmbeddingPort } from './postgres-ports.js';

const PROFILE_ID = 'hosted-multilingual-v1' as const;
const DIMENSIONS = 768;
const MAX_BATCH = 64;
const MAX_INPUT_CODE_POINTS = 8_000;
const MAX_BATCH_CODE_POINTS = 256_000;

const responseSchema = z
  .object({
    model: z.string().trim().min(1).max(256),
    data: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          embedding: z.array(z.number().finite()).length(DIMENSIONS),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface OpenAiEmbeddingOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Hosted-only multilingual embeddings; local message content never uses this adapter. */
export class OpenAiEmbeddingProvider implements QueryEmbeddingPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: OpenAiEmbeddingOptions) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || 'text-embedding-3-small';
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/embeddings';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) throw new Error('global fetch is unavailable');
    this.fetch = fetchImplementation.bind(globalThis);
    if (!/^sk-[A-Za-z0-9_-]{16,}$/u.test(this.apiKey)) {
      throw new Error('OpenAI API key is malformed');
    }
    if (!/^text-embedding-3-[A-Za-z0-9._-]+$/u.test(this.model)) {
      throw new Error('OpenAI embedding model must support explicit dimensions');
    }
    const endpoint = new URL(this.endpoint);
    const loopbackTestEndpoint = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
    if (
      (endpoint.protocol !== 'https:' && !loopbackTestEndpoint) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    ) {
      throw new Error('OpenAI embedding endpoint must use credential-free HTTPS');
    }
    if (this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new RangeError('OpenAI embedding timeout must be between 100 and 30000ms');
    }
  }

  async embed(query: string, signal: AbortSignal): Promise<QueryEmbedding> {
    const [embedding] = await this.embedMany([query], signal);
    if (!embedding) throw new OpenAiEmbeddingError('embedding_response_empty');
    return embedding;
  }

  async embedMany(
    inputs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly QueryEmbedding[]> {
    validateInputs(inputs);
    throwIfAborted(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new OpenAiEmbeddingError('embedding_timeout')),
      this.timeoutMs,
    );
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          dimensions: DIMENSIONS,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new OpenAiEmbeddingError('embedding_provider_rejected');
      const parsed = responseSchema.parse(await response.json());
      if (parsed.data.length !== inputs.length) {
        throw new OpenAiEmbeddingError('embedding_response_count_mismatch');
      }
      const byIndex = [...parsed.data].sort((left, right) => left.index - right.index);
      if (byIndex.some((item, index) => item.index !== index)) {
        throw new OpenAiEmbeddingError('embedding_response_index_mismatch');
      }
      return Object.freeze(
        byIndex.map((item) =>
          Object.freeze({
            profileId: PROFILE_ID,
            modelRevision: parsed.model,
            values: Object.freeze([...item.embedding]),
          }),
        ),
      );
    } catch (error) {
      if (error instanceof OpenAiEmbeddingError) throw error;
      if (controller.signal.aborted) {
        throw new OpenAiEmbeddingError(
          signal.aborted ? 'embedding_cancelled' : 'embedding_timeout',
        );
      }
      throw new OpenAiEmbeddingError('embedding_response_invalid');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}

export class OpenAiEmbeddingError extends Error {
  override readonly name = 'OpenAiEmbeddingError';

  constructor(readonly code: string) {
    super(code);
  }
}

function validateInputs(inputs: readonly string[]): void {
  if (inputs.length < 1 || inputs.length > MAX_BATCH) {
    throw new OpenAiEmbeddingError('embedding_batch_size_invalid');
  }
  let total = 0;
  for (const input of inputs) {
    const length = [...input].length;
    if (!input.trim() || length > MAX_INPUT_CODE_POINTS) {
      throw new OpenAiEmbeddingError('embedding_input_invalid');
    }
    total += length;
  }
  if (total > MAX_BATCH_CODE_POINTS) {
    throw new OpenAiEmbeddingError('embedding_batch_too_large');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OpenAiEmbeddingError('embedding_cancelled');
}
