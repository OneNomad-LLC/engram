import type { SmartMemoryConfig } from './types.js';
export declare function isLlmAvailable(): boolean;
export declare function llmComplete(_config: SmartMemoryConfig, systemPrompt: string, userMessage: string, opts?: {
    maxTokens?: number;
    temperature?: number;
}): Promise<string>;
export declare const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
/** Default before v1.1 — stores created back then hold vectors in this model's space. */
export declare const LEGACY_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export declare function getEmbeddingModelName(): string;
/**
 * Model-family retrieval profile. Cosine-similarity distributions differ
 * by model family: MiniLM-class models put unrelated pairs near 0.1-0.3,
 * BGE v1.5 compresses everything into a higher band (unrelated pairs sit
 * around 0.5-0.65). Floors and duplicate thresholds must shift with the
 * model or they either pass everything or block everything.
 *
 * BGE v1.5 is also asymmetric: short queries need the instruction prefix
 * the model was trained with; passages embed bare. MiniLM is symmetric,
 * where the lightweight 'search query: ' prefix only applies when
 * contextual prefixes are enabled (the space its floor was calibrated in).
 */
export interface EmbeddingModelProfile {
    /** Instruction prepended to query-side embeds. */
    queryPrefix: string;
    /** True when the model requires the query prefix regardless of the contextual-prefix flag. */
    alwaysPrefixQuery: boolean;
    /** Vector-stage similarity floor for standard queries. */
    similarityFloor: number;
    /** Floor for preference/recommendation queries (embed far from concrete content). */
    preferenceFloor: number;
    /** Floor for aggregation queries (answer needs N chunks, not one match). */
    aggregationFloor: number;
    /** Ingest dedupe: cosine similarity above which content counts as a near-duplicate. */
    dupCheck: number;
    /** Dedupe recommendation ladder: reinforce-existing threshold. */
    dupReinforce: number;
    /** Dedupe recommendation ladder: accept-existing threshold. */
    dupAccept: number;
    /** Small int stamped on chunks as embeddingVersion (1=MiniLM-384, 2=nomic-256, 3=bge-small-384). */
    version: number;
}
export declare function getEmbeddingModelProfile(modelName?: string): EmbeddingModelProfile;
/**
 * Trigger the embedding model load in the background so the user's
 * first search query doesn't pay the ~1.5–5s ONNX pipeline-construction
 * cost (or worse: the 10–30s first-time download).
 *
 * Idempotent: shares the same `_extractorLoading` promise as the lazy
 * `getExtractor()` path. Calling this twice does not double-load.
 *
 * No-op when `ENGRAM_SKIP_EMBED=1` is set — callers in that mode have
 * already opted out of embeddings entirely, so eager loading would
 * waste memory and CPU.
 *
 * Returns the loading promise so callers can `await` if they want
 * synchronous readiness; the typical server-boot caller does
 * `void warmEmbeddings()` and lets it run while the MCP handshake
 * settles.
 */
export declare function warmEmbeddings(): Promise<void>;
export declare function embed(config: SmartMemoryConfig, text: string, contextPrefix?: string): Promise<number[]>;
