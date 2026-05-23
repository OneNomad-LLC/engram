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

import { randomUUID } from 'node:crypto';
import type {
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

// Minimal pg surface — typed loosely so we can avoid a hard dep on
// @types/pg at compile time. The real shape comes in at runtime via
// the dynamic import.
type PgClient = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
type PgPool = PgClient & { end(): Promise<void> };

export interface PostgresAdapterOptions {
  databaseUrl: string;
  tenantId: string;
  embeddingDim?: number; // default 384
  /** Pool size. Default 4 — engram runs as a single MCP process per user. */
  max?: number;
}

export class PostgresStorageAdapter implements StorageAdapter {
  private pool!: PgPool;
  private readonly tenantId: string;
  private readonly databaseUrl: string;
  private readonly embeddingDim: number;
  private readonly maxConnections: number;
  private ready: Promise<void>;

  constructor(opts: PostgresAdapterOptions) {
    this.tenantId = opts.tenantId;
    this.databaseUrl = opts.databaseUrl;
    this.embeddingDim = opts.embeddingDim ?? 384;
    this.maxConnections = opts.max ?? 4;
    this.ready = this.initAsync();
  }

  private async initAsync(): Promise<void> {
    // Dynamic import — pg is an optionalDependency. The string-variable
    // form intentionally defeats TypeScript's compile-time module
    // resolution, so file-mode environments without `pg` installed
    // still type-check.
    const pgModuleName = 'pg';
    let pgModule: any;
    try {
      pgModule = await import(/* @vite-ignore */ pgModuleName);
    } catch (err) {
      throw new Error(
        `STORAGE_BACKEND=postgres requires the 'pg' package. Install with: npm install pg`,
      );
    }
    const { Pool } = pgModule.default ?? pgModule;
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      max: this.maxConnections,
      ssl: resolvePostgresSsl(this.databaseUrl),
    }) as PgPool;
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private vectorLiteral(v: number[]): string {
    // pgvector accepts a string literal like '[0.1,0.2,...]' cast to vector.
    // Bind it as a regular parameter; the SQL contains the explicit cast.
    return `[${v.join(',')}]`;
  }

  private zeroVector(): string {
    return `[${new Array(this.embeddingDim).fill(0).join(',')}]`;
  }

  // ── Chunks ─────────────────────────────────────────────────────────

  async saveChunk(chunk: StoredChunk): Promise<void> {
    const { params } = this.chunkInsertParams(chunk);
    await this.pool.query(
      `INSERT INTO chunks (id, tenant_id, embedding, domain, content, metadata, created_at)
       VALUES ($1, $2, $3::vector, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         embedding = EXCLUDED.embedding,
         domain = EXCLUDED.domain,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata`,
      params,
    );
  }

  async saveChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    // One multi-row INSERT instead of N round-trips. Caller contract
    // (StorageAdapter.saveChunks) guarantees fresh ids; we still keep
    // ON CONFLICT DO NOTHING as a belt-and-suspenders against caller
    // bugs rather than crashing mid-batch.
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const chunk of chunks) {
      const row = this.chunkInsertParams(chunk).params;
      values.push(`($${++p}, $${++p}, $${++p}::vector, $${++p}, $${++p}, $${++p}::jsonb, $${++p})`);
      params.push(...row);
    }
    await this.pool.query(
      `INSERT INTO chunks (id, tenant_id, embedding, domain, content, metadata, created_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      params,
    );
  }

  private chunkInsertParams(chunk: StoredChunk): { params: unknown[] } {
    const embedding = chunk.embedding && chunk.embedding.length > 0
      ? this.vectorLiteral(chunk.embedding)
      : this.zeroVector();
    // metadata holds every field that doesn't get its own column —
    // keeps the SQL small and the schema flexible. The columns we DO
    // promote (domain, content, embedding, created_at) are the ones
    // we filter or vector-search by.
    const metadata = {
      tier: chunk.tier,
      type: chunk.type,
      cognitiveLayer: chunk.cognitiveLayer,
      tags: chunk.tags,
      topic: chunk.topic ?? '',
      source: chunk.source,
      importance: chunk.importance,
      sentiment: chunk.sentiment,
      lastRecalledAt: chunk.lastRecalledAt ?? null,
      recallCount: chunk.recallCount,
      relatedMemories: chunk.relatedMemories,
      recallOutcomes: chunk.recallOutcomes,
      stability: chunk.stability ?? 1.0,
      difficulty: chunk.difficulty ?? 0.3,
      temporalAnchor: chunk.temporalAnchor ?? 0,
      consolidationLevel: chunk.consolidationLevel ?? 0,
      sourceChunkIds: chunk.sourceChunkIds ?? [],
      embeddingVersion: chunk.embeddingVersion ?? 1,
      parentChunkId: chunk.parentChunkId ?? '',
      origin: chunk.origin ?? 'derived',
    };
    return {
      params: [
        chunk.id,
        this.tenantId,
        embedding,
        chunk.domain ?? '',
        chunk.content,
        JSON.stringify(metadata),
        chunk.createdAt,
      ],
    };
  }

  async getChunk(id: string): Promise<StoredChunk | null> {
    const { rows } = await this.pool.query(
      `SELECT id, domain, content, metadata, embedding::text AS embedding, created_at
         FROM chunks
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1`,
      [this.tenantId, id],
    );
    return rows[0] ? pgRowToChunk(rows[0], this.embeddingDim) : null;
  }

  async deleteChunk(id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM chunks WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id],
    );
  }

  async listChunks(opts?: ListChunksOpts): Promise<StoredChunk[]> {
    const conds: string[] = ['tenant_id = $1'];
    const params: unknown[] = [this.tenantId];

    if (opts?.excludeTiers && opts.excludeTiers.length > 0) {
      for (const t of opts.excludeTiers) {
        params.push(t);
        conds.push(`metadata->>'tier' != $${params.length}`);
      }
    }
    if (opts?.tier) {
      params.push(opts.tier);
      conds.push(`metadata->>'tier' = $${params.length}`);
    }
    if (opts?.cognitiveLayer) {
      params.push(opts.cognitiveLayer);
      conds.push(`metadata->>'cognitiveLayer' = $${params.length}`);
    }
    if (opts?.domain) {
      params.push(opts.domain);
      conds.push(`domain = $${params.length}`);
    }
    if (opts?.topic) {
      params.push(opts.topic);
      conds.push(`metadata->>'topic' = $${params.length}`);
    }
    if (opts?.tag) {
      // jsonb array containment: metadata->'tags' @> '["foo"]'
      params.push(JSON.stringify([opts.tag]));
      conds.push(`metadata->'tags' @> $${params.length}::jsonb`);
    }

    const { rows } = await this.pool.query(
      `SELECT id, domain, content, metadata, embedding::text AS embedding, created_at
         FROM chunks
        WHERE ${conds.join(' AND ')}`,
      params,
    );
    return rows.map((r) => pgRowToChunk(r, this.embeddingDim));
  }

  async updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void> {
    // The pre-adapter Storage had a flat-column layout, so updates
    // touched named columns. Here we merge into the metadata jsonb
    // (for non-promoted fields) and update promoted columns directly.
    //
    // Cheapest correct path: load, mutate in memory, save. This is N+1
    // for bulk updates but matches the existing code's behavior, where
    // updateChunk is called per-id from consolidate/outcome/etc.
    const existing = await this.getChunk(id);
    if (!existing) return;
    const merged: StoredChunk = { ...existing, ...updates };
    await this.saveChunk(merged);
  }

  async chunkCount(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM chunks WHERE tenant_id = $1`,
      [this.tenantId],
    );
    return rows[0]?.n ?? 0;
  }

  async vectorSearch(queryEmbedding: number[], limit: number, filter?: string): Promise<VectorHit[]> {
    // pgvector cosine distance operator: <=>
    // filter is a SQL-ish predicate from search.ts referring to the
    // pre-adapter column names (tier, consolidation_level). Translate
    // those references to the postgres jsonb-keyed layout.
    const params: unknown[] = [this.tenantId, this.vectorLiteral(queryEmbedding), limit];
    let extra = '';
    if (filter) {
      const translated = translateFilter(filter);
      extra = ` AND (${translated})`;
    }
    const { rows } = await this.pool.query(
      `SELECT id, domain, content, metadata, embedding::text AS embedding, created_at,
              embedding <=> $2::vector AS distance
         FROM chunks
        WHERE tenant_id = $1${extra}
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      params,
    );
    return rows.map((row) => ({
      chunk: pgRowToChunk(row, this.embeddingDim),
      distance: Number(row.distance ?? 1),
    }));
  }

  // ── Taxonomy ──────────────────────────────────────────────────────

  async getTaxonomy(): Promise<Record<string, Record<string, number>>> {
    const chunks = await this.listChunks({ excludeTiers: ['archive'] });
    const tree: Record<string, Record<string, number>> = {};
    for (const c of chunks) {
      const d = c.domain || '(uncategorized)';
      const t = c.topic || '(general)';
      if (!tree[d]) tree[d] = {};
      tree[d][t] = (tree[d][t] ?? 0) + 1;
    }
    return tree;
  }

  // ── Daily Logs ────────────────────────────────────────────────────

  async appendDailyEntry(date: string, entry: DailyLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO daily_logs (date, tenant_id, entry, created_at)
       VALUES ($1::date, $2, $3::jsonb, NOW())`,
      [
        date,
        this.tenantId,
        JSON.stringify({
          timestamp: entry.timestamp,
          conversationId: entry.conversationId,
          summary: entry.summary,
          extractedFacts: entry.extractedFacts,
        }),
      ],
    );
  }

  async getDailyLogs(daysBack: number): Promise<Array<{ date: string; entries: DailyLogEntry[] }>> {
    const { rows } = await this.pool.query(
      `SELECT date::text AS date, entry
         FROM daily_logs
        WHERE tenant_id = $1 AND date >= (CURRENT_DATE - ($2 || ' days')::interval)
        ORDER BY date, created_at`,
      [this.tenantId, String(daysBack)],
    );
    const grouped = new Map<string, DailyLogEntry[]>();
    for (const r of rows) {
      const e = r.entry as any;
      const entries = grouped.get(r.date) ?? [];
      entries.push({
        timestamp: e.timestamp,
        conversationId: e.conversationId,
        summary: e.summary,
        extractedFacts: e.extractedFacts ?? [],
      });
      grouped.set(r.date, entries);
    }
    return Array.from(grouped.entries()).map(([date, entries]) => ({ date, entries }));
  }

  // ── Procedural Rules ──────────────────────────────────────────────

  async saveRule(rule: ProceduralRule): Promise<void> {
    await this.pool.query(
      `INSERT INTO rules (id, tenant_id, rule, created_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET rule = EXCLUDED.rule, tenant_id = EXCLUDED.tenant_id`,
      [rule.id, this.tenantId, JSON.stringify(rule), rule.createdAt],
    );
  }

  async getRules(): Promise<ProceduralRule[]> {
    const { rows } = await this.pool.query(
      `SELECT rule FROM rules WHERE tenant_id = $1`,
      [this.tenantId],
    );
    return rows
      .map((r) => r.rule as ProceduralRule)
      .sort((a, b) => b.confidence - a.confidence);
  }

  async deleteRule(id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM rules WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id],
    );
  }

  // ── Knowledge Triples ────────────────────────────────────────────

  async saveTriple(triple: KnowledgeTriple): Promise<void> {
    // R-002 + R-004: insert with confidence; use the partial UNIQUE index
    // (knowledge_triples_active_spo_idx) as the conflict target so that
    // concurrent addTriple calls for the same active SPO do not produce
    // duplicate rows.  When a conflict fires (DO NOTHING, rowCount = 0)
    // we bump confidence on the surviving row instead.
    const result = await this.pool.query(
      `INSERT INTO knowledge_triples
         (id, tenant_id, subject, predicate, object, source_id, confidence, invalidated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, subject, predicate, object)
         WHERE invalidated_at IS NULL
       DO NOTHING`,
      [
        triple.id,
        this.tenantId,
        triple.subject,
        triple.predicate,
        triple.object,
        triple.source ?? '',
        triple.confidence ?? 0.5,
        triple.validTo ?? null,
        triple.createdAt,
      ],
    );

    if ((result.rowCount ?? 0) === 0) {
      // An active triple with this SPO already exists (either a
      // concurrent race or an explicit addTriple on a known triple).
      // Bump its confidence, mirroring the app-level logic in
      // knowledge-graph.ts addTriple.
      await this.pool.query(
        `UPDATE knowledge_triples
            SET confidence = LEAST(1.0, confidence + 0.1)
          WHERE tenant_id = $1
            AND subject   = $2
            AND predicate = $3
            AND object    = $4
            AND invalidated_at IS NULL`,
        [this.tenantId, triple.subject, triple.predicate, triple.object],
      );
    }
    // valid_from is part of the domain object but not in the spec's
    // schema — fold it into source_id-adjacent metadata is overkill;
    // we keep validFrom == createdAt for postgres mode and surface
    // createdAt on read. przm Memory's bench uses validTo for invalidation
    // which IS preserved.
  }

  async queryTriples(opts?: QueryTriplesOpts): Promise<KnowledgeTriple[]> {
    const conds: string[] = ['tenant_id = $1'];
    const params: unknown[] = [this.tenantId];
    if (opts?.subject) { params.push(opts.subject); conds.push(`subject = $${params.length}`); }
    if (opts?.predicate) { params.push(opts.predicate); conds.push(`predicate = $${params.length}`); }
    if (opts?.object) { params.push(opts.object); conds.push(`object = $${params.length}`); }
    if (opts?.activeOnly) conds.push(`invalidated_at IS NULL`);

    const { rows } = await this.pool.query(
      `SELECT id, subject, predicate, object, source_id, confidence, invalidated_at, created_at
         FROM knowledge_triples
        WHERE ${conds.join(' AND ')}`,
      params,
    );
    return rows.map(pgRowToTriple);
  }

  async invalidateTriple(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_triples SET invalidated_at = NOW()
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, id],
    );
  }

  async getTripleTimeline(entity: string): Promise<KnowledgeTriple[]> {
    const { rows } = await this.pool.query(
      `SELECT id, subject, predicate, object, source_id, confidence, invalidated_at, created_at
         FROM knowledge_triples
        WHERE tenant_id = $1 AND (subject = $2 OR object = $2)
        ORDER BY created_at ASC`,
      [this.tenantId, entity],
    );
    return rows.map(pgRowToTriple);
  }

  async getTripleStats(): Promise<TripleStats> {
    const { rows } = await this.pool.query(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE invalidated_at IS NULL)::int AS active,
          COUNT(*) FILTER (WHERE invalidated_at IS NOT NULL)::int AS invalidated,
          COUNT(DISTINCT subject)::int AS subjects,
          COUNT(DISTINCT predicate)::int AS predicates
         FROM knowledge_triples
        WHERE tenant_id = $1`,
      [this.tenantId],
    );
    const r = rows[0] ?? { total: 0, active: 0, invalidated: 0, subjects: 0, predicates: 0 };
    return { total: r.total, active: r.active, invalidated: r.invalidated, subjects: r.subjects, predicates: r.predicates };
  }

  // ── Diary ─────────────────────────────────────────────────────────

  async writeDiaryEntry(content: string, agent: string = 'claude'): Promise<DiaryEntry> {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toISOString().split('T')[1].split('.')[0];
    const trimmed = content.trim();
    await this.pool.query(
      `INSERT INTO diary_entries (date, tenant_id, agent, content, created_at)
       VALUES ($1::date, $2, $3, $4, $5)`,
      [date, this.tenantId, agent, trimmed, now.toISOString()],
    );
    return { date, time, content: trimmed, agent };
  }

  async readDiary(opts?: ReadDiaryOpts): Promise<Array<{ date: string; entries: DiaryEntry[] }>> {
    const conds: string[] = ['tenant_id = $1'];
    const params: unknown[] = [this.tenantId];

    if (opts?.date) {
      params.push(opts.date);
      conds.push(`date = $${params.length}::date`);
    } else {
      const daysBack = opts?.daysBack ?? 7;
      params.push(String(daysBack));
      conds.push(`date >= (CURRENT_DATE - ($${params.length} || ' days')::interval)`);
    }
    if (opts?.agent) {
      params.push(opts.agent);
      conds.push(`agent = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT date::text AS date, agent, content, created_at
         FROM diary_entries
        WHERE ${conds.join(' AND ')}
        ORDER BY date DESC, created_at ASC`,
      params,
    );
    const grouped = new Map<string, DiaryEntry[]>();
    for (const r of rows) {
      const created = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
      const time = created.toISOString().split('T')[1].split('.')[0];
      const entries = grouped.get(r.date) ?? [];
      entries.push({ date: r.date, time, content: r.content, agent: r.agent });
      grouped.set(r.date, entries);
    }
    return Array.from(grouped.entries()).map(([date, entries]) => ({ date, entries }));
  }

  async listDiaryDates(): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT date::text AS date
         FROM diary_entries
        WHERE tenant_id = $1
        ORDER BY date DESC`,
      [this.tenantId],
    );
    return rows.map((r) => r.date);
  }

  // ── Handoffs ─────────────────────────────────────────────────────

  async writeHandoff(note: Omit<HandoffNote, 'timestamp'>): Promise<HandoffNote> {
    const timestamp = new Date().toISOString();
    const full: HandoffNote = { ...note, timestamp };
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO handoffs (id, tenant_id, content_json, content_md, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [id, this.tenantId, JSON.stringify(full), formatHandoffMarkdown(full), timestamp],
    );
    return full;
  }

  async readHandoff(stamp?: string): Promise<HandoffNote | null> {
    // In file mode `stamp` is the timestamped filename. In postgres
    // mode we treat it as the handoff row id; callers that supply the
    // result of listHandoffs() get a stamp that round-trips correctly.
    if (stamp) {
      const { rows } = await this.pool.query(
        `SELECT content_json FROM handoffs WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [this.tenantId, stamp],
      );
      return rows[0] ? (rows[0].content_json as HandoffNote) : null;
    }
    const { rows } = await this.pool.query(
      `SELECT content_json FROM handoffs
        WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [this.tenantId],
    );
    return rows[0] ? (rows[0].content_json as HandoffNote) : null;
  }

  async listHandoffs(limit: number = 10): Promise<HandoffSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT id, content_json, created_at
         FROM handoffs
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [this.tenantId, limit],
    );
    return rows.map((r) => {
      const note = r.content_json as HandoffNote;
      return {
        stamp: r.id,
        timestamp: note.timestamp,
        reason: note.reason,
        currentTask: note.currentTask,
      };
    });
  }
}

