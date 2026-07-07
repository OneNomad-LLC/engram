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
import * as lancedb from '@lancedb/lancedb';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeDiaryEntry as fsWriteDiaryEntry, readDiary as fsReadDiary, listDiaryDates as fsListDiaryDates, } from './diary.js';
import { writeHandoff as fsWriteHandoff, readHandoff as fsReadHandoff, listHandoffs as fsListHandoffs, } from './handoff.js';
export class FileStorageAdapter {
    db;
    chunks;
    dailyLogs;
    rules;
    triples;
    dbPath;
    ready;
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.dbPath = join(dataDir, 'lance');
        // 0700 = owner-only access. Memory data may include sensitive
        // chat history, decisions, personal facts -- it shouldn't be
        // world-readable on shared/multi-user systems. Defensive only;
        // umask still applies on existing dirs.
        if (!existsSync(dataDir))
            mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.ready = this.initAsync();
    }
    async initAsync() {
        this.db = await lancedb.connect(this.dbPath);
        const tableNames = await this.db.tableNames();
        // ── Chunks table ─────────────────────────────────────────────
        if (tableNames.includes('chunks')) {
            this.chunks = await this.db.openTable('chunks');
            // Migration: add origin column to pre-existing tables. addColumns
            // throws if the column already exists, which is the success path
            // on second boot — swallow it.
            try {
                await this.chunks.addColumns([{ name: 'origin', valueSql: "'derived'" }]);
            }
            catch { /* column already present */ }
        }
        else {
            this.chunks = await this.db.createTable('chunks', [{
                    id: '__init__',
                    tier: 'daily',
                    content: '',
                    type: 'fact',
                    cognitive_layer: 'semantic',
                    tags: '[]',
                    domain: '',
                    topic: '',
                    source: '',
                    importance: 0.5,
                    sentiment: 'neutral',
                    created_at: new Date().toISOString(),
                    last_recalled_at: '',
                    recall_count: 0,
                    embedding: new Array(384).fill(0),
                    related_memories: '[]',
                    recall_outcomes: '[]',
                    stability: 1.0,
                    difficulty: 0.3,
                    temporal_anchor: 0,
                    consolidation_level: 0,
                    source_chunk_ids: '[]',
                    embedding_version: 1,
                    parent_chunk_id: '',
                    origin: 'derived',
                }]);
            await this.chunks.delete('id = \'__init__\'');
        }
        // ── Daily logs table ─────────────────────────────────────────
        if (tableNames.includes('daily_logs')) {
            this.dailyLogs = await this.db.openTable('daily_logs');
        }
        else {
            this.dailyLogs = await this.db.createTable('daily_logs', [{
                    row_id: '__init__',
                    date: '',
                    timestamp: '',
                    conversation_id: '',
                    summary: '',
                    extracted_facts: '[]',
                }]);
            await this.dailyLogs.delete('row_id = \'__init__\'');
        }
        // ── Rules table ──────────────────────────────────────────────
        if (tableNames.includes('rules')) {
            this.rules = await this.db.openTable('rules');
        }
        else {
            this.rules = await this.db.createTable('rules', [{
                    id: '__init__',
                    rule: '',
                    domain: 'general',
                    confidence: 0.5,
                    reinforcements: 0,
                    contradictions: 0,
                    evidence: '[]',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }]);
            await this.rules.delete('id = \'__init__\'');
        }
        // ── Knowledge triples table ─────────────────────────────────
        if (tableNames.includes('knowledge_triples')) {
            this.triples = await this.db.openTable('knowledge_triples');
        }
        else {
            this.triples = await this.db.createTable('knowledge_triples', [{
                    id: '__init__',
                    subject: '',
                    predicate: '',
                    object: '',
                    source: '',
                    confidence: 0.5,
                    valid_from: new Date().toISOString(),
                    valid_to: '',
                    created_at: new Date().toISOString(),
                }]);
            await this.triples.delete('id = \'__init__\'');
        }
        // Scalar indices on the triples hot path. See the original
        // commentary in the pre-adapter Storage for the perf rationale.
        const indexes = [
            { col: 'subject', idx: lancedb.Index.btree() },
            { col: 'object', idx: lancedb.Index.btree() },
            { col: 'predicate', idx: lancedb.Index.bitmap() },
            { col: 'valid_to', idx: lancedb.Index.bitmap() },
        ];
        for (const { col, idx } of indexes) {
            try {
                await this.triples.createIndex(col, { config: idx });
            }
            catch {
                // Index already exists, or column not indexable. Silent
                // fallthrough — queries still work, just without acceleration.
            }
        }
    }
    async ensureReady() {
        await this.ready;
    }
    close() {
        // LanceDB connections don't need explicit closing in the JS driver
    }
    // ── Chunk Operations ──────────────────────────────────────────────
    async saveChunk(chunk) {
        try {
            await this.chunks.delete(`id = '${esc(chunk.id)}'`);
        }
        catch { /* noop */ }
        await this.chunks.add([chunkToRow(chunk)]);
    }
    async saveChunks(chunks) {
        if (chunks.length === 0)
            return;
        // Fresh-insert path: one append per call, no delete. The contract
        // (see StorageAdapter.saveChunks) is that callers only pass new ids.
        await this.chunks.add(chunks.map(chunkToRow));
    }
    async getChunk(id) {
        const rows = await this.chunks.query()
            .where(`id = '${esc(id)}'`)
            .limit(1)
            .toArray();
        return rows.length > 0 ? rowToChunk(rows[0]) : null;
    }
    async deleteChunk(id) {
        await this.chunks.delete(`id = '${esc(id)}'`);
    }
    async listChunks(opts) {
        let q = this.chunks.query();
        const conditions = [];
        if (opts?.excludeTiers && opts.excludeTiers.length > 0) {
            for (const t of opts.excludeTiers) {
                conditions.push(`tier != '${esc(t)}'`);
            }
        }
        if (opts?.tier) {
            conditions.push(`tier = '${esc(opts.tier)}'`);
        }
        if (opts?.cognitiveLayer) {
            conditions.push(`cognitive_layer = '${esc(opts.cognitiveLayer)}'`);
        }
        if (opts?.domain) {
            conditions.push(`domain = '${esc(opts.domain)}'`);
        }
        if (opts?.topic) {
            conditions.push(`topic = '${esc(opts.topic)}'`);
        }
        if (opts?.tag) {
            // Tags are stored as a JSON array string like ["a","b","c"]. Match the
            // wrapped form so "cortex:action" doesn't also hit "cortex:action_item".
            // SECURITY: use escLike to escape LIKE pattern wildcards (% and _) so
            // a tag of "%" doesn't widen the match to every row. ESCAPE '\' tells
            // DataFusion to treat backslash as the escape char.
            conditions.push(`tags LIKE '%"${escLike(opts.tag)}"%' ESCAPE '\\'`);
        }
        if (conditions.length > 0) {
            q = q.where(conditions.join(' AND '));
        }
        const rows = await q.toArray();
        return rows.map(rowToChunk);
    }
    async updateChunk(id, updates) {
        const values = {};
        if (updates.tier !== undefined)
            values.tier = updates.tier;
        if (updates.content !== undefined)
            values.content = updates.content;
        if (updates.importance !== undefined)
            values.importance = updates.importance;
        if (updates.recallCount !== undefined)
            values.recall_count = updates.recallCount;
        if (updates.lastRecalledAt !== undefined)
            values.last_recalled_at = updates.lastRecalledAt ?? '';
        if (updates.relatedMemories !== undefined)
            values.related_memories = JSON.stringify(updates.relatedMemories);
        if (updates.recallOutcomes !== undefined)
            values.recall_outcomes = JSON.stringify(updates.recallOutcomes);
        if (updates.embedding !== undefined)
            values.embedding = updates.embedding ?? new Array(384).fill(0);
        if (updates.domain !== undefined)
            values.domain = updates.domain;
        if (updates.topic !== undefined)
            values.topic = updates.topic;
        if (updates.tags !== undefined)
            values.tags = JSON.stringify(updates.tags);
        if (updates.source !== undefined)
            values.source = updates.source;
        if (updates.type !== undefined)
            values.type = updates.type;
        if (updates.sentiment !== undefined)
            values.sentiment = updates.sentiment;
        if (updates.cognitiveLayer !== undefined)
            values.cognitive_layer = updates.cognitiveLayer;
        if (updates.stability !== undefined)
            values.stability = updates.stability;
        if (updates.difficulty !== undefined)
            values.difficulty = updates.difficulty;
        if (updates.temporalAnchor !== undefined)
            values.temporal_anchor = updates.temporalAnchor;
        if (updates.consolidationLevel !== undefined)
            values.consolidation_level = updates.consolidationLevel;
        if (updates.sourceChunkIds !== undefined)
            values.source_chunk_ids = JSON.stringify(updates.sourceChunkIds);
        if (updates.embeddingVersion !== undefined)
            values.embedding_version = updates.embeddingVersion;
        if (updates.parentChunkId !== undefined)
            values.parent_chunk_id = updates.parentChunkId;
        if (updates.origin !== undefined)
            values.origin = updates.origin;
        if (Object.keys(values).length === 0)
            return;
        await this.chunks.update({ where: `id = '${esc(id)}'`, values });
    }
    /**
     * Batched upsert. mergeInsert on `id` applies every row change in a
     * single operation instead of one scan-and-rewrite per row. Rows are
     * serialized through the same chunkToRow path as saveChunks, so this
     * carries no serialization risk the insert path doesn't already carry.
     */
    async updateChunks(chunks) {
        if (chunks.length === 0)
            return;
        await this.chunks
            .mergeInsert('id')
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(chunks.map(chunkToRow));
    }
    /** Batched delete. One predicate per 500 ids so the IN list stays sane. */
    async deleteChunks(ids) {
        if (ids.length === 0)
            return;
        const BATCH = 500;
        for (let i = 0; i < ids.length; i += BATCH) {
            const inList = ids.slice(i, i + BATCH).map(id => `'${esc(id)}'`).join(', ');
            await this.chunks.delete(`id IN (${inList})`);
        }
    }
    /**
     * Compact + prune. Without args, a safe compaction that keeps 7 days of
     * versions. With olderThanMs, also prunes versions older than that many
     * ms (0 = keep only the current version). deleteUnverified lets it remove
     * files younger than 7 days — only pass true when no other process is
     * writing the store (CLI reembed/compact), never from the running server
     * with an aggressive window.
     */
    async optimizeChunks(olderThanMs, deleteUnverified) {
        try {
            if (olderThanMs === undefined) {
                await this.chunks.optimize();
            }
            else {
                await this.chunks.optimize({
                    cleanupOlderThan: new Date(Date.now() - olderThanMs),
                    deleteUnverified: deleteUnverified ?? false,
                });
            }
        }
        catch (err) {
            console.error('przm-memory: chunk table optimize failed (non-fatal):', err);
        }
    }
    async chunkCount() {
        return await this.chunks.countRows();
    }
    async vectorSearch(queryEmbedding, limit, filter) {
        let q = this.chunks
            .vectorSearch(queryEmbedding)
            .distanceType('cosine')
            .limit(limit);
        if (filter) {
            q = q.where(filter);
        }
        const rows = await q.toArray();
        return rows.map(row => ({
            chunk: rowToChunk(row),
            distance: row._distance ?? 1,
        }));
    }
    // ── Taxonomy ──────────────────────────────────────────────────────
    async getTaxonomy() {
        const chunks = await this.listChunks({ excludeTiers: ['archive'] });
        const tree = {};
        for (const c of chunks) {
            const d = c.domain || '(uncategorized)';
            const t = c.topic || '(general)';
            if (!tree[d])
                tree[d] = {};
            tree[d][t] = (tree[d][t] ?? 0) + 1;
        }
        return tree;
    }
    // ── Daily Logs ────────────────────────────────────────────────────
    async appendDailyEntry(date, entry) {
        await this.dailyLogs.add([{
                row_id: `${date}-${Date.now()}`,
                date,
                timestamp: entry.timestamp,
                conversation_id: entry.conversationId,
                summary: entry.summary,
                extracted_facts: JSON.stringify(entry.extractedFacts),
            }]);
    }
    async getDailyLogs(daysBack) {
        const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().split('T')[0];
        const rows = await this.dailyLogs.query()
            .where(`date >= '${esc(cutoff)}'`)
            .toArray();
        const grouped = new Map();
        for (const row of rows) {
            const entries = grouped.get(row.date) ?? [];
            entries.push({
                timestamp: row.timestamp,
                conversationId: row.conversation_id,
                summary: row.summary,
                extractedFacts: JSON.parse(row.extracted_facts),
            });
            grouped.set(row.date, entries);
        }
        return Array.from(grouped.entries()).map(([date, entries]) => ({ date, entries }));
    }
    // ── Procedural Rules ──────────────────────────────────────────────
    async saveRule(rule) {
        try {
            await this.rules.delete(`id = '${esc(rule.id)}'`);
        }
        catch { /* noop */ }
        await this.rules.add([{
                id: rule.id,
                rule: rule.rule,
                domain: rule.domain,
                confidence: rule.confidence,
                reinforcements: rule.reinforcements,
                contradictions: rule.contradictions,
                evidence: JSON.stringify(rule.evidence),
                created_at: rule.createdAt,
                updated_at: rule.updatedAt,
            }]);
    }
    async getRules() {
        const rows = await this.rules.query().toArray();
        return rows
            .map((r) => ({
            id: r.id,
            rule: r.rule,
            domain: r.domain,
            confidence: r.confidence,
            reinforcements: r.reinforcements,
            contradictions: r.contradictions,
            evidence: JSON.parse(r.evidence),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }))
            .sort((a, b) => b.confidence - a.confidence);
    }
    async deleteRule(id) {
        await this.rules.delete(`id = '${esc(id)}'`);
    }
    // ── Knowledge Triples ────────────────────────────────────────────
    async saveTriple(triple) {
        try {
            await this.triples.delete(`id = '${esc(triple.id)}'`);
        }
        catch { /* noop */ }
        await this.triples.add([{
                id: triple.id,
                subject: triple.subject,
                predicate: triple.predicate,
                object: triple.object,
                source: triple.source,
                confidence: triple.confidence,
                valid_from: triple.validFrom,
                valid_to: triple.validTo ?? '',
                created_at: triple.createdAt,
            }]);
    }
    async queryTriples(opts) {
        let q = this.triples.query();
        const conditions = [];
        if (opts?.subject)
            conditions.push(`subject = '${esc(opts.subject)}'`);
        if (opts?.predicate)
            conditions.push(`predicate = '${esc(opts.predicate)}'`);
        if (opts?.object)
            conditions.push(`object = '${esc(opts.object)}'`);
        if (opts?.activeOnly)
            conditions.push(`valid_to = ''`);
        if (conditions.length > 0) {
            q = q.where(conditions.join(' AND '));
        }
        const rows = await q.toArray();
        return rows.map(rowToTriple);
    }
    async invalidateTriple(id) {
        await this.triples.update({
            where: `id = '${esc(id)}'`,
            values: { valid_to: new Date().toISOString() },
        });
    }
    async getTripleTimeline(entity) {
        const asSubject = await this.triples.query()
            .where(`subject = '${esc(entity)}'`)
            .toArray();
        const asObject = await this.triples.query()
            .where(`object = '${esc(entity)}'`)
            .toArray();
        return [...asSubject, ...asObject]
            .map(rowToTriple)
            .sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime());
    }
    async getTripleStats() {
        const all = await this.triples.query().toArray();
        const triples = all.map(rowToTriple);
        const active = triples.filter(t => !t.validTo);
        const subjects = new Set(triples.map(t => t.subject));
        const predicates = new Set(triples.map(t => t.predicate));
        return {
            total: triples.length,
            active: active.length,
            invalidated: triples.length - active.length,
            subjects: subjects.size,
            predicates: predicates.size,
        };
    }
    // ── Diary (delegates to the filesystem helpers) ───────────────────
    async writeDiaryEntry(content, agent) {
        return fsWriteDiaryEntry(this.dataDir, content, agent);
    }
    async readDiary(opts) {
        return fsReadDiary(this.dataDir, opts);
    }
    async listDiaryDates() {
        return fsListDiaryDates(this.dataDir);
    }
    // ── Handoffs (delegates to the filesystem helpers) ────────────────
    async writeHandoff(note) {
        return fsWriteHandoff(this.dataDir, note);
    }
    async readHandoff(stamp) {
        return fsReadHandoff(this.dataDir, stamp);
    }
    async listHandoffs(limit) {
        return fsListHandoffs(this.dataDir, limit);
    }
}
// ── Helpers ──────────────────────────────────────────────────────────
/**
 * Escape a string value for inclusion in a single-quoted SQL string
 * literal. The caller MUST wrap the result in single quotes:
 *   `tier = '${esc(value)}'`
 *
 * Doubles single quotes (SQL standard) and rejects values containing
 * NULL bytes (which would terminate the string in some drivers and
 * could be used to truncate/inject filter clauses).
 *
 * For LIKE patterns where the value should match literally, use
 * escLike() instead — it additionally escapes %, _, and \ which are
 * pattern wildcards in DataFusion / SQL LIKE.
 */
