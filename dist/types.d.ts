export type MemoryTier = 'scratch' | 'daily' | 'short-term' | 'long-term' | 'archive';
export type MemoryType = 'fact' | 'preference' | 'decision' | 'context' | 'correction';
export type CognitiveLayer = 'episodic' | 'semantic' | 'procedural';
export type Sentiment = 'frustrated' | 'curious' | 'satisfied' | 'neutral' | 'excited' | 'confused';
export type MemoryOrigin = 'user' | 'derived' | 'extracted' | 'imported';
export interface MemoryChunk {
    id: string;
    tier: MemoryTier;
    content: string;
    type: MemoryType;
    cognitiveLayer: CognitiveLayer;
    tags: string[];
    domain: string;
    topic: string;
    source: string;
    importance: number;
    sentiment: Sentiment;
    createdAt: string;
    lastRecalledAt: string | null;
    recallCount: number;
    embedding?: number[];
    stability?: number;
    difficulty?: number;
    temporalAnchor?: number;
    consolidationLevel?: number;
    sourceChunkIds?: string[];
    embeddingVersion?: number;
    parentChunkId?: string;
    origin?: MemoryOrigin;
}
export interface MemoryEdge {
    targetId: string;
    relationship: 'temporal' | 'semantic' | 'causal' | 'co-recalled';
    weight: number;
    createdAt: string;
}
export interface RecallOutcome {
    conversationId: string;
    outcome: 'helpful' | 'corrected' | 'irrelevant';
    timestamp: string;
}
export interface ProceduralRule {
    id: string;
    rule: string;
    domain: 'code' | 'communication' | 'workflow' | 'preference' | 'general';
    confidence: number;
    reinforcements: number;
    contradictions: number;
    evidence: string[];
    createdAt: string;
    updatedAt: string;
}
export interface KnowledgeTriple {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    source: string;
    confidence: number;
    validFrom: string;
    validTo: string | null;
    createdAt: string;
}
export interface DiaryEntry {
    date: string;
    time: string;
    content: string;
    agent: string;
}
export interface DailyLogEntry {
    timestamp: string;
    conversationId: string;
    summary: string;
    extractedFacts: string[];
}
export interface SearchResult {
    chunk: MemoryChunk;
    /** Composite ranking score. Under RRF (the default) this is a rank-fusion
     *  value in the ~0.003-0.07 band — it orders results but is NOT a 0..1
     *  relevance. Use vectorSimilarity for absolute thresholds. */
    score: number;
    /** Raw vector-stage cosine similarity (0..1), present when the chunk
     *  passed the vector stage. Absent for keyword-only / graph-walk hits. */
    vectorSimilarity?: number;
}
export interface SmartMemoryConfig {
    /** Root data directory (default: ~/.claude/engram) */
    dataDir: string;
    /** Days before daily tier moves to short-term (default: 2) */
    dailyRetentionDays: number;
    /** Days before short-term promotes to long-term if recalled (default: 14) */
    shortTermRetentionDays: number;
    /** Days before long-term demotes to archive if stale (default: 90) */
    longTermRetentionDays: number;
    /** Max chunks to return per search (default: 10) */
    maxRecallChunks: number;
    /** Max tokens budget for recalled memories (default: 1500) */
    maxRecallTokens: number;
    /** Minimum messages before triggering extraction (default: 3) */
    extractionThreshold: number;
    /** Mem0 API key (optional -- enables Mem0 cloud extraction) */
    mem0ApiKey: string;
    /** Mem0 user ID for scoping memories (default: 'default') */
    mem0UserId: string;
    /** Extraction provider: 'local' or 'mem0' or 'both' (default: 'local') */
    extractionProvider: 'local' | 'mem0' | 'both';
    /** Use Reciprocal Rank Fusion for hybrid search merging (default: true) */
    enableRRF: boolean;
    /** Use FSRS spaced repetition for importance decay (default: true) */
    enableFSRS: boolean;
    /** Prepend contextual prefix to chunks before embedding (default: true) */
    enableContextualPrefix: boolean;
    /** Prioritize consolidation by importance * recency * surprise (default: true) */
    enableBiasedReplay: boolean;
    /** Use cross-encoder model for reranking (default: false, requires model download) */
    enableCrossEncoderRerank: boolean;
    /** Cluster episodic memories into semantic summaries (default: true) */
    enableEpisodicConsolidation: boolean;
    /** Embedding dimensions for Matryoshka truncation (default: 384 for backward compat) */
    embeddingDimensions: number;
    /** Split long content into focused sub-chunks at ingest time (default: true) */
    enableChunking: boolean;
    /** Persist diagnostic retrieval traces under <dataDir>/traces (default: false).
     *  When enabled, every search() call writes a JSON trace capturing the query,
     *  per-stage candidate counts, final result IDs, and total latency. */
    enableRetrievalTraces: boolean;
    /** Days to keep retrieval traces before garbage collection (default: 7). */
    retrievalTraceRetentionDays: number;
}
export declare const DEFAULT_CONFIG: SmartMemoryConfig;