// ── SSL resolution ─────────────────────────────────────────────────

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
export function resolvePostgresSsl(
  connectionString: string,
): false | { rejectUnauthorized: boolean } {
  // Explicit opt-out via env var — useful in Docker, SSH tunnels,
  // and any environment where the hostname isn't localhost but SSL
  // is not configured.
  const envOverride = process.env.ENGRAM_PG_SSL?.toLowerCase();
  if (envOverride === 'off' || envOverride === 'false' || envOverride === '0') return false;
  if (envOverride === 'on' || envOverride === 'true' || envOverride === '1') {
    return { rejectUnauthorized: true };
  }

  // Localhost never needs SSL.
  if (
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1') ||
    connectionString.includes('[::1]')
  ) {
    return false;
  }

  // All other cloud / remote hosts default to SSL required.
  return { rejectUnauthorized: true };
}

// ── Filter translation ──────────────────────────────────────────────

/**
 * Translate filter strings written against the LanceDB flat-column
 * layout (e.g. "tier != 'archive' AND consolidation_level != -1") into
 * the postgres jsonb-keyed layout. Conservative: handles the small,
 * fixed set of predicates the codebase actually emits (see search.ts).
 */
function translateFilter(filter: string): string {
  return filter
    .replace(/\btier\b/g, `metadata->>'tier'`)
    .replace(/\bconsolidation_level\b/g, `(metadata->>'consolidationLevel')::int`)
    .replace(/\bcognitive_layer\b/g, `metadata->>'cognitiveLayer'`)
    .replace(/\bdomain\b/g, `domain`)
    .replace(/\btopic\b/g, `metadata->>'topic'`);
}

