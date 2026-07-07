import { randomUUID } from 'node:crypto';
import type { SmartMemoryConfig, MemoryType, CognitiveLayer, Sentiment, MemoryOrigin, MemoryTier } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { embed, getEmbeddingModelProfile } from './llm.js';
import { buildContextPrefix } from './utils.js';
import { chunkContent } from './chunker.js';
import { extractAndPersistTriples } from './kg-extractor.js';
import { sourceDedup } from './source-dedup.js';

// Lightweight poisoning patterns checked at ingest time (no LLM, no search)
const POISON_PATTERNS = [
  /\b(ignore previous instructions|ignore all instructions|disregard|forget everything)\b/i,
  /^(system|SYSTEM)\s*:/m,
  /\b(act as|you are now|pretend to be|new persona|new identity)\b/i,
];

function checkContentPoisoning(content: string): string | null {
  for (const pattern of POISON_PATTERNS) {
    if (pattern.test(content)) return 'Suspicious content pattern detected — flagged for review';
  }
  return null;
}

/**
 * Write-Ahead Log (WAL) — real-time memory capture during conversations.
 *
 * The WAL principle: write state BEFORE responding, not after.
 * This ensures no memory is lost if the agent crashes, compacts, or restarts.
 *
 * Use `ingest` for immediate capture of facts/decisions/preferences
 * as they happen, rather than waiting for post-conversation extraction.
 */

