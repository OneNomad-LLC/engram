/**
 * episodic-consolidation-level — R-003 regression test.
 *
 * Before the fix, `consolidateEpisodic` set `consolidationLevel: 0`
 * on source chunks after summarizing them.  The candidate filter
 * selects `consolidationLevel === 0`, so every subsequent
 * `memory-maintain` run re-summarized the same source chunks and
 * accumulated duplicate L1 summaries.
 *
 * After the fix, source chunks are set to `consolidationLevel: 1`,
 * so they are excluded from future passes.
 *
 * Run: `npm test` or
 *      `node --import tsx --test tests/episodic-consolidation-level.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from '../src/storage.js';
import type { StoredChunk } from '../src/storage-adapter.js';
import { consolidateEpisodic } from '../src/episodic-consolidator.js';
import { DEFAULT_CONFIG } from '../src/types.js';

function makeEpisodicChunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
  // Default is a cluster-friendly episodic L0 chunk from 10 days ago.
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return {
    id: randomUUID(),
    tier: 'daily',
    content: 'User discussed TypeScript project architecture.',
    type: 'fact',
    cognitiveLayer: 'episodic',
    tags: ['typescript', 'architecture'],
    domain: 'engineering',
    topic: 'architecture',
    source: 'test',
    importance: 0.7,
    sentiment: 'neutral',
    createdAt: tenDaysAgo,
    lastRecalledAt: null,
    recallCount: 0,
    relatedMemories: [],
    recallOutcomes: [],
    stability: 1.0,
    difficulty: 0.3,
    consolidationLevel: 0,
    embeddingVersion: 1,
    origin: 'user',
    ...overrides,
  };
}

describe('episodic consolidation level — R-003', () => {
  it('source chunks are marked consolidationLevel:1 after consolidation so they are not re-summarized', async () => {
    // Skip the embedding model load so the test runs in <1s.
    // consolidateEpisodic wraps embed() in try/catch, so throwing
    // is safe — the summary chunk is still saved without an embedding.
    const prevSkip = process.env.ENGRAM_SKIP_EMBED;
    process.env.ENGRAM_SKIP_EMBED = '1';

    const dir = mkdtempSync(join(tmpdir(), 'engram-epis-level-'));
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();

      // Insert 4 episodic L0 chunks that form a cluster (same domain + topic).
      // consolidateEpisodic requires >= 3 candidates and >= 3 per cluster.
      const sourceIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const chunk = makeEpisodicChunk({ content: `Meeting note ${i}: discussed TypeScript patterns.` });
        await storage.saveChunk(chunk);
        sourceIds.push(chunk.id);
      }

      // First consolidation run.
      const stats1 = await consolidateEpisodic(DEFAULT_CONFIG, storage);
      assert.ok(stats1.summarized >= 1, `expected at least 1 summary on first run; got ${stats1.summarized}`);

      // Source chunks must now have consolidationLevel: 1.
      for (const id of sourceIds) {
        const chunk = await storage.getChunk(id);
        assert.ok(chunk, `source chunk ${id} should still exist`);
        assert.equal(
          chunk.consolidationLevel,
          1,
          `source chunk ${id} must be consolidationLevel:1 after consolidation (was 0 = R-003 bug)`,
        );
      }

      // Count semantic chunks (L1 summaries) after first run.
      const afterFirst = await storage.listChunks({ cognitiveLayer: 'semantic' });
      const l1AfterFirst = afterFirst.filter((c) => (c.consolidationLevel ?? 0) === 1).length;
      assert.ok(l1AfterFirst >= 1, 'at least one L1 summary should exist after first run');

      // Second consolidation run — must not re-summarize the same source chunks.
      const stats2 = await consolidateEpisodic(DEFAULT_CONFIG, storage);
      assert.equal(
        stats2.summarized,
        0,
        `second run should produce 0 new summaries (R-003: was producing duplicates)`,
      );

      // Total L1 count must not have grown.
      const afterSecond = await storage.listChunks({ cognitiveLayer: 'semantic' });
      const l1AfterSecond = afterSecond.filter((c) => (c.consolidationLevel ?? 0) === 1).length;
      assert.equal(
        l1AfterSecond,
        l1AfterFirst,
        `no new L1 summaries should be created on second run; before=${l1AfterFirst}, after=${l1AfterSecond}`,
      );
    } finally {
      // Restore env state regardless of test outcome.
      if (prevSkip === undefined) delete process.env.ENGRAM_SKIP_EMBED;
      else process.env.ENGRAM_SKIP_EMBED = prevSkip;

      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});