// ── Row decoders ────────────────────────────────────────────────────

function parseEmbedding(raw: unknown, dim: number): number[] | undefined {
  if (typeof raw !== 'string') return undefined;
  // pgvector ::text outputs as "[0.1,0.2,...]"
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1);
  if (!inner) return undefined;
  const arr = inner.split(',').map((s) => Number(s));
  if (arr.length !== dim) return arr; // tolerant
  if (arr.every((v) => v === 0)) return undefined;
  return arr;
}

function pgRowToChunk(row: any, embeddingDim: number = 384): StoredChunk {
  const meta = row.metadata ?? {};
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const embedding = parseEmbedding(row.embedding, embeddingDim);
  return {
    id: row.id,
    tier: meta.tier ?? 'daily',
    content: row.content,
    type: meta.type ?? 'fact',
    cognitiveLayer: meta.cognitiveLayer ?? 'semantic',
    tags: meta.tags ?? [],
    domain: row.domain ?? '',
    topic: meta.topic ?? '',
    source: meta.source ?? '',
    importance: meta.importance ?? 0.5,
    sentiment: meta.sentiment ?? 'neutral',
    createdAt: created,
    lastRecalledAt: meta.lastRecalledAt ?? null,
    recallCount: meta.recallCount ?? 0,
    embedding,
    relatedMemories: meta.relatedMemories ?? [],
    recallOutcomes: meta.recallOutcomes ?? [],
    stability: meta.stability ?? 1.0,
    difficulty: meta.difficulty ?? 0.3,
    temporalAnchor: meta.temporalAnchor ?? undefined,
    consolidationLevel: meta.consolidationLevel ?? 0,
    sourceChunkIds: meta.sourceChunkIds,
    embeddingVersion: meta.embeddingVersion ?? 1,
    parentChunkId: meta.parentChunkId || undefined,
    origin: meta.origin ?? 'derived',
  };
}