export interface IngestEntry {
  content: string;
  type?: MemoryType;
  layer?: CognitiveLayer;
  importance?: number;
  tags?: string[];
  source?: string;
  domain?: string;
  topic?: string;
  sentiment?: Sentiment;
  emotionalValence?: number;  // -1 (negative) to 1 (positive), from Persona bridge
  emotionalArousal?: number;  // 0 to 1, from Persona bridge
  origin?: MemoryOrigin;      // 'user' = explicit ingest, 'derived'/'extracted'/'imported' = auto
  tier?: MemoryTier;          // Override default tier ('scratch' for session-only)
  /**
   * ISO 8601 timestamp override. Default: ingest time (Date.now()).
   *
   * Critical when the content represents an event that originally
   * happened at a different time — meeting notes from yesterday,
   * dated documents, imported chat history, benchmark fixtures.
   *
   * The createdAt timestamp flows into `buildContextPrefix()` which
   * is included in the embedded text. The retrieval pipeline uses
   * this as a temporal signal — both via similarity match against
   * the prefix in queries, and via downstream temporal-boost logic
   * in `search.ts`.
   *
   * Without an override, every ingested memory shares the ingest-
   * time prefix (which is the same for everything ingested in the
   * same hour), losing all temporal differentiation.
   */
  createdAt?: string;
  /**
   * When true, skip the per-chunk KG triple extraction. The standalone
   * locomo bench bypasses this (calls saveChunk directly, never enters
   * wal.ts), which is why its wall-clock is ~50× faster than przm's
   * MCP-boundary bench on the same dataset.
   *
   * Real users keep KG extraction (it powers engram-dossier,
   * engram-kg-query, graph rerank). Benchmark harnesses comparing
   * apples-to-apples vs the standalone bench should pass this flag
   * so they're measuring the same code path.
   */
  skipKgExtraction?: boolean;
  /**
   * When true, skip the post-batch appendDailyEntry write. Same
   * rationale as skipKgExtraction — the standalone bench doesn't
   * touch the daily-entries store; bench harnesses matching it
   * should skip the write to compare on equal footing.
   */
  skipDailyEntry?: boolean;
  /**
   * When false, KG extraction + daily-entry append run in the
   * BACKGROUND after ingest() returns. The caller gets its chunks
   * back as soon as the saveChunk loop finishes; the side effects
   * complete on their own pace.
   *
   * Default true (backwards compatible — caller awaits everything).
   * Production callers where the agent doesn't immediately query
   * the just-written content (chat WAL, tool-vault bridge) should
   * pass false for ~5-30× faster perceived ingest latency.
   *
   * To wait for background work to drain (tests, shutdown), call
   * `flushPendingSideEffects()` from this module.
   */
  awaitSideEffects?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Background side-effect tracking
// ─────────────────────────────────────────────────────────────────────

const pendingSideEffects = new Set<Promise<void>>();

/**
 * Wait for all in-flight background side-effects (KG extraction +
 * daily-entry append fired with `awaitSideEffects: false`) to
 * complete. No-op when nothing is pending.
 *
 * Tests should call this between ingest and assert; shutdown code
 * should call before process exit to avoid losing KG writes.
 */
export async function flushPendingSideEffects(): Promise<void> {
  // Snapshot — new promises added during await won't be drained by
  // this call (they get the next one). Loop until empty in case of
  // long-running chains.
  let attempts = 0;
  while (pendingSideEffects.size > 0 && attempts < 100) {
    const snapshot = Array.from(pendingSideEffects);
    await Promise.allSettled(snapshot);
    attempts++;
  }
}

/** Pending count — for tests + telemetry. */
export function pendingSideEffectCount(): number {
  return pendingSideEffects.size;
}

/**
 * Immediately persist one or more memory entries.
 * Designed to be called mid-conversation, before the agent responds.
 */
export async function ingest(
  config: SmartMemoryConfig,
  storage: Storage,
  entries: IngestEntry[]
): Promise<StoredChunk[]> {
  const chunks: StoredChunk[] = [];
  // Freshly-minted chunks that still need persisting. Cached-source
  // stubs are added to `chunks` (so callers get them back) but skipped
  // here, since the underlying rows are already on disk from a prior
  // ingest. Flushed via storage.saveChunks() in one shot after the
  // entries loop — replaces N round-trips with 1 against the backend.
  const newChunks: StoredChunk[] = [];

  for (const entry of entries) {
    if (!entry.content || entry.content.trim().length < 5) continue;

    const trimmedContent = entry.content.trim();

    // Advisory poisoning check — log warning but never block
    const poisonFlag = checkContentPoisoning(trimmedContent);
    if (poisonFlag) {
      console.error(`przm-memory governance: ${poisonFlag} in "${trimmedContent.slice(0, 80)}..."`);
    }

    // Same-source ingest dedup. When the agent re-reads a stable file
    // or re-polls an unchanged endpoint within the same przm Memory process,
    // we've already chunked + embedded + saved this content. Look up
    // the (source, content-hash) pair in the in-memory cache and short-
    // circuit the rest of the pipeline on a hit. Reuses the prior
    // chunk(s) rather than writing duplicates.
    //
    // Bounded session-scoped cache (max 64 sources × 8 hashes); see
    // source-dedup.ts. Persistence layer doesn't change.
    const cached = sourceDedup.lookup(entry.source, trimmedContent);
    if (cached) {
      // Materialize a chunk reference for the caller from the cached
      // metadata. We don't re-fetch the actual StoredChunk from disk —
      // the caller's response only needs id + content + minimal meta,
      // and the agent's history is keyed off `id`.
      const stub: StoredChunk = {
        id: cached.chunkId,
        tier: entry.tier ?? 'short-term',
        type: entry.type ?? 'context',
        cognitiveLayer: entry.layer ?? 'episodic',
        tags: entry.tags ?? [],
        domain: entry.domain ?? '',
        topic: entry.topic ?? '',
        source: entry.source ?? '',
        importance: entry.importance ?? 0.5,
        sentiment: entry.sentiment ?? 'neutral',
        createdAt: new Date().toISOString(),
        lastRecalledAt: null,
        recallCount: 0,
        relatedMemories: [],
        recallOutcomes: [],
        origin: entry.origin ?? 'derived',
        content: trimmedContent,
      } as StoredChunk;
      chunks.push(stub);
      continue;
    }

    const baseType = entry.type ?? inferType(trimmedContent);
    const baseLayer = entry.layer ?? inferLayer(trimmedContent);
    // Emotion-weighted importance: high-arousal events get stronger encoding
    // Matches amygdala research — negative high-arousal memories form faster (0.8 LR)
    // than positive ones (0.2 LR). Neutral emotions don't modify importance.
    let effectiveImportance = entry.importance ?? 0.5;
    if (entry.emotionalArousal !== undefined && entry.emotionalArousal > 0.3) {
      const valence = entry.emotionalValence ?? 0;
      // Negative-biased boost: negative emotions boost more than positive
      const emotionBoost = entry.emotionalArousal * (valence < 0 ? 0.3 : 0.15);
      effectiveImportance = Math.min(1, effectiveImportance + emotionBoost);
    }

    const baseMeta = {
      tier: entry.tier ?? 'short-term' as MemoryTier,
      type: baseType,
      cognitiveLayer: baseLayer,
      tags: entry.tags ?? [],
      domain: entry.domain ?? '',
      topic: entry.topic ?? '',
      source: entry.source ?? `wal:${Date.now()}`,
      importance: effectiveImportance,
      sentiment: entry.sentiment ?? 'neutral' as Sentiment,
      // Honor caller-provided createdAt (for backfilled memories with
      // a known original time) — defaults to "now" when omitted.
      createdAt: entry.createdAt ?? new Date().toISOString(),
      lastRecalledAt: null,
      recallCount: 0,
      relatedMemories: [],
      recallOutcomes: [],
      origin: entry.origin ?? 'derived' as MemoryOrigin,
    };

    // Check if content should be split into sub-chunks
    const splitResult = config.enableChunking ? chunkContent(trimmedContent) : { chunks: [trimmedContent], needsSplit: false };

    if (splitResult.needsSplit) {
      // Save parent chunk (no embedding, used for keyword search)
      const parentChunk: StoredChunk = {
        id: randomUUID(),
        ...baseMeta,
        content: trimmedContent,
        consolidationLevel: -1, // Sentinel: parent container
      };
      newChunks.push(parentChunk);
      chunks.push(parentChunk);
      // Remember the parent chunk id keyed by source so a re-ingest
      // of the identical content within the same process returns this
      // same id and skips chunk+embed+save entirely.
      sourceDedup.remember(entry.source, trimmedContent, parentChunk.id);

      // Save sub-chunks with embeddings
      for (const subContent of splitResult.chunks) {
        const subChunk: StoredChunk = {
          id: randomUUID(),
          ...baseMeta,
          content: subContent,
          parentChunkId: parentChunk.id,
        };

        // Detect temporal anchor
        const dateMatch = subContent.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) ??
          subContent.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})[,.]?\s+(\d{4})\b/i);
        if (dateMatch) {
          try {
            const parsed = new Date(dateMatch[0]);
            if (!isNaN(parsed.getTime())) subChunk.temporalAnchor = parsed.getTime();
          } catch { /* skip */ }
        }

