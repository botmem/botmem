import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import Typesense from 'typesense';
import type { Client as TypesenseClient } from 'typesense';
import { ConfigService } from '../config/config.service';

export interface ScoredPoint {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

const COLLECTION_NAME = 'memories';

@Injectable()
export class TypesenseService implements OnModuleInit {
  private readonly logger = new Logger(TypesenseService.name);
  private client: TypesenseClient;

  constructor(private config: ConfigService) {
    const url = new URL(config.typesenseUrl);
    this.client = new Typesense.Client({
      nodes: [
        {
          host: url.hostname,
          port: parseInt(url.port || (url.protocol === 'https:' ? '443' : '8108'), 10),
          protocol: url.protocol.replace(':', ''),
        },
      ],
      apiKey: config.typesenseApiKey,
      connectionTimeoutSeconds: 5,
    });
  }

  async onModuleInit() {
    try {
      await this.ensureCollection(this.config.embedDimension);
    } catch (err) {
      this.logger.error(
        'Typesense collection init failed (will retry on first embed)',
        err instanceof Error ? err.stack : String(err),
      );
    }
    // Seed search enhancements (best-effort, don't block startup)
    Promise.all([this.seedSynonyms(), this.seedStopwords(), this.seedConversationModel()]).catch(
      (err) => this.logger.warn('Seeding failed', err instanceof Error ? err.message : String(err)),
    );
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    try {
      const collection = await this.client.collections(COLLECTION_NAME).retrieve();
      const embeddingField = collection.fields?.find((f) => f.name === 'embedding');
      if (embeddingField && (embeddingField as Record<string, unknown>).num_dim !== vectorSize) {
        throw new Error(
          `Typesense collection "memories" has vector dimension ${(embeddingField as Record<string, unknown>).num_dim} but configured EMBED_DIMENSION is ${vectorSize}. ` +
            `Either delete the collection and re-sync, or set EMBED_DIMENSION to match.`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Typesense collection')) throw err;
      const isNotFound =
        (err as { httpStatus?: number }).httpStatus === 404 ||
        (err instanceof Error && err.message.includes('Not Found'));
      if (!isNotFound) throw err;

      await this.client.collections().create({
        name: COLLECTION_NAME,
        fields: [
          { name: 'text', type: 'string' as const, optional: true },
          { name: 'connector_type', type: 'string' as const, facet: true },
          { name: 'source_type', type: 'string' as const, facet: true },
          { name: 'event_time', type: 'string' as const, optional: true },
          { name: 'account_id', type: 'string' as const, optional: true },
          { name: 'memory_bank_id', type: 'string' as const, optional: true },
          { name: 'factuality_label', type: 'string' as const, facet: true, optional: true },
          { name: 'people', type: 'string[]' as const, facet: true, optional: true },
          { name: 'pinned', type: 'bool' as const, facet: true, optional: true },
          { name: 'importance', type: 'float' as const, optional: true },
          { name: 'entities_text', type: 'string' as const, optional: true },
          { name: 'embedding', type: 'float[]' as const, num_dim: vectorSize },
        ],
      });
      this.logger.log(`Created Typesense collection "memories" with ${vectorSize}d vectors`);
    }
  }

  async upsert(
    memoryId: string,
    vector: number[],
    payload: Record<string, unknown>,
    retries = 2,
  ): Promise<void> {
    const flat = this.flattenPayload(payload);
    const doc: Record<string, unknown> = {
      id: memoryId,
      embedding: vector,
      pinned: false,
      ...flat,
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.client.collections(COLLECTION_NAME).documents().upsert(doc);
        return;
      } catch (err: unknown) {
        const status = (err as { httpStatus?: number }).httpStatus;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 404 || msg.includes('Not Found')) {
          await this.ensureCollection(vector.length);
          continue;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<ScoredPoint[]> {
    try {
      const searchParams: Record<string, unknown> = {
        searches: [
          {
            collection: COLLECTION_NAME,
            q: '*',
            vector_query: `embedding:([${vector.join(',')}], k:${limit})`,
            per_page: limit,
            ...(filter ? { filter_by: this.buildTypesenseFilter(filter) } : {}),
          },
        ],
      };

      const results = await this.client.multiSearch.perform(
        searchParams as unknown as Parameters<typeof this.client.multiSearch.perform>[0],
        {},
      );

      const hits = (results.results?.[0] as Record<string, unknown>)?.hits as
        | Array<{ document: Record<string, unknown>; vector_distance?: number }>
        | undefined;
      if (!hits) return [];

      return hits.map((hit) => ({
        id: hit.document.id as string,
        score: 1 - (hit.vector_distance ?? 0), // Convert distance to similarity
        payload: this.extractPayload(hit.document),
      }));
    } catch (err: unknown) {
      const status = (err as { httpStatus?: number }).httpStatus;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 404 || msg.includes('Not Found')) {
        await this.ensureCollection(vector.length);
        return [];
      }
      throw err;
    }
  }

  async recommend(
    memoryId: string,
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<ScoredPoint[]> {
    try {
      const doc = await this.client.collections(COLLECTION_NAME).documents(memoryId).retrieve();
      const embedding = (doc as unknown as Record<string, unknown>).embedding as
        | number[]
        | undefined;
      if (!embedding) return [];

      // Search using the document's embedding, excluding self
      const filterStr = filter ? this.buildTypesenseFilter(filter) : '';
      const selfFilter = `id:!=${memoryId}`;
      const combinedFilter = filterStr ? `${selfFilter} && ${filterStr}` : selfFilter;

      const searchParams: Record<string, unknown> = {
        searches: [
          {
            collection: COLLECTION_NAME,
            q: '*',
            vector_query: `embedding:([${embedding.join(',')}], k:${limit})`,
            filter_by: combinedFilter,
            per_page: limit,
          },
        ],
      };

      const results = await this.client.multiSearch.perform(
        searchParams as unknown as Parameters<typeof this.client.multiSearch.perform>[0],
        {},
      );

      const hits = (results.results?.[0] as Record<string, unknown>)?.hits as
        | Array<{ document: Record<string, unknown>; vector_distance?: number }>
        | undefined;
      if (!hits) return [];

      return hits.map((hit) => ({
        id: hit.document.id as string,
        score: 1 - (hit.vector_distance ?? 0),
        payload: this.extractPayload(hit.document),
      }));
    } catch {
      return [];
    }
  }

  async getCollectionInfo(): Promise<{
    pointsCount: number;
    indexedVectorsCount: number;
    status: string;
  }> {
    try {
      const info = await this.client.collections(COLLECTION_NAME).retrieve();
      const numDocs = (info as unknown as Record<string, unknown>).num_documents as number;
      return {
        pointsCount: numDocs ?? 0,
        indexedVectorsCount: numDocs ?? 0,
        status: 'ready',
      };
    } catch {
      return { pointsCount: 0, indexedVectorsCount: 0, status: 'not_found' };
    }
  }

  async pointExists(id: string): Promise<boolean> {
    try {
      await this.client.collections(COLLECTION_NAME).documents(id).retrieve();
      return true;
    } catch {
      return false;
    }
  }

  async setPayload(
    payload: Record<string, unknown>,
    filter: Record<string, unknown>,
  ): Promise<void> {
    // Best-effort: extract ID from filter and update that document
    try {
      const mustClauses = (filter as { must?: Array<{ key: string; match: { value: unknown } }> })
        .must;
      if (!mustClauses) return;
      const idClause = mustClauses.find((c) => c.key === 'id' || c.key === 'memory_id');
      if (idClause?.match?.value) {
        const docId = String(idClause.match.value);
        await this.client
          .collections(COLLECTION_NAME)
          .documents(docId)
          .update(this.flattenPayload(payload));
      }
    } catch {
      // Best-effort — ignore failures
    }
  }

  async conversationSearch(
    query: string,
    vector: number[],
    limit: number,
    conversationModelId: string,
    conversationId?: string,
    filter?: Record<string, unknown>,
  ): Promise<{
    results: ScoredPoint[];
    conversation?: { answer: string; conversationId: string };
  }> {
    const filterStr = filter ? this.buildTypesenseFilter(filter) : undefined;

    const searchParams: Record<string, unknown> = {
      searches: [
        {
          collection: COLLECTION_NAME,
          q: query,
          query_by: 'text',
          vector_query: `embedding:([${vector.join(',')}], k:${limit}, alpha:0.5)`,
          per_page: limit,
          conversation: true,
          conversation_model_id: conversationModelId,
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(filterStr ? { filter_by: filterStr } : {}),
        },
      ],
    };

    const response = await this.client.multiSearch.perform(
      searchParams as unknown as Parameters<typeof this.client.multiSearch.perform>[0],
      {},
    );

    const firstResult = response.results?.[0] as Record<string, unknown> | undefined;
    const hits = firstResult?.hits as
      | Array<{ document: Record<string, unknown>; vector_distance?: number }>
      | undefined;

    const results: ScoredPoint[] = (hits ?? []).map((hit) => ({
      id: hit.document.id as string,
      score: 1 - (hit.vector_distance ?? 0),
      payload: this.extractPayload(hit.document),
    }));

    // Extract conversation data from the response
    const conversationData = (response as Record<string, unknown>).conversation as
      | { answer?: string; conversation_id?: string }
      | undefined;

    return {
      results,
      ...(conversationData?.answer
        ? {
            conversation: {
              answer: conversationData.answer,
              conversationId: conversationData.conversation_id ?? '',
            },
          }
        : {}),
    };
  }

  async hybridSearch(
    query: string,
    vector: number[],
    limit: number,
    filterBy?: string,
    facetBy?: string,
  ): Promise<{
    results: ScoredPoint[];
    facetCounts: Array<{ field_name: string; counts: Array<{ value: string; count: number }> }>;
    found: number;
  }> {
    try {
      const searchParams: Record<string, unknown> = {
        searches: [
          {
            collection: COLLECTION_NAME,
            q: query || '*',
            query_by: 'text,entities_text,people',
            query_by_weights: '3,1,1',
            vector_query: `embedding:([${vector.join(',')}], k:${limit}, alpha:0.5)`,
            per_page: limit,
            highlight_full_fields: 'text',
            highlight_start_tag: '<mark>',
            highlight_end_tag: '</mark>',
            exclude_fields: 'embedding',
            ...(filterBy ? { filter_by: filterBy } : {}),
            ...(facetBy ? { facet_by: facetBy } : {}),
          },
        ],
      };

      const results = await this.client.multiSearch.perform(
        searchParams as unknown as Parameters<typeof this.client.multiSearch.perform>[0],
        {},
      );

      const firstResult = results.results?.[0] as Record<string, unknown> | undefined;
      const hits = firstResult?.hits as
        | Array<{
            document: Record<string, unknown>;
            vector_distance?: number;
            text_match_info?: Record<string, unknown>;
          }>
        | undefined;

      const scoredResults: ScoredPoint[] = (hits ?? []).map((hit) => ({
        id: hit.document.id as string,
        score: 1 - (hit.vector_distance ?? 0),
        payload: this.extractPayload(hit.document),
      }));

      const facetCounts =
        (firstResult?.facet_counts as Array<{
          field_name: string;
          counts: Array<{ value: string; count: number }>;
        }>) ?? [];
      const found = (firstResult?.found as number) ?? 0;

      return { results: scoredResults, facetCounts, found };
    } catch (err: unknown) {
      const status = (err as { httpStatus?: number }).httpStatus;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 404 || msg.includes('Not Found')) {
        await this.ensureCollection(vector.length);
        return { results: [], facetCounts: [], found: 0 };
      }
      throw err;
    }
  }

  buildFilterString(filters: {
    connectorTypes?: string[];
    sourceTypes?: string[];
    factualityLabels?: string[];
    personNames?: string[];
    timeRange?: { from?: string; to?: string };
    pinned?: boolean;
    accountIds?: string[];
    memoryBankId?: string;
    memoryBankIds?: string[];
  }): string {
    const parts: string[] = [];

    if (filters.connectorTypes?.length) {
      parts.push(`connector_type:[${filters.connectorTypes.join(',')}]`);
    }
    if (filters.sourceTypes?.length) {
      parts.push(`source_type:[${filters.sourceTypes.join(',')}]`);
    }
    if (filters.factualityLabels?.length) {
      parts.push(`factuality_label:[${filters.factualityLabels.join(',')}]`);
    }
    if (filters.personNames?.length) {
      const escaped = filters.personNames.map((n) => '`' + n + '`');
      parts.push(`people:[${escaped.join(',')}]`);
    }
    if (filters.timeRange?.from) {
      parts.push(`event_time:>=${filters.timeRange.from}`);
    }
    if (filters.timeRange?.to) {
      parts.push(`event_time:<=${filters.timeRange.to}`);
    }
    if (filters.pinned === true) {
      parts.push('pinned:=true');
    }
    if (filters.accountIds?.length) {
      parts.push(`account_id:[${filters.accountIds.join(',')}]`);
    }
    if (filters.memoryBankId) {
      parts.push(`memory_bank_id:=${filters.memoryBankId}`);
    } else if (filters.memoryBankIds?.length) {
      parts.push(`memory_bank_id:[${filters.memoryBankIds.join(',')}]`);
    }

    return parts.join(' && ');
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.health.retrieve();
      return true;
    } catch {
      return false;
    }
  }

  async remove(memoryId: string): Promise<void> {
    try {
      await this.client.collections(COLLECTION_NAME).documents(memoryId).delete();
    } catch (err: unknown) {
      const status = (err as { httpStatus?: number }).httpStatus;
      if (status === 404) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not Found')) return;
      throw err;
    }
  }

  private async seedSynonyms(): Promise<void> {
    const synonyms = [
      { id: 'msg-message', synonyms: ['msg', 'message', 'messages', 'dm', 'dms'] },
      {
        id: 'pic-photo',
        synonyms: ['pic', 'photo', 'image', 'picture', 'photos', 'pictures', 'images'],
      },
      { id: 'email-mail', synonyms: ['email', 'mail', 'emails', 'mails'] },
      { id: 'call-phone', synonyms: ['call', 'phone', 'ring', 'dial'] },
      { id: 'loc-location', synonyms: ['location', 'place', 'spot', 'where', 'address'] },
    ];
    for (const syn of synonyms) {
      try {
        await this.client
          .collections(COLLECTION_NAME)
          .synonyms()
          .upsert(syn.id, { synonyms: syn.synonyms });
      } catch {
        /* best effort */
      }
    }
  }

  private async seedStopwords(): Promise<void> {
    const stopwords = [
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'am',
      'do',
      'does',
      'did',
      'has',
      'have',
      'had',
      'i',
      'me',
      'my',
      'we',
      'our',
      'you',
      'your',
      'it',
      'its',
      'he',
      'she',
      'his',
      'her',
      'they',
      'them',
      'their',
      'this',
      'that',
      'of',
      'in',
      'to',
      'for',
      'on',
      'at',
      'by',
      'with',
    ];
    try {
      await this.client.stopwords().upsert('botmem-stops', { stopwords, locale: 'en' });
    } catch {
      /* best effort */
    }
  }

  private async seedConversationModel(): Promise<void> {
    const apiKey = this.config.openrouterApiKey;
    if (!apiKey) return; // Skip if no API key available

    // Ensure conversation_store collection exists
    try {
      await this.client.collections('conversation_store').retrieve();
    } catch {
      try {
        await this.client.collections().create({
          name: 'conversation_store',
          fields: [{ name: '.*', type: 'auto' as const }],
          enable_nested_fields: true,
        });
      } catch {
        /* may already exist from race */
      }
    }

    // Create/update conversation model via raw API
    try {
      const url = new URL(this.config.typesenseUrl);
      const baseUrl = `${url.protocol}//${url.host}`;
      const modelConfig = {
        id: 'botmem-chat',
        model_name: 'openai/gpt-4o-mini',
        api_key: apiKey,
        system_prompt:
          "You are a personal memory assistant. Answer questions using ONLY the provided search results from the user's personal data. Cite sources by connector type and date. If the information is not in the results, say so.",
        max_bytes: 16384,
        history_collection: 'conversation_store',
        account_id: 'botmem',
      };
      await fetch(`${baseUrl}/conversations/models`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TYPESENSE-API-KEY': this.config.typesenseApiKey,
        },
        body: JSON.stringify(modelConfig),
      });
      this.logger.log('Seeded conversation model "botmem-chat"');
    } catch {
      /* best effort — model may already exist */
    }
  }

