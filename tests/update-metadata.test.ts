/**
 * engram-update-metadata tests — pure-logic + storage round-trip.
 *
 * The pure helper `buildUpdateMetadataPatch` covers merge vs. replace
 * semantics without spinning up LanceDB. The storage round-trip cases
 * exercise the same helper through Storage.updateChunk + getChunk to
 * confirm engram's flat-row layout actually persists what the helper
 * produces (especially tags, which are JSON-stringified at the DB
 * boundary).
 *
 * Run: `npm test` or `node --import tsx --test tests/update-metadata.test.ts`
 */

// Opt out of credentials-file auto-routing — this round-trips against
// LanceDB on disk and must not silently hit przm Cloud just because the
// dev machine has been logged in. See v1.0.1.
process.env.ENGRAM_NO_AUTO_CLOUD = '1';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Storage } from '../src/storage.js';
import { buildUpdateMetadataPatch } from '../src/update-metadata.js';
import type { MemoryChunk } from '../src/types.js';

async function tmpStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-update-meta-'));
  const storage = new Storage(dir);
  await storage.ensureReady();
  return {
    storage,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

function seedChunk(): MemoryChunk {
  return {
    id: 'm1',
    tier: 'daily',
    content: 'Mis-stamped: actually about DungeonDiary, not elevatedigital',
    type: 'context',
    cognitiveLayer: 'semantic',
    tags: ['workspace:elevatedigital', 'project:dungeondiary'],
    domain: 'work',
    topic: 'dungeondiary',
    source: 'mcp:test',
    importance: 0.5,
    sentiment: 'neutral',
    createdAt: '2026-04-01T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    embedding: new Array(384).fill(0),
  };
}

describe('buildUpdateMetadataPatch — merge mode', () => {
  it('only carries specified fields; untouched stay absent', () => {
    const patch = buildUpdateMetadataPatch(
      { tags: ['workspace:dungeondiary'] },
      'merge',
    );
    assert.deepEqual(patch, { tags: ['workspace:dungeondiary'] });
    assert.equal('source' in patch, false);
    assert.equal('domain' in patch, false);
  });

  it('passes through every recognized field', () => {
    const patch = buildUpdateMetadataPatch(
      {
        tags: ['x'],
        source: 's',
        domain: 'd',
        topic: 't',
        type: 'fact',
        sentiment: 'curious',
        importance: 0.9,
        cognitiveLayer: 'semantic',
      },
      'merge',
    );
    assert.deepEqual(patch, {
      tags: ['x'],
      source: 's',
      domain: 'd',
      topic: 't',
      type: 'fact',
      sentiment: 'curious',
      importance: 0.9,
      cognitiveLayer: 'semantic',
    });
  });
});

describe('buildUpdateMetadataPatch — replace mode', () => {
  it('resets unset fields to engram defaults', () => {
    const patch = buildUpdateMetadataPatch(
      { tags: ['workspace:dungeondiary'] },
      'replace',
    );
    // Only `tags` was specified — everything else should be defaults.
    assert.deepEqual(patch.tags, ['workspace:dungeondiary']);
    assert.equal(patch.source, '');
    assert.equal(patch.domain, '');
    assert.equal(patch.topic, '');
    assert.equal(patch.type, 'context');
    assert.equal(patch.sentiment, 'neutral');
    assert.equal(patch.importance, 0.5);
  });

  it('keeps caller values where present', () => {
    const patch = buildUpdateMetadataPatch(
      { source: 'mcp:test', importance: 0.8 },
      'replace',
    );
    assert.equal(patch.source, 'mcp:test');
    assert.equal(patch.importance, 0.8);
    // Unset stays at default.
    assert.deepEqual(patch.tags, []);
  });
});

describe('Storage roundtrip via updateChunk', () => {
  it('merge mode preserves untouched fields end-to-end', async () => {
    const { storage, cleanup } = await tmpStorage();
    try {
      const chunk = seedChunk();
      await storage.saveChunk({ ...chunk, relatedMemories: [], recallOutcomes: [] });

      const patch = buildUpdateMetadataPatch(
        { tags: ['workspace:dungeondiary', 'project:dungeondiary'] },
        'merge',
      );
      await storage.updateChunk(chunk.id, patch);

      const after = await storage.getChunk(chunk.id);
      assert.ok(after);
      // tags updated
      assert.deepEqual(after.tags, ['workspace:dungeondiary', 'project:dungeondiary']);
      // untouched fields preserved
      assert.equal(after.content, chunk.content);
      assert.equal(after.source, chunk.source);
      assert.equal(after.domain, chunk.domain);
      assert.equal(after.importance, chunk.importance);
      assert.equal(after.createdAt, chunk.createdAt);
    } finally {
      cleanup();
    }
  });

  it('replace mode wipes unset metadata to defaults end-to-end', async () => {
    const { storage, cleanup } = await tmpStorage();
    try {
      const chunk = seedChunk();
      await storage.saveChunk({ ...chunk, relatedMemories: [], recallOutcomes: [] });

      const patch = buildUpdateMetadataPatch(
        { tags: ['workspace:dungeondiary'] },
        'replace',
      );
      await storage.updateChunk(chunk.id, patch);

      const after = await storage.getChunk(chunk.id);
      assert.ok(after);
      assert.deepEqual(after.tags, ['workspace:dungeondiary']);
      // Source/domain/topic wiped to defaults.
      assert.equal(after.source, '');
      assert.equal(after.domain, '');
      assert.equal(after.topic, '');
      // But content + createdAt stay (they're not in the metadata surface).
      assert.equal(after.content, chunk.content);
      assert.equal(after.createdAt, chunk.createdAt);
    } finally {
      cleanup();
    }
  });

  it('updating tags makes a previously-filtered row visible (workspace bleed fix scenario)', async () => {
    const { storage, cleanup } = await tmpStorage();
    try {
      const chunk = seedChunk(); // tags: workspace:elevatedigital
      await storage.saveChunk({ ...chunk, relatedMemories: [], recallOutcomes: [] });

      // Fix the stamp: replace workspace:elevatedigital with workspace:dungeondiary.
      const patch = buildUpdateMetadataPatch(
        { tags: ['workspace:dungeondiary', 'project:dungeondiary'] },
        'merge',
      );
      await storage.updateChunk(chunk.id, patch);

      // A cortex-side filter query (".tags includes workspace:dungeondiary")
      // simulated client-side here — just observe the row's current tags.
      const after = await storage.getChunk(chunk.id);
      assert.ok(after);
      const wsTag = after.tags.find((t) => t.startsWith('workspace:'));
      assert.equal(wsTag, 'workspace:dungeondiary',
        'mis-stamped row now resolves to the correct workspace');
    } finally {
      cleanup();
    }
  });

  it('updateChunk on missing id is a no-op (no row created)', async () => {
    const { storage, cleanup } = await tmpStorage();
    try {
      // No seed — table empty.
      const patch = buildUpdateMetadataPatch({ tags: ['x'] }, 'merge');
      // updateChunk doesn't error on missing rows; just no rows match.
      await storage.updateChunk('does-not-exist', patch);
      const fetched = await storage.getChunk('does-not-exist');
      assert.equal(fetched, null);
    } finally {
      cleanup();
    }
  });
});