function esc(val) {
    if (val == null)
        return '';
    if (typeof val !== 'string') {
        throw new TypeError(`esc() expected string, got ${typeof val}`);
    }
    if (val.indexOf('\0') !== -1) {
        throw new Error('null byte not allowed in filter value');
    }
    return val.replace(/'/g, "''");
}
/**
 * Escape a string for safe interpolation into the LITERAL portion of a
 * SQL LIKE pattern. Wildcards (%, _) and the escape char itself (\) are
 * backslash-escaped so they match as plain text. Caller must add the
 * surrounding pattern wildcards AND an ESCAPE '\' clause:
 *
 *   `name LIKE '%${escLike(value)}%' ESCAPE '\\'`
 */
function escLike(val) {
    if (val == null)
        return '';
    if (typeof val !== 'string') {
        throw new TypeError(`escLike() expected string, got ${typeof val}`);
    }
    if (val.indexOf('\0') !== -1) {
        throw new Error('null byte not allowed in filter value');
    }
    return val
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .replace(/'/g, "''");
}
function chunkToRow(chunk) {
    return {
        id: chunk.id,
        tier: chunk.tier,
        content: chunk.content,
        type: chunk.type,
        cognitive_layer: chunk.cognitiveLayer,
        tags: JSON.stringify(chunk.tags),
        domain: chunk.domain ?? '',
        topic: chunk.topic ?? '',
        source: chunk.source,
        importance: chunk.importance,
        sentiment: chunk.sentiment,
        created_at: chunk.createdAt,
        last_recalled_at: chunk.lastRecalledAt ?? '',
        recall_count: chunk.recallCount,
        embedding: chunk.embedding ?? new Array(384).fill(0),
        related_memories: JSON.stringify(chunk.relatedMemories),
        recall_outcomes: JSON.stringify(chunk.recallOutcomes),
        stability: chunk.stability ?? 1.0,
        difficulty: chunk.difficulty ?? 0.3,
        temporal_anchor: chunk.temporalAnchor ?? 0,
        consolidation_level: chunk.consolidationLevel ?? 0,
        source_chunk_ids: JSON.stringify(chunk.sourceChunkIds ?? []),
        embedding_version: chunk.embeddingVersion ?? 1,
        parent_chunk_id: chunk.parentChunkId ?? '',
        origin: chunk.origin ?? 'derived',
    };
}
function rowToChunk(row) {
    let embedding;
    if (row.embedding) {
        embedding = Array.isArray(row.embedding) ? row.embedding : Array.from(row.embedding);
        if (embedding && embedding.every(v => v === 0))
            embedding = undefined;
    }
    return {
        id: row.id,
        tier: row.tier,
        content: row.content,
        type: row.type,
        cognitiveLayer: row.cognitive_layer,
        tags: JSON.parse(row.tags ?? '[]'),
        domain: row.domain ?? '',
        topic: row.topic ?? '',
        source: row.source ?? '',
        importance: row.importance ?? 0.5,
        sentiment: row.sentiment ?? 'neutral',
        createdAt: row.created_at,
        lastRecalledAt: row.last_recalled_at || null,
        recallCount: row.recall_count ?? 0,
        embedding,
        relatedMemories: JSON.parse(row.related_memories ?? '[]'),
        recallOutcomes: JSON.parse(row.recall_outcomes ?? '[]'),
        stability: row.stability ?? 1.0,
        difficulty: row.difficulty ?? 0.3,
        temporalAnchor: row.temporal_anchor ?? undefined,
        consolidationLevel: row.consolidation_level ?? 0,
        sourceChunkIds: row.source_chunk_ids ? JSON.parse(row.source_chunk_ids) : undefined,
        embeddingVersion: row.embedding_version ?? 1,
        parentChunkId: row.parent_chunk_id || undefined,
        origin: row.origin || 'derived',
    };
}
function rowToTriple(row) {
    return {
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        source: row.source ?? '',
        confidence: row.confidence ?? 0.5,
        validFrom: row.valid_from,
        validTo: row.valid_to || null,
        createdAt: row.created_at,
    };
}
//# sourceMappingURL=storage-file.js.map