  private buildTypesenseFilter(filter: Record<string, unknown>): string {
    const parts: string[] = [];

    const mustClauses = (filter as { must?: Array<Record<string, unknown>> }).must;
    if (mustClauses) {
      for (const clause of mustClauses) {
        const key = clause.key as string;
        if (!key) continue;

        // Match filter: { key: 'field', match: { value: 'val' } }
        const match = clause.match as { value?: unknown } | undefined;
        if (match?.value !== undefined) {
          parts.push(`${key}:=${match.value}`);
          continue;
        }

        // Range filter: { key: 'field', range: { gte: '...', lte: '...' } }
        const range = clause.range as
          | { gte?: string; lte?: string; gt?: string; lt?: string }
          | undefined;
        if (range) {
          if (range.gte) parts.push(`${key}:>=${range.gte}`);
          if (range.lte) parts.push(`${key}:<=${range.lte}`);
          if (range.gt) parts.push(`${key}:>${range.gt}`);
          if (range.lt) parts.push(`${key}:<${range.lt}`);
        }
      }
    }

    const shouldClauses = (filter as { should?: Array<Record<string, unknown>> }).should;
    if (shouldClauses) {
      const orParts: string[] = [];
      for (const clause of shouldClauses) {
        const key = clause.key as string;
        const match = clause.match as { value?: unknown } | undefined;
        if (key && match?.value !== undefined) {
          orParts.push(`${key}:=${match.value}`);
        }
      }
      if (orParts.length) {
        parts.push(`(${orParts.join(' || ')})`);
      }
    }

    return parts.join(' && ');
  }

  private flattenPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'embedding') continue; // Don't overwrite embedding field
      if (value === null || value === undefined) continue;
      flat[key] = typeof value === 'object' ? JSON.stringify(value) : value;
    }
    return flat;
  }

  private extractPayload(document: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
      if (key === 'id' || key === 'embedding') continue;
      payload[key] = value;
    }
    return payload;
  }
}
