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
import type { MemoryTier, DailyLogEntry, ProceduralRule, KnowledgeTriple, DiaryEntry } from './types.js';
import type { StoredChunk, ListChunksOpts, QueryTriplesOpts, TripleStats, VectorHit, ReadDiaryOpts, HandoffNote, HandoffSummary } from './storage-adapter.js';
export type { StoredChunk } from './storage-adapter.js';
export declare class Storage {
    private adapter;
    private ready;
    private batch;
    constructor(dataDir: string);
    ensureReady(): Promise<void>;
    saveChunk(chunk: StoredChunk): Promise<void>;
    saveChunks(chunks: StoredChunk[]): Promise<void>;
    getChunk(id: string): Promise<StoredChunk | null>;
    deleteChunk(id: string): Promise<void>;
    listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]>;
    updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void>;
    /**
     * Enter batched-write mode. While open, updateChunk/deleteChunk buffer
     * in memory. Consolidation opens a batch around all its passes because
     * decay/link/merge touch nearly every chunk, and per-row LanceDB writes
     * scan + rewrite a fragment each — thousands of them serialized is the
     * difference between a few seconds and over an hour on a real store.
     * saveChunk/saveChunks are NOT buffered (inserts are already batched and
     * some passes read them back mid-run).
     */
    beginBatch(): void;
    /** Batched upsert of full rows. Falls back to per-row updateChunk for
     *  adapters without the primitive. Not affected by batch mode — this is
     *  the direct bulk path used by reembed. */
    updateChunks(chunks: StoredChunk[]): Promise<void>;
    /** Compact + prune the chunk table. See StorageAdapter.optimizeChunks. */
    optimizeChunks(olderThanMs?: number, deleteUnverified?: boolean): Promise<void>;
    /**
     * Commit and close the batch: one bulk upsert (mergeInsert), one bulk
     * delete, then a table compaction. Reads the current chunks once, applies
     * the buffered partials through the same rowToChunk/chunkToRow path a
     * normal save uses, and upserts. Falls back to per-row writes for
     * adapters that don't implement the batch primitives (postgres/cloud).
     */
    flushBatch(): Promise<{
        updated: number;
        deleted: number;
    }>;
    chunkCount(): Promise<number>;
    vectorSearch(queryEmbedding: number[], limit: number, filter?: string): Promise<VectorHit[]>;
    getTaxonomy(): Promise<Record<string, Record<string, number>>>;
    appendDailyEntry(date: string, entry: DailyLogEntry): Promise<void>;
    getDailyLogs(daysBack: number): Promise<Array<{
        date: string;
        entries: DailyLogEntry[];
    }>>;
    saveRule(rule: ProceduralRule): Promise<void>;
    getRules(): Promise<ProceduralRule[]>;
    deleteRule(id: string): Promise<void>;
    saveTriple(triple: KnowledgeTriple): Promise<void>;
    queryTriples(opts?: QueryTriplesOpts): Promise<KnowledgeTriple[]>;
    invalidateTriple(id: string): Promise<void>;
    getTripleTimeline(entity: string): Promise<KnowledgeTriple[]>;
    getTripleStats(): Promise<TripleStats>;
    writeDiaryEntry(content: string, agent?: string): Promise<DiaryEntry>;
    readDiary(opts?: ReadDiaryOpts): Promise<Array<{
        date: string;
        entries: DiaryEntry[];
    }>>;
    listDiaryDates(): Promise<string[]>;
    writeHandoff(note: Omit<HandoffNote, 'timestamp'>): Promise<HandoffNote>;
    readHandoff(stamp?: string): Promise<HandoffNote | null>;
    listHandoffs(limit?: number): Promise<HandoffSummary[]>;
    close(): void;
}
export type { MemoryTier };
