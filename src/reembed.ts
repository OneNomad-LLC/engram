import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
import type { StoredChunk } from './storage.js';
import { embed, getEmbeddingModelName, getEmbeddingModelProfile, LEGACY_EMBEDDING_MODEL } from './llm.js';
import { buildContextPrefix } from './utils.js';

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

const META_FILE = 'embedding-meta.json';

export function readEmbeddingMeta(dataDir: string): EmbeddingMeta | null {
  const path = join(dataDir, META_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.model === 'string') return parsed as EmbeddingMeta;
  } catch { /* corrupt marker treated as absent */ }
  return null;
}

export function writeEmbeddingMeta(dataDir: string, dimensions: number): void {
  const meta: EmbeddingMeta = {
    model: getEmbeddingModelName(),
    dimensions,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dataDir, META_FILE), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

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
export async function checkEmbeddingMeta(
  config: SmartMemoryConfig,
  storage: Storage
): Promise<EmbeddingMetaCheck> {
  const current = getEmbeddingModelName();
  const meta = readEmbeddingMeta(config.dataDir);

  if (meta) {
    return { mismatch: meta.model !== current, storedModel: meta.model, currentModel: current };
  }

  const chunks = await storage.listChunks();
  if (chunks.length === 0) {
    // Fresh store: stamp the active model so future swaps are detected.
    writeEmbeddingMeta(config.dataDir, config.embeddingDimensions);
    return { mismatch: false, storedModel: null, currentModel: current };
  }

  return {
    mismatch: current !== LEGACY_EMBEDDING_MODEL,
    storedModel: null,
    currentModel: current,
  };
}

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
export async function reembedAll(
  config: SmartMemoryConfig,
  storage: Storage,
  onProgress?: (done: number, total: number) => void
): Promise<ReembedStats> {
  const profile = getEmbeddingModelProfile();
  const chunks = await storage.listChunks();
  const targets = chunks.filter(c => c.consolidationLevel !== -1);
  const stats: ReembedStats = { total: targets.length, reembedded: 0, skipped: 0, failed: 0 };

  // Buffer re-embedded chunks and flush in bulk. The original per-row
  // updateChunk loop is exactly what bloated a live store from 260MB to
  // 3.9GB — each update wrote a new fragment with no compaction, and two
  // full passes left thousands of dead versions behind.
  const FLUSH_EVERY = 500;
  let pending: StoredChunk[] = [];
  let done = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    await storage.updateChunks(pending);
    pending = [];
  };

  for (const chunk of targets) {
    done++;
    try {
      const prefix = buildContextPrefix(chunk);
      const embedding = await embed(config, chunk.content, prefix);
      if (embedding.length === 0) {
        // embed() swallows model failures and returns []. Don't zero out
        // a stored vector over a transient failure.
        stats.failed++;
        continue;
      }
      chunk.embedding = embedding;
      chunk.embeddingVersion = profile.version;
      pending.push(chunk);
      stats.reembedded++;
      if (pending.length >= FLUSH_EVERY) await flush();
    } catch {
      stats.failed++;
    }
    if (onProgress && (done % 50 === 0 || done === targets.length)) {
      onProgress(done, targets.length);
    }
  }
  await flush();

  // Reclaim: prune every old version (0 = keep only current). reembed is a
  // single-process CLI op with no concurrent writer, so deleteUnverified is
  // safe and turns the post-reembed store back to its compact size.
  await storage.optimizeChunks(0, true);

  // Only stamp the marker when the corpus actually made it into the new
  // space. A partial run keeps the old marker so the boot warning stays.
  if (stats.failed === 0) {
    writeEmbeddingMeta(config.dataDir, config.embeddingDimensions);
  }

  return stats;
}
