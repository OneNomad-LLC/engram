/**
 * Batched-write path for consolidation.
 *
 * consolidate() opens a batch around all its passes so the thousands of
 * per-row updates it issues (decay/link touch nearly every chunk) commit
 * as one mergeInsert instead of one scan-and-rewrite each — the fix for a
 * live store where a full pass took over an hour. These tests pin the
 * batch semantics: buffered updates land, deletes land, a delete staged
 * for an id wins over an update to the same id, and the batch is a no-op
 * when empty.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';

import { Storage, type StoredChunk } from '../src/storage.js';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'engram-batch-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ } } };
}

function chunk(id: string, over: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id, tier: 'short-term', content: `content ${id}`, type: 'fact',
    cognitiveLayer: 'semantic', tags: [], domain: '', topic: '',
    source: 'batch-test', importance: 0.5, sentiment: 'neutral',
    createdAt: new Date().toISOString(), lastRecalledAt: null, recallCount: 0,
    relatedMemories: [], recallOutcomes: [], stability: 1.0, difficulty: 0.3,
    temporalAnchor: 0, consolidationLevel: 0, sourceChunkIds: [],
    embeddingVersion: 1, parentChunkId: '', origin: 'derived', ...over,
  };
}

describe('batched writes', () => {
  it('buffers updates and commits them on flush', async () => {
    const { dir, cleanup } = tmp();
    try {
      const s = new Storage(dir);
      await s.ensureReady();
      await s.saveChunks([chunk('a', { importance: 0.5 }), chunk('b', { importance: 0.5 })]);

      s.beginBatch();
      await s.updateChunk('a', { importance: 0.9, tier: 'long-term' });
      await s.updateChunk('b', { importance: 0.1 });

      // Nothing written yet — still buffered.
      assert.equal((await s.getChunk('a'))!.importance, 0.5, 'update must not land before flush');

      const res = await s.flushBatch();
      assert.equal(res.updated, 2);
      assert.equal((await s.getChunk('a'))!.importance, 0.9);
      assert.equal((await s.getChunk('a'))!.tier, 'long-term');
      assert.equal((await s.getChunk('b'))!.importance, 0.1);
    } finally { cleanup(); }
  });

  it('merges successive partials for the same id', async () => {
    const { dir, cleanup } = tmp();
    try {
      const s = new Storage(dir);
      await s.ensureReady();
      await s.saveChunks([chunk('a')]);

      s.beginBatch();
      await s.updateChunk('a', { importance: 0.7 });
      await s.updateChunk('a', { tier: 'long-term' }); // different field, same id
      await s.flushBatch();

      const a = (await s.getChunk('a'))!;
      assert.equal(a.importance, 0.7, 'first partial survives');
      assert.equal(a.tier, 'long-term', 'second partial survives');
    } finally { cleanup(); }
  });

  it('a staged delete wins over an update to the same id', async () => {
    const { dir, cleanup } = tmp();
    try {
      const s = new Storage(dir);
      await s.ensureReady();
      await s.saveChunks([chunk('a'), chunk('b')]);

      s.beginBatch();
      await s.updateChunk('a', { importance: 0.9 });
      await s.deleteChunk('a');              // delete after update
      await s.deleteChunk('b');
      await s.updateChunk('b', { importance: 0.9 }); // update after delete
      const res = await s.flushBatch();

      assert.equal(res.deleted, 2);
      assert.equal(await s.getChunk('a'), null, 'a deleted despite the buffered update');
      assert.equal(await s.getChunk('b'), null, 'b stays deleted despite a later update');
      assert.equal(await s.chunkCount(), 0);
    } finally { cleanup(); }
  });

  it('flush with no batch open is a harmless no-op', async () => {
    const { dir, cleanup } = tmp();
    try {
      const s = new Storage(dir);
      await s.ensureReady();
      const res = await s.flushBatch();
      assert.deepEqual(res, { updated: 0, deleted: 0 });
    } finally { cleanup(); }
  });

  it('updateChunk writes through immediately when no batch is open', async () => {
    const { dir, cleanup } = tmp();
    try {
      const s = new Storage(dir);
      await s.ensureReady();
      await s.saveChunks([chunk('a')]);
      await s.updateChunk('a', { importance: 0.42 }); // no beginBatch
      assert.equal((await s.getChunk('a'))!.importance, 0.42);
    } finally { cleanup(); }
  });
});
