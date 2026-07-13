export interface SqlQueryConfig {
  readonly text: string;
  readonly values?: readonly unknown[];
  readonly signal?: AbortSignal;
}

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/** Narrow structural port implemented by a PostgreSQL pool client adapter. */
export interface SqlClientPort {
  query<Row = Record<string, unknown>>(config: SqlQueryConfig): Promise<SqlQueryResult<Row>>;
  release(destroy?: boolean): void;
}

export interface SqlPoolPort {
  connect(): Promise<SqlClientPort>;
}

export interface QueryEmbedding {
  readonly profileId: 'hosted-multilingual-v1';
  readonly modelRevision: string;
  readonly values: readonly number[];
}

/** Provider/model details stay outside the search domain and database adapter. */
export interface QueryEmbeddingPort {
  embed(query: string, signal: AbortSignal): Promise<QueryEmbedding>;
}

export interface HostedSearchClockPort {
  now(): string;
}
