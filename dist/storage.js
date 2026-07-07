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
import { createStorageAdapter, resolveBackend } from './storage-factory.js';
import { FileStorageAdapter } from './storage-file.js';
export class Storage {
    adapter;
    ready;
    // When non-null, updateChunk/deleteChunk buffer into these instead of
    // writing immediately; flushBatch() commits them as one bulk upsert +
    // one bulk delete + a compaction. See beginBatch() for why.
    batch = null;
    constructor(dataDir) {
        // Resolve eagerly; file mode is sync, postgres mode awaits the
        // factory before ensureReady() returns.
        const backend = resolveBackend();
        if (backend === 'file') {
            // Hot path — no dynamic import, no env-var roundtrip.
            this.adapter = new FileStorageAdapter(dataDir);
            this.ready = this.adapter.ensureReady();
        }
        else {
            this.ready = (async () => {
                this.adapter = await createStorageAdapter({ dataDir, backend });
                await this.adapter.ensureReady();
            })();
        }
    }
    async ensureReady() {
        await this.ready;
    }
    // ── Chunks ────────────────────────────────────────────────────────
    saveChunk(chunk) { return this.adapter.saveChunk(chunk); }
    saveChunks(chunks) { return this.adapter.saveChunks(chunks); }
    getChunk(id) { return this.adapter.getChunk(id); }
    deleteChunk(id) {
        if (this.batch) {
            this.batch.updates.delete(id);
            this.batch.deletes.add(id);
            return Promise.resolve();
        }
        return this.adapter.deleteChunk(id);
    }
    listChunks(opts) { return this.adapter.listChunks(opts); }
    updateChunk(id, updates) {
        if (this.batch) {
            // A delete already staged for this id wins — don't resurrect it.
            if (this.batch.deletes.has(id))
                return Promise.resolve();
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
    beginBatch() {
        this.batch = { updates: new Map(), deletes: new Set() };
    }
    /** Batched upsert of full rows. Falls back to per-row updateChunk for
     *  adapters without the primitive. Not affected by batch mode — this is
     *  the direct bulk path used by reembed. */
    async updateChunks(chunks) {
        if (chunks.length === 0)
            return;
        if (this.adapter.updateChunks)
            return this.adapter.updateChunks(chunks);
        for (const c of chunks)
            await this.adapter.updateChunk(c.id, c);
    }
    /** Compact + prune the chunk table. See StorageAdapter.optimizeChunks. */
    async optimizeChunks(olderThanMs, deleteUnverified) {
        if (this.adapter.optimizeChunks)
            return this.adapter.optimizeChunks(olderThanMs, deleteUnverified);
    }
    /**
     * Commit and close the batch: one bulk upsert (mergeInsert), one bulk
     * delete, then a table compaction. Reads the current chunks once, applies
     * the buffered partials through the same rowToChunk/chunkToRow path a
     * normal save uses, and upserts. Falls back to per-row writes for
     * adapters that don't implement the batch primitives (postgres/cloud).
     */
    async flushBatch() {
        const batch = this.batch;
        this.batch = null; // writes below must go straight through
        if (!batch)
            return { updated: 0, deleted: 0 };
        const { updates, deletes } = batch;
        if (deletes.size > 0) {
            if (this.adapter.deleteChunks)
                await this.adapter.deleteChunks([...deletes]);
            else
                for (const id of deletes)
                    await this.adapter.deleteChunk(id);
        }
        let upserted = 0;
        if (updates.size > 0) {
            if (this.adapter.updateChunks) {
                const byId = new Map((await this.adapter.listChunks()).map(c => [c.id, c]));
                const merged = [];
                for (const [id, changes] of updates) {
                    if (deletes.has(id))
                        continue;
                    const chunk = byId.get(id);
                    if (!chunk)
                        continue; // updated-then-deleted, or gone
                    Object.assign(chunk, changes);
                    merged.push(chunk);
                }
                if (merged.length > 0)
                    await this.adapter.updateChunks(merged);
                upserted = merged.length;
            }
            else {
                for (const [id, changes] of updates) {
                    if (deletes.has(id))
                        continue;
                    await this.adapter.updateChunk(id, changes);
                    upserted++;
                }
            }
        }
        // Reclaim: prune versions older than an hour (well outside any in-flight
        // read/write) so per-search recall-stat writes and each consolidation
        // pass don't silently re-bloat the store. deleteUnverified is safe here
        // because nothing this store touches holds a transaction open for an hour.
        if (this.adapter.optimizeChunks)
            await this.adapter.optimizeChunks(3_600_000, true);
        return { updated: upserted, deleted: deletes.size };
    }
    chunkCount() { return this.adapter.chunkCount(); }
    vectorSearch(queryEmbedding, limit, filter) {
        return this.adapter.vectorSearch(queryEmbedding, limit, filter);
    }
    // ── Taxonomy ─────────────────────────────────────────────────────
    getTaxonomy() { return this.adapter.getTaxonomy(); }
    // ── Daily logs ───────────────────────────────────────────────────
    appendDailyEntry(date, entry) {
        return this.adapter.appendDailyEntry(date, entry);
    }
    getDailyLogs(daysBack) {
        return this.adapter.getDailyLogs(daysBack);
    }
    // ── Rules ────────────────────────────────────────────────────────
    saveRule(rule) { return this.adapter.saveRule(rule); }
    getRules() { return this.adapter.getRules(); }
    deleteRule(id) { return this.adapter.deleteRule(id); }
    // ── Knowledge triples ────────────────────────────────────────────
    saveTriple(triple) { return this.adapter.saveTriple(triple); }
    queryTriples(opts) { return this.adapter.queryTriples(opts); }
    invalidateTriple(id) { return this.adapter.invalidateTriple(id); }
    getTripleTimeline(entity) { return this.adapter.getTripleTimeline(entity); }
    getTripleStats() { return this.adapter.getTripleStats(); }
    // ── Diary + handoffs (new surface — server.ts routes through these
    //    when STORAGE_BACKEND=postgres so the markdown filesystem layer
    //    isn't required for cloud installs) ───────────────────────────
    writeDiaryEntry(content, agent) {
        return this.adapter.writeDiaryEntry(content, agent);
    }
    readDiary(opts) {
        return this.adapter.readDiary(opts);
    }
    listDiaryDates() { return this.adapter.listDiaryDates(); }
    writeHandoff(note) {
        return this.adapter.writeHandoff(note);
    }
    readHandoff(stamp) { return this.adapter.readHandoff(stamp); }
    listHandoffs(limit) { return this.adapter.listHandoffs(limit); }
    // ── Lifecycle ────────────────────────────────────────────────────
    close() {
        // Adapter close is optional + may be async; fire-and-forget for
        // backwards compat (the file backend's close is a no-op).
        if (this.adapter?.close) {
            Promise.resolve(this.adapter.close()).catch(() => { });
        }
    }
}
//# sourceMappingURL=storage.js.map