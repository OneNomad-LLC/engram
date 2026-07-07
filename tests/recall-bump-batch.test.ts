/**
 * Recall-stat bump batching (search.ts).
 *
 * A search bumps recallCount + lastRecalledAt on every returned chunk.
 * That used to be N per-row LanceDB updates (a fresh fragment each); it's
 * now one mergeInsert per search. The upsert writes the FULL row, so the
 * load-bearing risk is that it must not clobber the embedding — these
 * tests prove the bump increments recall stats AND leaves the stored
 * embedding byte-for-byte intact, so vector retrieval keeps working.
 *
 * Runs with ENGRAM_SKIP_EMBED=1: the query embeds to nothing and search
 * falls back to keyword matching, which still returns the seeded chunk and
 * still fires the recall bump — exactly the path under test, minus the
 * model download.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';

import { Storage, type StoredChunk } from '../src/storage.js';
import { search } from '../src/search.js';
import { loadConfig } from '../src/config.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-recall-bump-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ } } };
}

// A distinctive, non-zero 384-dim embedding so rowToChunk keeps it (it
// nulls all-zero vectors) and we can compare it exactly after the bump.
function fingerprintEmbedding(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => ((i * 7 + seed) % 97) / 97 + 0.01);
}

function chunk(id: string, content: string, embedding: number[]): StoredChunk {
  return {
    id, tier: 'long-term', content, type: 'fact', cognitiveLayer: 'semantic',
    tags: [], domain: '', topic: '', source: 'recall-bump-test', importance: 0.5,
    sentiment: 'neutral', createdAt: new Date().toISOString(), lastRecalledAt: null,
    recallCount: 0, embedding, relatedMemories: [], recallOutcomes: [],
    stability: 1.0, difficulty: 0.3, temporalAnchor: 0, consolidationLevel: 0,
    sourceChunkIds: [], embeddingVersion: 3, parentChunkId: '', origin: 'user',
  };
}

// Recall bump is fire-and-forget; poll until it lands (or time out).
async function waitFor(fn: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

describe('recall-stat bump batching', () => {
  it('increments recall stats without clobbering the embedding', async () => {
    const { dir, cleanup } = tmp();
    try {
      const config = loadConfig();
      const storage = new Storage(dir);
      await storage.ensureReady();

      const embA = fingerprintEmbedding(1);
      const embB = fingerprintEmbedding(2);
      await storage.saveChunks([
        chunk('a', 'the quaxolotl protocol governs synchronization', embA),
        chunk('b', 'unrelated content about gardening tomatoes', embB),
      ]);

      // Keyword search returns chunk a (rare token "quaxolotl").
      const results = await search(config, storage, 'quaxolotl', 5);
      assert.ok(results.some(r => r.chunk.id === 'a'), 'search should return chunk a');

      const bumped = await waitFor(async () => ((await storage.getChunk('a'))?.recallCount ?? 0) >= 1);
      assert.ok(bumped, 'recallCount should increment after the search');

      const a = (await storage.getChunk('a'))!;
      assert.equal(a.recallCount, 1);
      assert.ok(a.lastRecalledAt, 'lastRecalledAt should be set');
      // The load-bearing assertion: embedding survived the full-row upsert.
      assert.equal(a.embedding?.length, 384, 'embedding length preserved');
      assert.ok(
        a.embedding!.every((v, i) => Math.abs(v - embA[i]) < 1e-6),
        'embedding values preserved byte-for-byte',
      );

      // A chunk that was NOT returned keeps recallCount 0 and its embedding.
      const b = (await storage.getChunk('b'))!;
      assert.equal(b.recallCount, 0, 'untouched chunk not bumped');
      assert.ok(b.embedding!.every((v, i) => Math.abs(v - embB[i]) < 1e-6), 'untouched embedding intact');
    } finally { cleanup(); }
  });

  it('accumulates across repeated searches', async () => {
    const { dir, cleanup } = tmp();
    try {
      const config = loadConfig();
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunks([chunk('a', 'the quaxolotl protocol', fingerprintEmbedding(3))]);

      for (let n = 1; n <= 3; n++) {
        await search(config, storage, 'quaxolotl', 5);
        const landed = await waitFor(async () => ((await storage.getChunk('a'))?.recallCount ?? 0) >= n);
        assert.ok(landed, `recallCount should reach ${n}`);
      }
      assert.equal((await storage.getChunk('a'))!.recallCount, 3);
      // Still a valid 384-dim vector after three upserts.
      assert.equal((await storage.getChunk('a'))!.embedding?.length, 384);
    } finally { cleanup(); }
  });
});