        try {
          const prefix = buildContextPrefix(subChunk);
          subChunk.embedding = await embed(config, subContent, prefix);
          subChunk.embeddingVersion = getEmbeddingModelProfile().version;
        } catch { /* skip */ }

        newChunks.push(subChunk);
        chunks.push(subChunk);
      }
    } else {
      // Single chunk path (original behavior)
      const chunk: StoredChunk = {
        id: randomUUID(),
        ...baseMeta,
        content: trimmedContent,
      };

      const dateMatch = chunk.content.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) ??
        chunk.content.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})[,.]?\s+(\d{4})\b/i);
      if (dateMatch) {
        try {
          const parsed = new Date(dateMatch[0]);
          if (!isNaN(parsed.getTime())) chunk.temporalAnchor = parsed.getTime();
        } catch { /* skip */ }
      }

      try {
        const prefix = buildContextPrefix(chunk);
        chunk.embedding = await embed(config, chunk.content, prefix);
        chunk.embeddingVersion = getEmbeddingModelProfile().version;
      } catch { /* skip */ }

      newChunks.push(chunk);
      chunks.push(chunk);
      // Single-chunk path: cache the chunk id keyed by source.
      sourceDedup.remember(entry.source, trimmedContent, chunk.id);
    }
  }

  // One batched write for every new chunk in the call.
  if (newChunks.length > 0) {
    await storage.saveChunks(newChunks);
  }

  // Per-batch side effects. Both opt-out via flags on any entry in
  // the batch (typical: engram-ingest calls ingest() with one entry,
  // so a single flag controls the path). Benchmark harnesses set
  // these to match what engram/benchmarks/locomo.ts does — its
  // direct-saveChunk path skips both, which is the source of the
  // ~50× wall-clock gap between standalone and MCP-boundary benches.
  const skipDaily = entries.some(e => e.skipDailyEntry);
  const skipKg = entries.some(e => e.skipKgExtraction);
  // awaitSideEffects defaults TRUE — only flip to async when EVERY
  // entry in the batch opts out, to avoid surprising a sync caller
  // batched with an async one.
  const runAsync = entries.length > 0 && entries.every(e => e.awaitSideEffects === false);

  if (chunks.length > 0) {
    const sideEffectsTask = async (): Promise<void> => {
      if (!skipDaily) {
        const date = new Date().toISOString().split('T')[0];
        try {
          await storage.appendDailyEntry(date, {
            timestamp: new Date().toISOString(),
            conversationId: chunks[0].source,
            summary: `WAL ingest: ${chunks.length} entries`,
            extractedFacts: chunks.map(c => c.content),
          });
        } catch {
          // best-effort: a daily-entry append failure must not break
          // the rest of the side-effects task
        }
      }
      if (!skipKg) {
        // Auto-populate knowledge graph from ingested content
        for (const chunk of chunks) {
          if (chunk.consolidationLevel === -1) continue; // skip parent containers
          try {
            await extractAndPersistTriples(storage, chunk.content, {
              domain: chunk.domain,
              topic: chunk.topic,
              source: chunk.source,
            });
          } catch {
            // KG extraction is best-effort — never block ingestion
          }
        }
      }
    };

    if (runAsync) {
      // Fire and forget — track in pendingSideEffects so tests or
      // shutdown code can drain via flushPendingSideEffects().
      const p = sideEffectsTask()
        .catch(() => { /* already handled at the per-step catches */ })
        .finally(() => { pendingSideEffects.delete(p); });
      pendingSideEffects.add(p);
    } else {
      await sideEffectsTask();
    }
  }

  return chunks;
}

// ── Type/Layer inference heuristics ──────────────────────────────────

function inferType(content: string): MemoryType {
  const lower = content.toLowerCase();
  if (lower.includes('prefer') || lower.includes('like') || lower.includes('want'))
    return 'preference';
  if (lower.includes('decided') || lower.includes('going with') || lower.includes('chose') || lower.includes('use '))
    return 'decision';
  if (lower.includes('not ') || lower.includes('wrong') || lower.includes('correct') || lower.includes('instead'))
    return 'correction';
  if (lower.includes('working on') || lower.includes('currently') || lower.includes('right now'))
    return 'context';
  return 'fact';
}

function inferLayer(content: string): CognitiveLayer {
  const lower = content.toLowerCase();
  if (lower.includes('always') || lower.includes('never') || lower.includes('rule') || lower.includes('should'))
    return 'procedural';
  if (lower.includes('today') || lower.includes('yesterday') || lower.includes('just ') || lower.includes('session'))
    return 'episodic';
  return 'semantic';
}
