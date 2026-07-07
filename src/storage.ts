/**
 * Storage — backwards-compatible shim over the pluggable StorageAdapter.
 *
 * przm Memory historically exposed a concrete `Storage` class that owned
 * LanceDB tables directly. ~20 modules import { Storage } from here
 * and call `new Storage(dataDir)` then `await storage.ensureReady()`.
 * The shim keeps that surface intact while delegating every method to
 * a backend adapter selected by createStorageAdapter().
 *
 *   STORAGE_BACKEND=file        — FileStorageAdapter (default; LanceDB)
 *   STORAGE_BACKEND=postgres    — PostgresStorageAdapter (multi-tenant)
 *
 * File-mode callers (`new Storage(dataDir)`) see byte-identical
 * behavior to the pre-adapter implementation. Postgres-mode callers
 * skip the dataDir and read DATABASE_URL + TENANT_ID from env.
 */

import type {
  MemoryTier,
  DailyLogEntry,
  ProceduralRule,
  KnowledgeTriple,
  DiaryEntry,
} from './types.js';
import type {
  StorageAdapter,
  StoredChunk,
  ListChunksOpts,
  QueryTriplesOpts,
  TripleStats,
  VectorHit,
  ReadDiaryOpts,
  HandoffNote,
  HandoffSummary,
} from './storage-adapter.js';
import { createStorageAdapter, resolveBackend } from './storage-factory.js';
import { FileStorageAdapter } from './storage-file.js';

// Re-export so old `import { StoredChunk } from './storage.js'` keeps working.
export type { StoredChunk } from './storage-adapter.js';

export class Storage {
  private adapter!: StorageAdapter;
  private ready: Promise<void>;
  // When non-null, updateChunk/deleteChunk buffer into these instead of
  // writing immediately; flushBatch() commits them as one bulk upsert +
  // one bulk delete + a compaction. See beginBatch() for why.
  private batch: { updates: Map<string, Partial<StoredChunk>>; deletes: Set<string> } | null = null;

  constructor(dataDir: string) {
    // Resolve eagerly; file mode is sync, postgres mode awaits the
    // factory before ensureReady() returns.
    const backend = resolveBackend();
    if (backend === 'file') {
      // Hot path — no dynamic import, no env-var roundtrip.
      this.adapter = new FileStorageAdapter(dataDir);
      this.ready = this.adapter.ensureReady();
    } else {
      this.ready = (async () => {
        this.adapter = await createStorageAdapter({ dataDir, backend });
        await this.adapter.ensureReady();
      })();
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  // ── Chunks ────────────────────────────────────────────────────────

  saveChunk(chunk: StoredChunk): Promise<void> { return this.adapter.saveChunk(chunk); }
  saveChunks(chunks: StoredChunk[]): Promise<void> { return this.adapter.saveChunks(chunks); }
  getChunk(id: string): Promise<StoredChunk | null> { return this.adapter.getChunk(id); }
  deleteChunk(id: string): Promise<void> {
    if (this.batch) {
      this.batch.updates.delete(id);
      this.batch.deletes.add(id);
      return Promise.resolve();
    }
    return this.adapter.deleteChunk(id);
  }
  listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]> { return this.adapter.listChunks(opts); }
  updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void> {
    if (this.batch) {
      // A delete already staged for this id wins — don't resurrect it.
      if (this.batch.deletes.has(id)) return Promise.resolve();
      const prev = this.batch.updates.get(id);
      this.batch.updates.set(id, prev ? { ...prev, ...updates } : { ...updates });
      return Promise.resolve();
    }
    return this.adapter.updateChunk(id, updates);
  }

  /**
   * Enter batched-write mode. While open, updateChunk/deleteChunk buffer
   * in memory. Consolidation opens a batch around all its passes because
   * decay/link/merge touch nearly every chunk, and per-row LanceDB writes
   * scan + rewrite a fragment each — thousands of them serialized is the
   * difference between a few seconds and over an hour on a real store.
   * saveChunk/saveChunks are NOT buffered (inserts are already batched and
   * some passes read them back mid-run).
   */
  beginBatch(): void {
    this.batch = { updates: new Map(), deletes: new Set() };
  }

  /** Batched upsert of full rows. Falls back to per-row updateChunk for
   *  adapters without the primitive. Not affected by batch mode — this is
   *  the direct bulk path used by reembed. */
  async updateChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    if (this.adapter.updateChunks) return this.adapter.updateChunks(chunks);
    for (const c of chunks) await this.adapter.updateChunk(c.id, c);
  }

  /** Compact + prune the chunk table. See StorageAdapter.optimizeChunks. */
  async optimizeChunks(olderThanMs?: number, deleteUnverified?: boolean): Promise<void> {
    if (this.adapter.optimizeChunks) return this.adapter.optimizeChunks(olderThanMs, deleteUnverified);
  }

