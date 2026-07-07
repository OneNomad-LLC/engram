import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
/**
 * Embedding-space tracking + re-embed migration.
 *
 * Stored vectors live in the space of whatever model embedded them.
 * Swapping the model without re-embedding leaves queries in one space
 * and the corpus in another: search doesn't error, it just quietly
 * returns garbage rankings. This module closes DEBT-008.
 *
 * A marker file (<dataDir>/embedding-meta.json) records which model the
 * corpus was last embedded with. The server checks it at boot and warns
 * loudly on mismatch; `przm-memory-mcp reembed` rewrites every stored
 * vector with the current model and updates the marker.
 */
export interface EmbeddingMeta {
    model: string;
    dimensions: number;
    updatedAt: string;
}
export declare function readEmbeddingMeta(dataDir: string): EmbeddingMeta | null;
export declare function writeEmbeddingMeta(dataDir: string, dimensions: number): void;
export interface EmbeddingMetaCheck {
    /** True when stored vectors are (or must be assumed) in a different model's space. */
    mismatch: boolean;
    /** Model the corpus was embedded with. Null = empty store or unknown pre-marker legacy. */
    storedModel: string | null;
    currentModel: string;
}
/**
 * Compare the marker against the active model. Stores that predate the
 * marker file get no benefit of the doubt: if the store has chunks but no
 * marker, the corpus was embedded by a pre-v1.1 install whose default was
 * MiniLM, so any other active model counts as a mismatch.
 */
export declare function checkEmbeddingMeta(config: SmartMemoryConfig, storage: Storage): Promise<EmbeddingMetaCheck>;
export interface ReembedStats {
    total: number;
    reembedded: number;
    skipped: number;
    failed: number;
}
/**
 * Re-embed every content chunk with the active model. Parent container
 * chunks (consolidationLevel === -1) carry no embedding and are skipped.
 * Rebuilds each vector with the same contextual prefix ingest would use,
 * so re-embedded chunks stay in the same space as future ingests.
 */
export declare function reembedAll(config: SmartMemoryConfig, storage: Storage, onProgress?: (done: number, total: number) => void): Promise<ReembedStats>;
