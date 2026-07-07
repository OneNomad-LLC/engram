/**
 * FileStorageAdapter — the default backend.
 *
 * LanceDB tables under <dataDir>/lance for chunks/daily_logs/rules/
 * knowledge_triples. Markdown files under <dataDir>/diary and JSON+MD
 * files under <dataDir>/handoffs.
 *
 * Behavior must remain byte-identical to the pre-adapter Storage class
 * for the file path — same on-disk schema, same markdown formats, same
 * directory layout. The legacy Storage class in storage.ts is now a
 * thin shim over this adapter.
 */
import type { DailyLogEntry, ProceduralRule, KnowledgeTriple, DiaryEntry } from './types.js';
import type { StorageAdapter, StoredChunk, ListChunksOpts, QueryTriplesOpts, TripleStats, VectorHit, ReadDiaryOpts, HandoffNote, HandoffSummary } from './storage-adapter.js';
export declare class FileStorageAdapter implements StorageAdapter {
    private db;
    private chunks;
    private dailyLogs;
    private rules;
    private triples;
    private dbPath;
    private ready;
    readonly dataDir: string;
    constructor(dataDir: string);
    private initAsync;
    ensureReady(): Promise<void>;
    close(): void;
    saveChunk(chunk: StoredChunk): Promise<void>;
    saveChunks(chunks: StoredChunk[]): Promise<void>;
    getChunk(id: string): Promise<StoredChunk | null>;
    deleteChunk(id: string): Promise<void>;
    listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]>;
    updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void>;
    /**
     * Batched upsert. mergeInsert on `id` applies every row change in a
     * single operation instead of one scan-and-rewrite per row. Rows are
     * serialized through the same chunkToRow path as saveChunks, so this
     * carries no serialization risk the insert path doesn't already carry.
     */
    updateChunks(chunks: StoredChunk[]): Promise<void>;
    /** Batched delete. One predicate per 500 ids so the IN list stays sane. */
    deleteChunks(ids: string[]): Promise<void>;
    /**
     * Compact + prune. Without args, a safe compaction that keeps 7 days of
     * versions. With olderThanMs, also prunes versions older than that many
     * ms (0 = keep only the current version). deleteUnverified lets it remove
     * files younger than 7 days — only pass true when no other process is
     * writing the store (CLI reembed/compact), never from the running server
     * with an aggressive window.
     */
    optimizeChunks(olderThanMs?: number, deleteUnverified?: boolean): Promise<void>;
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
