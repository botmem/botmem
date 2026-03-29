// ============ Scoring ============
export const MIN_SCORE = 0.35;
export const HYBRID_K_MULTIPLIER = 3;
export const HYBRID_K_CAP = 250;
export const INJECTED_CONTACT_BASELINE = 0.4;
export const CONTACT_BOOST_MIXED = 1.2;
export const CONTACT_BOOST_PURE_MULTI = 1.3;
export const RECENCY_DECAY_RATE = 0.005;
export const DIVERSITY_FACTOR_DEFAULT = 0.25;

// ============ Scoring Profiles ============
export const SCORING_PROFILES = {
  browse: {
    semantic: 0.25,
    rerank: 0,
    recency: 0.4,
    importance: 0.1,
    trust: 0.05,
    semanticCap: 0.5,
    recencyCap: 0.6,
  },
  recall: {
    semantic: 0.4,
    rerank: 0,
    recency: 0.4,
    importance: 0.1,
    trust: 0.05,
    semanticCap: 0.6,
    recencyCap: 0.6,
  },
  recallRerank: {
    semantic: 0.4,
    rerank: 0.3,
    recency: 0.15,
    importance: 0.1,
    trust: 0.05,
    semanticCap: 0.7,
    recencyCap: 0.4,
  },
  recallRerankNoSemantic: {
    semantic: 0.7,
    rerank: 0,
    recency: 0.15,
    importance: 0.1,
    trust: 0.05,
    semanticCap: 0.85,
    recencyCap: 0.4,
  },
} as const;

// ============ Graph ============
export const GRAPH_GROUP_STRENGTH = 0.9;
export const GRAPH_DIRECT_STRENGTH = 0.7;
export const GRAPH_LINK_SCORE = 0.5;
export const GRAPH_VECTOR_WEIGHT = 0.3;
export const GRAPH_BASE_SCORE = 0.2;

// ============ Linking ============
export const SUPPORTS_THRESHOLD = 0.92;
export const CONTRADICTS_THRESHOLD = 0.85;
export const DEFAULT_CONFIDENCE = 0.5;
export const PHOTO_PEOPLE_CONFIDENCE = 0.9;
export const CORROBORATION_SINGLE_CONFIDENCE = 0.8;
export const CORROBORATION_MULTI_CONFIDENCE = 0.9;
export const SAME_CONNECTOR_BOOST_CONFIDENCE = 0.65;

// ============ Typesense ============
export const HYBRID_ALPHA = 0.3;
export const QUERY_BY_WEIGHTS = '3,1,1';
