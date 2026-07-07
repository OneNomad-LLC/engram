/**
 * Coverage for the v1.1 embedding-space marker + auto-maintenance
 * plumbing:
 *
 *   1. checkEmbeddingMeta — fresh stores get stamped, marker mismatches
 *      are flagged, legacy stores (chunks but no marker) are assumed
 *      MiniLM and flagged whenever the active model differs.
 *   2. Maintenance state — never-run stores are overdue, runMaintenance
 *      stamps lastRunAt, and the preference/correction rule backfill is
 *      a strict one-shot (re-running must not re-reinforce rules).
 *   3. Heuristic rule patterns — the "rule:" and bare "prefers X" forms
 *      that arrive via memory-ingest produce rules without an LLM key.
 *
 * Embeddings are skipped (ENGRAM_SKIP_EMBED=1): everything here is
 * marker/state logic, not vector math.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ENGRAM_LLM_BASE_URL;

import { Storage, type StoredChunk } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import {
  readEmbeddingMeta,
  writeEmbeddingMeta,
  checkEmbeddingMeta,
} from '../src/reembed.js';
import {
  readMaintenanceState,
  maintenanceOverdue,
  runMaintenance,
} from '../src/maintenance.js';
import { getEmbeddingModelName, LEGACY_EMBEDDING_MODEL } from '../src/llm.js';
import { extractRules } from '../src/procedural.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'engram-reembed-test-'));
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ } },
  };
}

function makeChunk(id: string, content: string, type: StoredChunk['type'] = 'fact'): StoredChunk {
  return {
    id,
    tier: 'short-term',
    content,
    type,
    cognitiveLayer: 'semantic',
    tags: [],
    domain: '',
    topic: '',
    source: 'reembed-test',
    importance: 0.5,
    sentiment: 'neutral',
    createdAt: new Date().toISOString(),
    lastRecalledAt: null,
    recallCount: 0,
    relatedMemories: [],
    recallOutcomes: [],
    stability: 1.0,
    difficulty: 0.3,
    temporalAnchor: 0,
    consolidationLevel: 0,
    sourceChunkIds: [],
    embeddingVersion: 1,
    parentChunkId: '',
    origin: 'derived',
  };
}

describe('embedding-space marker', () => {
  it('stamps a fresh store and reports no mismatch', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();

      const check = await checkEmbeddingMeta(config, storage);
      assert.equal(check.mismatch, false);
      assert.equal(check.currentModel, getEmbeddingModelName());

      const meta = readEmbeddingMeta(dir);
      assert.ok(meta, 'fresh store should get a marker stamped');
      assert.equal(meta!.model, getEmbeddingModelName());
    } finally {
      cleanup();
    }
  });

  it('flags a marker that names a different model', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();

      writeEmbeddingMeta(dir, 384);
      const marker = JSON.parse(readFileSync(join(dir, 'embedding-meta.json'), 'utf-8'));
      marker.model = 'Xenova/some-other-model';
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'embedding-meta.json'), JSON.stringify(marker));

      const check = await checkEmbeddingMeta(config, storage);
      assert.equal(check.mismatch, true);
      assert.equal(check.storedModel, 'Xenova/some-other-model');
    } finally {
      cleanup();
    }
  });

  it('treats a populated store without a marker as legacy MiniLM', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunk(makeChunk('c1', 'A memory written by a pre-marker install.'));

      const check = await checkEmbeddingMeta(config, storage);
      // Default model is bge-small now, so a legacy store must be flagged
      // — unless someone pinned the env back to MiniLM.
      const expectMismatch = getEmbeddingModelName() !== LEGACY_EMBEDDING_MODEL;
      assert.equal(check.mismatch, expectMismatch);
      assert.equal(check.storedModel, null);
      assert.equal(existsSync(join(dir, 'embedding-meta.json')), false,
        'legacy store must NOT get auto-stamped — only reembed may stamp it');
    } finally {
      cleanup();
    }
  });
});

describe('auto-maintenance state', () => {
  it('never-run stores are overdue and runMaintenance stamps lastRunAt', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();

      assert.equal(maintenanceOverdue(dir), true);
      await runMaintenance(config, storage);
      const state = readMaintenanceState(dir);
      assert.ok(state.lastRunAt, 'lastRunAt stamped');
      assert.ok(state.rulesBackfilledAt, 'backfill stamped');
      assert.equal(maintenanceOverdue(dir), false);
    } finally {
      cleanup();
    }
  });

  it('rule backfill runs once and does not re-reinforce on later passes', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunk(makeChunk('p1', 'Rule set by Matt: never use em dashes in commit messages.', 'preference'));
      await storage.saveChunk(makeChunk('p2', 'Matt prefers TypeScript for every new project.', 'preference'));

      const first = await runMaintenance(config, storage);
      assert.equal(first.rulesBackfilled, 2, 'both preference chunks replayed');
      const rules = await storage.getRules();
      assert.ok(rules.length >= 1, `backfill should extract at least one rule, got ${rules.length}`);
      const confidences = rules.map(r => r.confidence);

      const second = await runMaintenance(config, storage);
      assert.equal(second.rulesBackfilled, 0, 'backfill is one-shot');
      const rulesAfter = await storage.getRules();
      assert.deepEqual(
        rulesAfter.map(r => r.confidence),
        confidences,
        'second pass must not re-reinforce rule confidence'
      );
    } finally {
      cleanup();
    }
  });
});

describe('heuristic rule patterns (ingest phrasings)', () => {
  it('extracts from "rule:" and bare "prefers" forms without an LLM', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();

      await extractRules(config, storage, [
        { role: 'user', content: 'Rule set by Matt: write commit messages like a human.' },
        { role: 'user', content: 'Matt prefers pnpm for package management in monorepos.' },
      ]);

      const rules = await storage.getRules();
      const texts = rules.map(r => r.rule.toLowerCase());
      assert.ok(texts.some(t => t.includes('commit messages')), `missing rule: directive, got ${JSON.stringify(texts)}`);
      assert.ok(texts.some(t => t.includes('pnpm')), `missing prefers directive, got ${JSON.stringify(texts)}`);
    } finally {
      cleanup();
    }
  });
});
