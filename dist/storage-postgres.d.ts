/**
 * PostgresStorageAdapter — multi-tenant cloud backend.
 *
 * Schema (created by `engram-migrate`):
 *   chunks            — pgvector 384-dim embedding + jsonb metadata
 *   daily_logs        — per-day rollups, one row per appended entry
 *   rules             — procedural rules, jsonb payload
 *   knowledge_triples — temporal triples with invalidated_at
 *   diary_entries     — one row per `## HH:MM:SS (agent)` block
 *   handoffs          — JSON+markdown pair stored as columns
 *
 * Every query is scoped by tenant_id. No exceptions. The tenant id is
 * fixed at construction time from $TENANT_ID.
 *
 * The `pg` driver is dynamic-imported so file-mode users don't need to
 * install it. The package declares pg as an optionalDependency.
 */
import type { DailyLogEntry, ProceduralRule, KnowledgeTriple, DiaryEntry } from './types.js';
import type { StorageAdapter, StoredChunk, ListChunksOpts, QueryTriplesOpts, TripleStats, VectorHit, ReadDiaryOpts, HandoffNote, HandoffSummary } from './storage-adapter.js';
export interface PostgresAdapterOptions {
    databaseUrl: string;
    tenantId: string;
    embeddingDim?: number;
    /** Pool size. Default 4 — engram runs as a single MCP process per user. */
    max?: number;
}
export declare class PostgresStorageAdapter implements StorageAdapter {
    private pool;
    private readonly tenantId;
    private readonly databaseUrl;
    private readonly embeddingDim;
    private readonly maxConnections;
    private ready;
    constructor(opts: PostgresAdapterOptions);
    private initAsync;
    ensureReady(): Promise<void>;
    close(): Promise<void>;
    private vectorLiteral;
    private zeroVector;
    saveChunk(chunk: StoredChunk): Promise<void>;
    saveChunks(chunks: StoredChunk[]): Promise<void>;
    private chunkInsertParams;
    getChunk(id: string): Promise<StoredChunk | null>;
    deleteChunk(id: string): Promise<void>;
    listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]>;
    updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void>;
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
/**
 * Determine the ssl option for the pg Pool constructor.
 *
 * Cloud Postgres (Supabase, Neon, Heroku, RDS) requires SSL. Localhost
 * and explicit opt-out do not.
 *
 * R-005: previously the Pool was created without ssl at all, which
 * caused plaintext connections on cloud providers that require
 * sslmode=require.
 *
 * Opt-out: set ENGRAM_PG_SSL=off to disable SSL (Docker, tunnels, etc.)
 */
export declare function resolvePostgresSsl(connectionString: string): false | {
    rejectUnauthorized: boolean;
};
