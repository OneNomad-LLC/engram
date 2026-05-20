import type { SmartMemoryConfig } from './types.js';
export declare function isLlmAvailable(): boolean;
export declare function llmComplete(_config: SmartMemoryConfig, systemPrompt: string, userMessage: string, opts?: {
    maxTokens?: number;
    temperature?: number;
}): Promise<string>;
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