function pgRowToTriple(row: any): KnowledgeTriple {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  const invalidated = row.invalidated_at
    ? (row.invalidated_at instanceof Date ? row.invalidated_at.toISOString() : String(row.invalidated_at))
    : null;
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    source: row.source_id ?? '',
    confidence: row.confidence != null ? Number(row.confidence) : 0.5,
    validFrom: created,
    validTo: invalidated,
    createdAt: created,
  };
}

// ── Handoff markdown formatter (mirrors handoff.ts) ─────────────────

function formatHandoffMarkdown(note: HandoffNote): string {
  const lines: string[] = [
    `# Handoff — ${note.timestamp}`,
    '',
    `**Reason:** ${note.reason}`,
    note.sessionId ? `**Session:** ${note.sessionId}` : '',
    '',
    '## Current Task',
    note.currentTask || '_unspecified_',
    '',
  ];

  if (note.completed.length) {
    lines.push('## Completed', ...note.completed.map((c) => `- ${c}`), '');
  }
  if (note.nextSteps.length) {
    lines.push('## Next Steps', ...note.nextSteps.map((s) => `- ${s}`), '');
  }
  if (note.openQuestions.length) {
    lines.push('## Open Questions', ...note.openQuestions.map((q) => `- ${q}`), '');
  }
  if (note.fileRefs.length) {
    lines.push('## File Refs', ...note.fileRefs.map((f) => `- ${f}`), '');
  }
  if (note.decisions.length) {
    lines.push('## Decisions', ...note.decisions.map((d) => `- ${d}`), '');
  }
  if (note.notes.trim()) {
    lines.push('## Notes', note.notes.trim(), '');
  }

  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
