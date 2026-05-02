SET max_parallel_maintenance_workers = 0;
SET maintenance_work_mem = '32MB';

CREATE INDEX IF NOT EXISTS idx_memory_search_embedding_hnsw_3072
ON memory_search_index
USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
WHERE embedding IS NOT NULL AND embedding_dimension = 3072;