  /**
   * Commit and close the batch: one bulk upsert (mergeInsert), one bulk
   * delete, then a table compaction. Reads the current chunks once, applies
   * the buffered partials through the same rowToChunk/chunkToRow path a
   * normal save uses, and upserts. Falls back to per-row writes for
   * adapters that don't implement the batch primitives (postgres/cloud).
   */
  async flushBatch(): Promise<{ updated: number; deleted: number }> {
    const batch = this.batch;
    this.batch = null; // writes below must go straight through
    if (!batch) return { updated: 0, deleted: 0 };
    const { updates, deletes } = batch;

    if (deletes.size > 0) {
      if (this.adapter.deleteChunks) await this.adapter.deleteChunks([...deletes]);
      else for (const id of deletes) await this.adapter.deleteChunk(id);
    }

    let upserted = 0;
    if (updates.size > 0) {
      if (this.adapter.updateChunks) {
        const byId = new Map((await this.adapter.listChunks()).map(c => [c.id, c]));
        const merged: StoredChunk[] = [];
        for (const [id, changes] of updates) {
          if (deletes.has(id)) continue;
          const chunk = byId.get(id);
          if (!chunk) continue; // updated-then-deleted, or gone
          Object.assign(chunk, changes);
          merged.push(chunk);
        }
        if (merged.length > 0) await this.adapter.updateChunks(merged);
        upserted = merged.length;
      } else {
        for (const [id, changes] of updates) {
          if (deletes.has(id)) continue;
          await this.adapter.updateChunk(id, changes);
          upserted++;
        }
      }
    }

    // Reclaim: prune versions older than an hour (well outside any in-flight
    // read/write) so per-search recall-stat writes and each consolidation
    // pass don't silently re-bloat the store. deleteUnverified is safe here
    // because nothing this store touches holds a transaction open for an hour.
    if (this.adapter.optimizeChunks) await this.adapter.optimizeChunks(3_600_000, true);
    return { updated: upserted, deleted: deletes.size };
  }

  chunkCount(): Promise<number> { return this.adapter.chunkCount(); }
  vectorSearch(queryEmbedding: number[], limit: number, filter?: string): Promise<VectorHit[]> {
    return this.adapter.vectorSearch(queryEmbedding, limit, filter);
  }

  // ── Taxonomy ─────────────────────────────────────────────────────

  getTaxonomy(): Promise<Record<string, Record<string, number>>> { return this.adapter.getTaxonomy(); }

  // ── Daily logs ───────────────────────────────────────────────────

  appendDailyEntry(date: string, entry: DailyLogEntry): Promise<void> {
    return this.adapter.appendDailyEntry(date, entry);
  }
  getDailyLogs(daysBack: number): Promise<Array<{ date: string; entries: DailyLogEntry[] }>> {
    return this.adapter.getDailyLogs(daysBack);
  }

  // ── Rules ────────────────────────────────────────────────────────

  saveRule(rule: ProceduralRule): Promise<void> { return this.adapter.saveRule(rule); }
  getRules(): Promise<ProceduralRule[]> { return this.adapter.getRules(); }
  deleteRule(id: string): Promise<void> { return this.adapter.deleteRule(id); }

  // ── Knowledge triples ────────────────────────────────────────────

  saveTriple(triple: KnowledgeTriple): Promise<void> { return this.adapter.saveTriple(triple); }
  queryTriples(opts?: QueryTriplesOpts): Promise<KnowledgeTriple[]> { return this.adapter.queryTriples(opts); }
  invalidateTriple(id: string): Promise<void> { return this.adapter.invalidateTriple(id); }
  getTripleTimeline(entity: string): Promise<KnowledgeTriple[]> { return this.adapter.getTripleTimeline(entity); }
  getTripleStats(): Promise<TripleStats> { return this.adapter.getTripleStats(); }

  // ── Diary + handoffs (new surface — server.ts routes through these
  //    when STORAGE_BACKEND=postgres so the markdown filesystem layer
  //    isn't required for cloud installs) ───────────────────────────

  writeDiaryEntry(content: string, agent?: string): Promise<DiaryEntry> {
    return this.adapter.writeDiaryEntry(content, agent);
  }
  readDiary(opts?: ReadDiaryOpts): Promise<Array<{ date: string; entries: DiaryEntry[] }>> {
    return this.adapter.readDiary(opts);
  }
  listDiaryDates(): Promise<string[]> { return this.adapter.listDiaryDates(); }

  writeHandoff(note: Omit<HandoffNote, 'timestamp'>): Promise<HandoffNote> {
    return this.adapter.writeHandoff(note);
  }
  readHandoff(stamp?: string): Promise<HandoffNote | null> { return this.adapter.readHandoff(stamp); }
  listHandoffs(limit?: number): Promise<HandoffSummary[]> { return this.adapter.listHandoffs(limit); }

  // ── Lifecycle ────────────────────────────────────────────────────

  close(): void {
    // Adapter close is optional + may be async; fire-and-forget for
    // backwards compat (the file backend's close is a no-op).
    if (this.adapter?.close) {
      Promise.resolve(this.adapter.close()).catch(() => { /* swallow */ });
    }
  }
}

// Silence unused-import warning on MemoryTier; surface kept for downstream callers.
export type { MemoryTier };
