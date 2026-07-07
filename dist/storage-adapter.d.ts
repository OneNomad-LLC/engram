/**
 * StorageAdapter — the storage contract every backend implements.
 *
 * przm Memory supports two backends today:
 *   - file       (default; LanceDB tables + markdown/JSON files under ENGRAM_DATA_DIR)
 *   - postgres   (multi-tenant cloud; pgvector + jsonb columns)
 *
 * The adapter is pure async, scoped to a single tenant when running on
 * postgres. No backend types (lancedb.Table, pg.Pool, fs.PathLike) leak
 * through this interface — callers depend only on the shapes in
 * src/types.ts and the few extra shapes re-exported below.
 *
 * Single-tenant file installs see no behavior change. Cloud installs
 * route every query through `tenant_id`.
 */
import type { MemoryChunk, MemoryEdge, RecallOutcome, DailyLogEntry, MemoryTier, ProceduralRule, KnowledgeTriple, DiaryEntry } from './types.js';
export interface StoredChunk extends MemoryChunk {
    relatedMemories: MemoryEdge[];
    recallOutcomes: RecallOutcome[];
}
export interface HandoffNote {
    timestamp: string;
    sessionId: string | null;
    reason: 'compact' | 'session-end' | 'manual' | 'context-pressure';
    currentTask: string;
    completed: string[];
    nextSteps: string[];
    openQuestions: string[];
    fileRefs: string[];
    decisions: string[];
    notes: string;
}
export interface HandoffSummary {
    stamp: string;
    timestamp: string;
    reason: string;
    currentTask: string;
}
export interface ListChunksOpts {
    excludeTiers?: MemoryTier[];
    tier?: MemoryTier;
    cognitiveLayer?: string;
    domain?: string;
    topic?: string;
    tag?: string;
}
export interface QueryTriplesOpts {
    subject?: string;
    predicate?: string;
    object?: string;
    activeOnly?: boolean;
}
export interface TripleStats {
    total: number;
    active: number;
    invalidated: number;
    subjects: number;
    predicates: number;
}
export interface VectorHit {
    chunk: StoredChunk;
    distance: number;
}
export interface ReadDiaryOpts {
    date?: string;
    daysBack?: number;
    agent?: string;
}
export interface StorageAdapter {
    ensureReady(): Promise<void>;
    close?(): Promise<void> | void;
    saveChunk(chunk: StoredChunk): Promise<void>;
    /**
     * Batched write. Treat every chunk as new — do NOT delete-then-insert
     * the way saveChunk() does. Callers must only pass freshly-minted
     * chunks (new UUIDs). This exists because single-row writes against
     * LanceDB don't scale: each saveChunk creates a new fragment, and per-
     * row delete-before-add scans the growing manifest. A single batched
     * insert is the cliff fix for ingest throughput.
     */
    saveChunks(chunks: StoredChunk[]): Promise<void>;
    getChunk(id: string): Promise<StoredChunk | null>;
    deleteChunk(id: string): Promise<void>;
    listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]>;
    updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void>;
    /**
     * Batched upsert of full chunk rows (one mergeInsert on `id`). Optional:
     * Storage.flushBatch() falls back to per-row updateChunk when an adapter
     * doesn't implement it. This is the write-side twin of saveChunks — it
     * exists because per-row LanceDB updates each scan + rewrite a fragment,
     * so consolidation over a few thousand chunks (decay/link touch nearly
     * every row) turned into thousands of serialized slow writes.
     */
    updateChunks?(chunks: StoredChunk[]): Promise<void>;
    /** Batched delete by id. Optional — falls back to per-row deleteChunk. */
    deleteChunks?(ids: string[]): Promise<void>;
    /**
     * Compact + prune the chunk table. LanceDB point-updates and mergeInsert
     * leave delta fragments AND old versions on disk; without pruning, the
     * store bloats (a 260MB store hit 3.9GB after two per-row reembed passes)
     * and every later write scans a longer manifest. With no args, does a
     * safe compaction keeping 7 days of versions. Pass olderThanMs to also
     * prune versions older than that many ms (0 = keep only current);
     * deleteUnverified must be true to remove files younger than 7 days, and
     * is only safe when no other process is writing the store. Optional.
     */
    optimizeChunks?(olderThanMs?: number, deleteUnverified?: boolean): Promise<void>;
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
}
export type { MemoryEdge, RecallOutcome } from './types.js';
