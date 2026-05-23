#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Storage } from './storage.js';
import { buildUpdateMetadataPatch, } from './update-metadata.js';
import { loadConfig } from './config.js';
import { isLlmAvailable, warmEmbeddings } from './llm.js';
import { getVersion } from './version.js';
import { search, selectRelevant, formatRecalledMemories } from './search.js';
import { graphAwareRerank, graphAwareRerankPPR } from './graph-rerank.js';
import { extractFromConversation } from './extractor.js';
import { consolidate } from './consolidator.js';
import { extractRules, formatRulesForPrompt } from './procedural.js';
import { recordRecallOutcome } from './outcome.js';
import { mem0Extract } from './mem0.js';
import { ingest } from './wal.js';
import { readSessionState, updateSessionState, appendToSessionState, clearSessionState, } from './session-state.js';
import { addTriple, replaceTriple, queryGraph, getTimeline, invalidateTriple, getGraphStats, } from './knowledge-graph.js';
import { writeDiaryEntry, readDiary, listDiaryDates } from './diary.js';
import { importConversation } from './importer.js';
import { runGovernanceCheck, detectContradictions } from './governance.js';
import { syncBridge, loadBridgeFile } from './procedural-bridge.js';
import { writeHandoff, readHandoff, listHandoffs } from './handoff.js';
import { assessPressure } from './context-pressure.js';
import { listRecentTraces, gcOldTraces } from './retrieval-trace.js';
import { hostname } from 'node:os';
import { startDeviceCode, pollDeviceCode, credentialsFromApproval, } from './auth/login.js';
import { readCredentials, writeCredentials, deleteCredentials, credentialsPath, credentialsStat, } from './auth/credentials.js';
// ── Config & Storage ────────────────────────────────────────────────
const config = loadConfig();
let _storage = null;
let _storageReady = null;
async function ensureStorage() {
    if (!_storage) {
        _storage = new Storage(config.dataDir);
        _storageReady = _storage.ensureReady();
    }
    await _storageReady;
    return _storage;
}
function text(t) { return { content: [{ type: 'text', text: t }] }; }
// Use `unknown` not `any` — every call site already narrows what it
// passes; `any` here would silently accept (and serialize) anything,
// including secrets that shouldn't be in tool responses.
function json(data) { return text(JSON.stringify(data, null, 2)); }
// ── MCP Server ──────────────────────────────────────────────────────
const server = new McpServer({ name: 'przm-memory', version: getVersion() }, {
    instructions: [
        'przm Memory is your long-term memory.',
        '',
        'Save what matters: memory-ingest for facts/preferences/decisions, memory-kg-add for relationships, memory-diary-write at session end.',
        'Before answering about prior conversations: memory-search first.',
        '',
        '## Handoff protocol (MANDATORY)',
        'Context compaction can fail if the window fills completely. When that happens, the user has to abandon the chat. Never let this happen.',
        '',
        '1. Save memories continuously with memory-ingest — never batch.',
        '2. At session start, call memory-handoff-read to resume where the prior session left off. If the user references a specific past session (by name or topic), call memory-handoff-list first and load the matching named checkpoint with memory-handoff-read({ name }).',
        '3. When context feels heavy (long tool outputs, many file reads, extended work) call memory-context-pressure with your honest level assessment. Follow the returned actionPlan.',
        '4. At NATURAL PHASE BOUNDARIES (task done, pivoting focus, finishing a subsystem, user says "ok next let\'s…") call memory-context-pressure with phaseBoundary=true and compact. Pivots thrash the cache anyway — compacting at the boundary is a free lunch, carrying verbose tool output from the old phase into the new one is not.',
        '5. BEFORE invoking /compact — or before session end, or when the user asks to "save this session" / "checkpoint this" — call memory-handoff-write with a full "where we left off" snapshot: currentTask, completed, nextSteps, openQuestions, fileRefs (path:line), decisions, notes. Pass `name` for a user-friendly checkpoint label so the user can resume it explicitly later.',
        '6. Do not wait for the system to auto-compact. Compact early, while there is still headroom for the handoff.',
        '',
        'If persona MCP available: call persona_signal on user reactions (correction, approval, frustration, praise, etc).',
    ].join('\n'),
});
// ─────────────────────────────────────────────────────────────────────
// CORE MEMORY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-search', {
    title: 'Search Memories',
    description: 'Search long-term memories. Returns relevant facts, preferences, decisions, and rules. Set format=true to get pre-formatted output for prompt injection.',
    inputSchema: z.object({
        query: z.string().describe('Natural language search query.'),
        maxResults: z.number().min(1).max(500).optional().describe('Max results (default: 10, max: 500).'),
        domain: z.string().optional().describe('Filter by domain/project.'),
        topic: z.string().optional().describe('Filter by topic.'),
        tag: z.string().optional().describe('Filter by exact tag match. Consumer-defined (e.g. "cortex_type:action_item").'),
        cognitiveLoad: z.enum(['low', 'normal', 'high']).optional().describe('From Persona. "high" returns top 3 only.'),
        format: z.boolean().optional().describe('If true, returns formatted text grouped by cognitive layer instead of JSON.'),
        graphRerank: z.union([z.boolean(), z.enum(['lite', 'ppr'])]).optional().describe('Graph-aware rerank mode. `false` or omitted = pure similarity ranking. `true` or `"lite"` = 1-hop expansion + score boost (HippoRAG-lite, fast, no convergence). `"ppr"` = full Personalized PageRank walk from query-seed entities (Gutiérrez et al, NeurIPS 2024 — more accurate on multi-hop QA at modest extra cost). PPR falls back to lite when the graph has < 4 entities or > 500 nodes.'),
    }),
}, async ({ query, maxResults, domain, topic, tag, cognitiveLoad, format: formatOutput, graphRerank }) => {
    let effectiveMaxResults = maxResults;
    if (cognitiveLoad === 'high') {
        effectiveMaxResults = Math.min(effectiveMaxResults ?? 10, 3);
    }
    const storage = await ensureStorage();
    const results = await search(config, storage, query, effectiveMaxResults, { domain, topic, tag });
    let selected;
    try {
        selected = await selectRelevant(config, query, results);
    }
    catch {
        selected = results.slice(0, cognitiveLoad === 'high' ? 3 : 5);
    }
    // Optional graph-aware rerank.
    //   - lite (or `true`): 1-hop expansion + boost. Fast.
    //   - ppr: full Personalized PageRank walk from seed entities.
    //     Better on multi-hop QA but pays the iteration cost.
    // Both no-op on memory stores without graph data.
    if (graphRerank) {
        const mode = graphRerank === 'ppr' ? 'ppr' : 'lite';
        try {
            selected = mode === 'ppr'
                ? await graphAwareRerankPPR(storage, selected)
                : await graphAwareRerank(storage, selected);
        }
        catch {
            // graph rerank is opportunistic — fall through to similarity-
            // only results on any error.
        }
    }
    if (cognitiveLoad === 'high' && selected.length > 3) {
        selected = selected
            .sort((a, b) => b.chunk.importance - a.chunk.importance)
            .slice(0, 3);
    }
    // Formatted output mode (replaces old engram-format tool)
    if (formatOutput) {
        const memText = formatRecalledMemories(selected);
        const rules = await formatRulesForPrompt(storage);
        return text(memText + rules || 'No relevant memories found.');
    }
    return json({
        total: results.length,
        selected: selected.length,
        results: selected.map(r => ({
            id: r.chunk.id,
            content: r.chunk.content,
            type: r.chunk.type,
            layer: r.chunk.cognitiveLayer,
            tier: r.chunk.tier,
            domain: r.chunk.domain || undefined,
            topic: r.chunk.topic || undefined,
            tags: r.chunk.tags.length > 0 ? r.chunk.tags : undefined,
            source: r.chunk.source || undefined,
            createdAt: r.chunk.createdAt || undefined,
            importance: r.chunk.importance,
            score: Math.round(r.score * 1000) / 1000,
        })),
    });
});
server.registerTool('memory-budget', {
    title: 'Search Memories Within a Token Budget',
    description: [
        'Like memory-search, but returns memories that fit within a TOKEN BUDGET instead of a count limit.',
        'Greedy fill from highest-relevance memories: candidates ranked by score × importance, included until the next entry would exceed the budget.',
        'Used by przm\'s Context Budget Engine: the persona/memories slot allocates N tokens, and przm Memory returns "the most useful subset that fits."',
        'Returns the same memory shape as memory-search plus { budgetTokens, usedTokens, includedCount, candidateCount } so callers can see how the budget got spent.',
    ].join(' '),
    inputSchema: z.object({
        query: z.string().describe('Natural language search query.'),
        budgetTokens: z.number().min(50).max(50000).describe('Token budget for the returned set. Greedy fill stops before exceeding this. Recommended range: 200 (tight slot) to 5000 (generous).'),
        candidateLimit: z.number().min(1).max(500).optional().describe('Max candidates to consider before budget filtering (default: 50). Larger candidate pool = better quality picks but slower search.'),
        domain: z.string().optional().describe('Filter by domain/project.'),
        topic: z.string().optional().describe('Filter by topic.'),
        tag: z.string().optional().describe('Filter by exact tag match.'),
        format: z.boolean().optional().describe('If true, returns formatted text grouped by cognitive layer instead of JSON.'),
    }),
}, async ({ query, budgetTokens, candidateLimit, domain, topic, tag, format: formatOutput }) => {
    const storage = await ensureStorage();
    const candidates = await search(config, storage, query, candidateLimit ?? 50, { domain, topic, tag });
    // Greedy budget fill. Sort by relevance score × importance (the
    // composite "useful here AND useful in general" signal). Token
    // estimate is conservative: 4 chars/token for English-prose
    // memory content + a 30-token wrapper overhead per entry for
    // type/source/tags rendering. Slightly over-estimating beats
    // under-estimating; the budget caller (przm's CBE) prefers a
    // small remainder over a hard overflow.
    const ranked = candidates
        .map((r) => ({ r, weight: r.score * (r.chunk.importance + 0.1) }))
        .sort((a, b) => b.weight - a.weight);
    const selected = [];
    let usedTokens = 0;
    const WRAPPER_OVERHEAD = 30;
    const CHARS_PER_TOKEN = 4;
    for (const { r } of ranked) {
        const contentTokens = Math.ceil(r.chunk.content.length / CHARS_PER_TOKEN);
        const entryTokens = contentTokens + WRAPPER_OVERHEAD;
        if (usedTokens + entryTokens > budgetTokens) {
            // Hit the budget. The remaining candidates would push us over;
            // greedy stop here. Could continue scanning for a smaller
            // entry that still fits, but the marginal token win usually
            // isn't worth losing the strict importance ordering.
            continue;
        }
        selected.push(r);
        usedTokens += entryTokens;
    }
    if (formatOutput) {
        const memText = formatRecalledMemories(selected);
        return text(memText || 'No relevant memories found within budget.');
    }
    return json({
        budgetTokens,
        usedTokens,
        includedCount: selected.length,
        candidateCount: candidates.length,
        results: selected.map((r) => ({
            id: r.chunk.id,
            content: r.chunk.content,
            type: r.chunk.type,
            layer: r.chunk.cognitiveLayer,
            tier: r.chunk.tier,
            domain: r.chunk.domain || undefined,
            topic: r.chunk.topic || undefined,
            tags: r.chunk.tags.length > 0 ? r.chunk.tags : undefined,
            source: r.chunk.source || undefined,
            createdAt: r.chunk.createdAt || undefined,
            importance: r.chunk.importance,
            score: Math.round(r.score * 1000) / 1000,
        })),
    });
});
server.registerTool('memory-ingest', {
    title: 'Save Memory',
    description: 'Save a fact, preference, decision, correction, or context to long-term memory. Auto-classifies type/tags if omitted. Auto-checks for duplicates before saving unless skipDedupe=true.',
    inputSchema: z.object({
        content: z.string().describe('The memory to store.'),
        type: z.enum(['fact', 'preference', 'decision', 'context', 'correction']).optional().describe('Memory type.'),
        importance: z.number().min(0).max(1).optional().describe('Importance 0.0-1.0 (default: 0.5).'),
        tags: z.array(z.string()).optional().describe('Tags.'),
        source: z.string().optional().describe('Source identifier (e.g. stable sourceId from an upstream system). Stored on the chunk and returned on search.'),
        domain: z.string().optional().describe('Domain/project namespace.'),
        topic: z.string().optional().describe('Topic within the domain.'),
        sentiment: z.enum(['frustrated', 'curious', 'satisfied', 'neutral', 'excited', 'confused']).optional().describe('Emotional sentiment from Persona.'),
        emotionalValence: z.number().min(-1).max(1).optional().describe('Emotional valence from Persona. Boosts importance for charged memories.'),
        emotionalArousal: z.number().min(0).max(1).optional().describe('Emotional arousal from Persona. High arousal = stronger encoding.'),
        skipDedupe: z.boolean().optional().describe('If true, bypass the 0.75-similarity duplicate check. Use when the caller is writing structured refinements of prior memories (e.g. action items derived from a meeting note) and dedupe would swallow the write.'),
        origin: z.enum(['user', 'derived', 'extracted', 'imported']).optional().describe('Provenance. Default "user" — explicit ingest is treated as user-asserted and protected from auto-merge / archive. Set "derived" when the caller is a downstream pipeline writing inferences.'),
        tier: z.enum(['scratch', 'short-term']).optional().describe('Memory tier. "scratch" = session-only, never promoted by consolidation, auto-purged after 24h. Use for exploratory notes you may want to discard. Default short-term.'),
        createdAt: z.string().optional().describe('ISO 8601 timestamp override. Default: ingest time (now). Use this when ingesting memories that ORIGINALLY happened at a different time — meeting notes from yesterday, chat history from last week, dated documents from years ago. The timestamp flows into the contextual prefix embedded with the content, giving the retrieval pipeline a temporal signal it would otherwise lose. Critical for benchmarks (LoCoMo) and real workloads that backfill historical context (Cortex ingest of dated docs, importing chat history from Slack/Discord).'),
    }),
}, async ({ content, type, importance, tags, source, domain, topic, sentiment, emotionalValence, emotionalArousal, skipDedupe, origin, tier, createdAt }) => {
    // R-009: benchmark-only knobs (skipKgExtraction, skipDailyEntry,
    // awaitSideEffects) removed from the public MCP schema. The library
    // entry point in src/index.ts still accepts them for the benchmark
    // harness; production defaults apply here.
    const storage = await ensureStorage();
    // Auto duplicate check (replaces old engram-check-duplicate tool). Callers
    // writing intentional refinements can bypass via skipDedupe=true.
    if (!skipDedupe) {
        const dupeResults = await search(config, storage, content, 5);
        const similar = dupeResults.filter(r => r.score >= 0.75);
        if (similar.length > 0) {
            const top = similar[0];
            // Backlog (memory-ingest dup actionable response): give the caller
            // a clear forward path so they don't have to guess between
            // accept-existing / retry-skipDedupe / give-up.
            const recommendation = top.score >= 0.9
                ? 'accept_existing'
                : top.score >= 0.8
                    ? 'reinforce_existing'
                    : 'force_write_if_intentional_refinement';
            const nextAction = recommendation === 'accept_existing'
                ? `Treat as recorded — the existing memory (id=${top.chunk.id}) is essentially the same content.`
                : recommendation === 'reinforce_existing'
                    ? `Call memory-outcome with outcome="helpful" on chunkIds=[${top.chunk.id}] to boost its importance instead of writing a duplicate.`
                    : `Retry with skipDedupe=true if this content is an intentional refinement of the existing memory.`;
            return json({
                ingested: 0,
                duplicate: true,
                recommendation,
                nextAction,
                similar: similar.map(r => ({
                    id: r.chunk.id,
                    content: r.chunk.content,
                    score: Math.round(r.score * 1000) / 1000,
                })),
            });
        }
    }
    const chunks = await ingest(config, storage, [{
            content,
            type: type,
            importance,
            tags,
            ...(source ? { source } : {}),
            domain,
            topic,
            sentiment: sentiment,
            emotionalValence,
            emotionalArousal,
            origin: origin ?? 'user',
            ...(createdAt ? { createdAt } : {}),
            tier,
        }]);
    return json({
        ingested: chunks.length,
        memory: chunks[0] ? {
            id: chunks[0].id,
            content: chunks[0].content,
            type: chunks[0].type,
            layer: chunks[0].cognitiveLayer,
            domain: chunks[0].domain || undefined,
            topic: chunks[0].topic || undefined,
        } : null,
    });
});
// memory-update-metadata — patch metadata-shape fields on an existing
// memory by id. Closes a gap that callers (e.g. cortex's workspace
// backfill) hit when they need to correct stamps without re-ingesting
// (which either dupes or relies on similarity dedupe to overwrite —
// neither is correct semantics).
//
// The "metadata" surface here is engram-native: top-level
// MemoryChunk fields (tags, source, domain, topic, type, sentiment,
// importance, cognitiveLayer). Cortex translates its richer
// metadata.X shape into this surface client-side. Per the north-
// star: engram changes are generic non-breaking additives, not
// caller-specific hooks.
//
// Mutations of `id`, `createdAt`, and the embedding-related fields
// (`embedding`, `embeddingVersion`) are rejected — those are either
// immutable identity or computed from content. Callers wanting to
// re-embed should re-ingest with skipDedupe.
server.registerTool('memory-update-metadata', {
    title: 'Update Memory Metadata',
    description: 'Patch metadata-shape fields on an existing memory by id. Use to correct mis-stamped tags/source/domain/topic without re-ingesting (which would either duplicate or rely on similarity dedupe to overwrite). Mode "merge" (default) only updates specified fields; "replace" wipes unset fields to defaults — footgun-y, used sparingly. Rejects mutations of id, createdAt, embedding (re-embedding requires re-ingest with skipDedupe).',
    inputSchema: z.object({
        id: z.string().describe('Memory id to patch.'),
        metadata: z.object({
            tags: z.array(z.string()).optional().describe('Replacement tags array. To add/remove individual tags, callers fetch first, modify, write back.'),
            source: z.string().optional(),
            domain: z.string().optional(),
            topic: z.string().optional(),
            type: z.enum(['fact', 'preference', 'decision', 'context', 'correction']).optional(),
            sentiment: z.enum(['frustrated', 'curious', 'satisfied', 'neutral', 'excited', 'confused']).optional(),
            importance: z.number().min(0).max(1).optional(),
            cognitiveLayer: z.string().optional(),
        }).describe('Partial metadata to apply.'),
        mode: z.enum(['merge', 'replace']).optional().describe('Default merge — patch only specified keys. Replace — clear unspecified metadata fields to defaults.'),
    }),
}, async ({ id, metadata, mode }) => {
    const storage = await ensureStorage();
    const existing = await storage.getChunk(id);
    if (!existing) {
        return json({ error: 'not_found', id });
    }
    const effectiveMode = mode ?? 'merge';
    // Build the patch. In merge mode, only carry fields the caller set.
    // In replace mode, fields the caller didn't set get reset to engram
    // defaults (matches what fresh ingest would produce). Either way,
    // immutable fields (id, createdAt, embedding) stay locked.
    const patch = buildUpdateMetadataPatch(metadata, effectiveMode);
    if (effectiveMode === 'replace') {
        process.stderr.write(`[engram] memory-update-metadata mode=replace id=${id} — caller wiped unset metadata fields to defaults\n`);
    }
    // Compute a lightweight diff for the audit line (existing vs patch),
    // limited to the keys the patch actually touches so we don't log the
    // whole memory blob.
    const diff = {};
    for (const [key, value] of Object.entries(patch)) {
        const before = existing[key];
        diff[key] = { from: before, to: value };
    }
    process.stderr.write(`[engram] memory-update-metadata id=${id} mode=${effectiveMode} diff=${JSON.stringify(diff)}\n`);
    await storage.updateChunk(id, patch);
    const updated = await storage.getChunk(id);
    if (!updated) {
        // Shouldn't happen — getChunk just returned for the same id.
        return json({ error: 'updated_not_found', id });
    }
    return json({
        updated: {
            id: updated.id,
            content: updated.content,
            type: updated.type,
            tags: updated.tags,
            source: updated.source,
            domain: updated.domain,
            topic: updated.topic,
            sentiment: updated.sentiment,
            importance: updated.importance,
        },
    });
});
server.registerTool('memory-scratch-promote', {
    title: 'Promote Scratch Memory',
    description: 'Graduate a scratch-tier memory to short-term so it survives the 24h auto-purge and enters the normal consolidation lifecycle. Use after deciding an exploratory note is worth keeping.',
    inputSchema: z.object({
        id: z.string().describe('Scratch chunk id to promote.'),
    }),
}, async ({ id }) => {
    const storage = await ensureStorage();
    const existing = await storage.getChunk(id);
    if (!existing)
        return json({ error: 'not_found', id });
    if (existing.tier !== 'scratch') {
        return json({ error: 'not_scratch', id, currentTier: existing.tier });
    }
    await storage.updateChunk(id, { tier: 'short-term' });
    return json({ promoted: true, id, from: 'scratch', to: 'short-term' });
});
server.registerTool('memory-extract', {
    title: 'Extract Memories',
    description: 'Extract memories from a conversation. Uses LLM or heuristic fallback. Set rulesOnly=true to extract procedural rules only.',
    inputSchema: z.object({
        messages: z.array(z.object({
            role: z.string().describe('"user" or "assistant".'),
            content: z.string().describe('Message text.'),
        })).min(1).describe('Conversation messages, oldest → newest.'),
        conversationId: z.string().optional().describe('Session/conversation identifier.'),
        rulesOnly: z.boolean().optional().describe('If true, only extract procedural rules.'),
    }),
}, async ({ messages, conversationId, rulesOnly }) => {
    const storage = await ensureStorage();
    // Bound message count to prevent pathological-input DoS. ~10k
    // turns is far above any sane MCP message-array payload.
    if (messages.length > 10_000) {
        return json({
            error: 'messages_too_large',
            detail: `messages must contain < 10k turns (got ${messages.length})`,
        });
    }
    const parsed = messages;
    const convId = conversationId ?? `mcp-${Date.now()}`;
    // Rules-only mode (replaces old memory-extract-rules tool)
    if (rulesOnly) {
        await extractRules(config, storage, parsed);
        const rules = await formatRulesForPrompt(storage);
        return text(rules || 'No procedural rules extracted.');
    }
    const allChunks = [];
    if (config.extractionProvider === 'local' || config.extractionProvider === 'both') {
        const chunks = await extractFromConversation(config, storage, parsed, convId);
        allChunks.push(...chunks.map(c => ({
            id: c.id, content: c.content, type: c.type,
            layer: c.cognitiveLayer, importance: c.importance,
            source: isLlmAvailable() ? 'llm' : 'heuristic',
        })));
    }
    if (config.extractionProvider === 'mem0' || config.extractionProvider === 'both') {
        const chunks = await mem0Extract(config, storage, parsed, convId);
        allChunks.push(...chunks.map(c => ({
            id: c.id, content: c.content, type: c.type,
            layer: c.cognitiveLayer, importance: c.importance, source: 'mem0',
        })));
    }
    return json({ extracted: allChunks.length, memories: allChunks });
});
server.registerTool('memory-maintain', {
    title: 'Consolidate',
    description: 'Run memory consolidation: decay, promote/demote tiers, link related, merge duplicates, self-organize, and sync Persona bridge.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const stats = await consolidate(storage, config);
    // Auto-sync procedural bridge during maintenance
    let bridgeSync = { exported: 0, imported: 0, reinforced: 0, conflicts: 0 };
    try {
        bridgeSync = await syncBridge(storage);
    }
    catch {
        // Bridge sync is best-effort
    }
    return json({ action: 'consolidation', ...stats, bridge: bridgeSync });
});
server.registerTool('memory-rules', {
    title: 'Procedural Rules',
    description: 'Show active procedural rules learned from corrections and preferences.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const t = await formatRulesForPrompt(storage);
    return text(t || 'No active procedural rules.');
});
server.registerTool('memory-outcome', {
    title: 'Recall Outcome',
    description: 'Record whether recalled memories were helpful, corrected, or irrelevant. Adjusts importance.',
    inputSchema: z.object({
        outcome: z.enum(['helpful', 'corrected', 'irrelevant']).describe('Outcome.'),
        chunkIds: z.array(z.string()).min(1).describe('Memory chunk IDs.'),
    }),
}, async ({ outcome, chunkIds }) => {
    const storage = await ensureStorage();
    await recordRecallOutcome(config, storage, chunkIds, outcome, `mcp-${Date.now()}`);
    return text(`Recorded ${outcome} outcome for ${chunkIds.length} chunk(s).`);
});
server.registerTool('memory-session', {
    title: 'Session State',
    description: 'Manage session state (hot RAM). Actions: show, task, context, decision, action, clear.',
    inputSchema: z.object({
        action: z.enum(['show', 'task', 'context', 'decision', 'action', 'clear']).describe('Action.'),
        value: z.string().optional().describe('Value (required for task/context/decision/action).'),
    }),
}, async ({ action, value }) => {
    switch (action) {
        case 'show':
            return json(readSessionState(config.dataDir));
        case 'task':
            updateSessionState(config.dataDir, { currentTask: value ?? '' });
            return text(`Task set: ${value}`);
        case 'context':
            appendToSessionState(config.dataDir, 'keyContext', value ?? '');
            return text(`Context added: ${value}`);
        case 'decision':
            appendToSessionState(config.dataDir, 'recentDecisions', value ?? '');
            return text(`Decision recorded: ${value}`);
        case 'action':
            appendToSessionState(config.dataDir, 'pendingActions', { text: value ?? '', done: false });
            return text(`Action added: ${value}`);
        case 'clear':
            clearSessionState(config.dataDir);
            return text('Session state cleared.');
        default:
            return text(`Unknown action: ${action}`);
    }
});
server.registerTool('memory-stats', {
    title: 'Stats',
    description: 'Memory system stats: chunks by tier/layer/type, rules, knowledge graph, bridge status, and taxonomy.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const all = await storage.listChunks();
    const tiers = {};
    const layers = {};
    const types = {};
    for (const c of all) {
        tiers[c.tier] = (tiers[c.tier] ?? 0) + 1;
        layers[c.cognitiveLayer] = (layers[c.cognitiveLayer] ?? 0) + 1;
        types[c.type] = (types[c.type] ?? 0) + 1;
    }
    const rules = await storage.getRules();
    const kgStats = await getGraphStats(storage);
    const state = readSessionState(config.dataDir);
    const diaryDates = listDiaryDates(config.dataDir);
    // Taxonomy (folded in from old engram-taxonomy tool)
    const tree = await storage.getTaxonomy();
    // Bridge status (new observability)
    let bridge = { status: 'no bridge file' };
    try {
        const bridgeFile = loadBridgeFile();
        bridge = {
            lastUpdated: bridgeFile.lastUpdated,
            totalRules: bridgeFile.rules.length,
            engramRules: bridgeFile.rules.filter(r => r.source === 'engram').length,
            personaRules: bridgeFile.rules.filter(r => r.source === 'persona').length,
        };
    }
    catch { /* no bridge file */ }
    return json({
        totalChunks: all.length,
        byTier: tiers,
        byLayer: layers,
        byType: types,
        proceduralRules: rules.length,
        activeRules: rules.filter(r => r.confidence > 0.3).length,
        knowledgeGraph: kgStats,
        taxonomy: tree,
        bridge,
        diaryEntries: diaryDates.length,
        llmAvailable: isLlmAvailable(),
        embeddingModel: process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
        sessionTask: state.currentTask || null,
    });
});
server.registerTool('memory-govern', {
    title: 'Governance Check',
    description: 'Advisory checks: "check" (contradictions), "drift" (semantic drift), "poison" (injection scan), "full" (all).',
    inputSchema: z.object({
        action: z.enum(['check', 'drift', 'poison', 'full']).describe('Governance action.'),
        content: z.string().optional().describe('Content to check (required for "check").'),
        domain: z.string().optional().describe('Filter by domain.'),
    }),
}, async ({ action, content, domain }) => {
    const storage = await ensureStorage();
    if (action === 'check') {
        if (!content)
            return json({ error: 'Content required for contradiction check.' });
        const result = await detectContradictions(config, storage, content, { domain });
        return json(result);
    }
    if (action === 'full') {
        const report = await runGovernanceCheck(config, storage, { content, domain });
        return json(report);
    }
    if (action === 'drift') {
        const { measureSemanticDrift } = await import('./governance.js');
        const drift = await measureSemanticDrift(config, storage, { domain });
        return json(drift);
    }
    if (action === 'poison') {
        const { checkMemoryPoisoning } = await import('./governance.js');
        const poison = await checkMemoryPoisoning(storage);
        return json(poison);
    }
    return json({ error: 'Unknown action.' });
});
// ─────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-kg-add', {
    title: 'KG Add',
    description: 'Add a subject-predicate-object triple. Use replace=true to auto-invalidate conflicting facts.',
    inputSchema: z.object({
        subject: z.string().describe('Entity (e.g. "Matt").'),
        predicate: z.string().describe('Relationship (e.g. "works-at").'),
        object: z.string().describe('Target (e.g. "Acme Corp").'),
        replace: z.boolean().optional().describe('Invalidate existing triples with same subject+predicate.'),
        confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default: 0.5).'),
    }),
}, async ({ subject, predicate, object, replace, confidence }) => {
    const storage = await ensureStorage();
    const fn = replace ? replaceTriple : addTriple;
    const triple = await fn(storage, subject, predicate, object, `mcp-${Date.now()}`, confidence);
    return json({ added: true, triple: { id: triple.id, subject: triple.subject, predicate: triple.predicate, object: triple.object } });
});
server.registerTool('memory-kg-query', {
    title: 'KG Query',
    description: 'Query knowledge graph triples. Filter by subject, predicate, and/or object.',
    inputSchema: z.object({
        subject: z.string().optional().describe('Filter by subject.'),
        predicate: z.string().optional().describe('Filter by relationship.'),
        object: z.string().optional().describe('Filter by target.'),
        activeOnly: z.boolean().optional().describe('Only valid facts (default: true).'),
    }),
}, async ({ subject, predicate, object, activeOnly }) => {
    const storage = await ensureStorage();
    const triples = await queryGraph(storage, {
        subject, predicate, object,
        activeOnly: activeOnly ?? true,
    });
    return json({
        count: triples.length,
        triples: triples.map(t => ({
            id: t.id, subject: t.subject, predicate: t.predicate, object: t.object,
            confidence: t.confidence, validFrom: t.validFrom, validTo: t.validTo,
        })),
    });
});
server.registerTool('memory-kg-invalidate', {
    title: 'KG Invalidate',
    description: 'Mark a fact as no longer valid. Stays in history.',
    inputSchema: z.object({
        tripleId: z.string().describe('Triple ID to invalidate.'),
    }),
}, async ({ tripleId }) => {
    const storage = await ensureStorage();
    await invalidateTriple(storage, tripleId);
    return text(`Triple ${tripleId} invalidated.`);
});
server.registerTool('memory-kg-timeline', {
    title: 'KG Timeline',
    description: 'Chronological history of all facts about an entity.',
    inputSchema: z.object({
        entity: z.string().describe('Entity name.'),
    }),
}, async ({ entity }) => {
    const storage = await ensureStorage();
    const timeline = await getTimeline(storage, entity);
    return json({
        entity,
        facts: timeline.map(t => ({
            subject: t.subject, predicate: t.predicate, object: t.object,
            validFrom: t.validFrom, validTo: t.validTo, active: !t.validTo,
        })),
    });
});
server.registerTool('memory-dossier', {
    title: 'Entity Dossier',
    description: [
        'Aggregate everything przm Memory knows about an entity (person, project, concept) into a structured snapshot.',
        'Pulls from FOUR sources: (1) KG triples where the entity is subject — definitive facts about the entity; (2) KG triples where the entity is object — facts where others reference the entity (e.g. "Alice reports-to Matt" appears in Matt\'s dossier as referencedBy); (3) memory chunks mentioning the entity in content/tags/topic — preferences, decisions, context; (4) recent activity ordered by createdAt — what came up lately.',
        'Output is grouped by category (facts, preferences, decisions, corrections, recent) so the consumer doesn\'t have to bucket the chunks themselves.',
        'Honors an optional budgetTokens cap; greedy fill within each category when set. Used by przm\'s Context Budget Engine to populate "what we know about <X>" slots without spending the entire memories budget on a search-by-relevance grab bag.',
    ].join(' '),
    inputSchema: z.object({
        entity: z.string().describe('Entity name. Matches against KG subject, chunk content (substring), tags (exact), and topic (exact). Case-insensitive.'),
        budgetTokens: z.number().min(100).max(50000).optional().describe('Optional token cap for the returned set. When set, each category fills greedy by importance until the per-category share is exhausted (~25% of budget per category). Without budget, returns up to maxPerCategory entries per category.'),
        maxPerCategory: z.number().min(1).max(50).optional().describe('Max entries per category when budgetTokens is omitted (default: 5).'),
        domain: z.string().optional().describe('Optional domain filter (limits dossier to a single project/scope).'),
    }),
}, async ({ entity, budgetTokens, maxPerCategory, domain }) => {
    const storage = await ensureStorage();
    const cap = maxPerCategory ?? 5;
    const entityLower = entity.toLowerCase();
    // 1a. KG triples where the entity is the subject (active facts).
    //     Filtered to active by default — invalidated triples shouldn't
    //     surface in a dossier.
    const triples = await queryGraph(storage, {
        subject: entity,
        activeOnly: true,
    });
    // 1b. KG triples where the entity is the OBJECT — facts about the
    //     entity asserted from someone else's perspective (e.g.
    //     "Alice reports-to Matt" should appear in Matt's dossier as
    //     a referencedBy edge). Without this, the dossier only shows
    //     outbound relationships and misses inbound ones.
    const referencedBy = await queryGraph(storage, {
        object: entity,
        activeOnly: true,
    });
    // 2. Memory chunks mentioning the entity. Use a generous candidate
    //    pool (entity-shaped queries are usually narrower than free-form
    //    search), then filter client-side for the substring/tag/topic
    //    match so we don't miss chunks the search ranker buried.
    const candidates = await search(config, storage, entity, 100, { domain });
    const matching = candidates.filter((r) => {
        const c = r.chunk;
        return c.content.toLowerCase().includes(entityLower)
            || c.tags.some((t) => t.toLowerCase() === entityLower)
            || c.topic.toLowerCase() === entityLower;
    });
    // Bucket by type. "context" maps into recent rather than its own
    // category since context is usually time-sensitive — last week's
    // context is less interesting than last week's preference.
    const buckets = {
        facts: [],
        preferences: [],
        decisions: [],
        corrections: [],
        recent: [],
    };
    for (const r of matching) {
        const t = r.chunk.type;
        if (t === 'fact')
            buckets.facts.push(r);
        else if (t === 'preference')
            buckets.preferences.push(r);
        else if (t === 'decision')
            buckets.decisions.push(r);
        else if (t === 'correction')
            buckets.corrections.push(r);
        // context is intentionally not its own bucket — falls into recent
    }
    // Recent = top-N most recently created chunks across ALL types,
    // independent of category. Catches active context + new
    // facts/preferences regardless of where they bucketed.
    buckets.recent = [...matching]
        .sort((a, b) => (b.chunk.createdAt ?? '').localeCompare(a.chunk.createdAt ?? ''))
        .slice(0, cap);
    // Per-category importance sort + cap.
    for (const k of Object.keys(buckets)) {
        if (k === 'recent')
            continue;
        buckets[k] = buckets[k]
            .sort((a, b) => b.chunk.importance - a.chunk.importance)
            .slice(0, cap);
    }
    // Optional token-budget enforcement. Splits budget evenly across
    // the 5 categories (facts / preferences / decisions / corrections
    // / recent) and greedy-fills each within its share. Same 4
    // chars/token + 30 wrapper estimate as memory-budget.
    let usedTokens = 0;
    if (typeof budgetTokens === 'number' && budgetTokens > 0) {
        const perCategoryBudget = Math.floor(budgetTokens / 5);
        const CHARS_PER_TOKEN = 4;
        const WRAPPER_OVERHEAD = 30;
        for (const k of Object.keys(buckets)) {
            let categoryUsed = 0;
            const filtered = [];
            for (const r of buckets[k]) {
                const t = Math.ceil(r.chunk.content.length / CHARS_PER_TOKEN) + WRAPPER_OVERHEAD;
                if (categoryUsed + t > perCategoryBudget)
                    continue;
                filtered.push(r);
                categoryUsed += t;
                usedTokens += t;
            }
            buckets[k] = filtered;
        }
    }
    const renderBucket = (entries) => entries.map((r) => ({
        id: r.chunk.id,
        content: r.chunk.content,
        type: r.chunk.type,
        importance: r.chunk.importance,
        createdAt: r.chunk.createdAt || undefined,
        domain: r.chunk.domain || undefined,
        topic: r.chunk.topic || undefined,
        tags: r.chunk.tags.length > 0 ? r.chunk.tags : undefined,
    }));
    return json({
        entity,
        budgetTokens: budgetTokens ?? null,
        usedTokens: budgetTokens ? usedTokens : undefined,
        kgFacts: triples.map((t) => ({
            id: t.id,
            predicate: t.predicate,
            object: t.object,
            confidence: t.confidence,
            validFrom: t.validFrom,
        })),
        referencedBy: referencedBy.map((t) => ({
            id: t.id,
            subject: t.subject,
            predicate: t.predicate,
            confidence: t.confidence,
            validFrom: t.validFrom,
        })),
        facts: renderBucket(buckets.facts),
        preferences: renderBucket(buckets.preferences),
        decisions: renderBucket(buckets.decisions),
        corrections: renderBucket(buckets.corrections),
        recent: renderBucket(buckets.recent),
        candidateCount: matching.length,
    });
});
// ─────────────────────────────────────────────────────────────────────
// DIARY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-diary-write', {
    title: 'Write Diary',
    description: 'Write a session diary entry. Record what happened, what was decided, what matters next.',
    inputSchema: z.object({
        content: z.string().describe('Diary entry.'),
        agent: z.string().optional().describe('Agent name (default: "claude").'),
    }),
}, async ({ content, agent }) => {
    const entry = writeDiaryEntry(config.dataDir, content, agent);
    return json({ written: true, date: entry.date, time: entry.time, agent: entry.agent });
});
server.registerTool('memory-diary-read', {
    title: 'Read Diary',
    description: 'Read diary entries from recent days or a specific date.',
    inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD. If omitted, returns recent.'),
        daysBack: z.number().optional().describe('Days to look back (default: 7).'),
        agent: z.string().optional().describe('Filter by agent.'),
    }),
}, async ({ date, daysBack, agent }) => {
    const entries = readDiary(config.dataDir, { date, daysBack, agent });
    return json(entries);
});
// ─────────────────────────────────────────────────────────────────────
// HANDOFF TOOLS — cross-session "where we left off" lifeline
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-handoff-write', {
    title: 'Write Handoff Note',
    description: 'Write a structured "where we left off" snapshot (a.k.a. session checkpoint). Call BEFORE /compact, before session end, when context_pressure returns hot/critical, or when the user asks to "save this session." Pass an optional `name` (e.g. "engram-named-checkpoints") so the user can later list-and-pick rather than scanning timestamps. This is the lifeline if the context window fills before compaction runs.',
    inputSchema: z.object({
        currentTask: z.string().describe('One-sentence description of what you are working on.'),
        name: z.string().optional().describe('Human-friendly checkpoint name (kebab-case recommended) for list-and-pick resume. Optional — omit for an unnamed timestamped handoff.'),
        reason: z.enum(['compact', 'session-end', 'manual', 'context-pressure']).optional().describe('Why this handoff is being written (default: manual).'),
        sessionId: z.string().optional().describe('Session/conversation ID for cross-referencing.'),
        completed: z.array(z.string()).optional().describe('What has been completed this session.'),
        nextSteps: z.array(z.string()).optional().describe('Concrete next actions to take on resume.'),
        openQuestions: z.array(z.string()).optional().describe('Unresolved questions or blockers.'),
        fileRefs: z.array(z.string()).optional().describe('File paths (ideally path:line) the next agent needs.'),
        decisions: z.array(z.string()).optional().describe('Key decisions made this session.'),
        notes: z.string().optional().describe('Free-form additional context, quirks, gotchas.'),
    }),
}, async ({ currentTask, name, reason, sessionId, completed, nextSteps, openQuestions, fileRefs, decisions, notes }) => {
    const note = writeHandoff(config.dataDir, {
        ...(name ? { name } : {}),
        sessionId: sessionId ?? null,
        reason: reason ?? 'manual',
        currentTask,
        completed: completed ?? [],
        nextSteps: nextSteps ?? [],
        openQuestions: openQuestions ?? [],
        fileRefs: fileRefs ?? [],
        decisions: decisions ?? [],
        notes: notes ?? '',
    });
    return json({
        written: true,
        timestamp: note.timestamp,
        name: note.name,
        reason: note.reason,
        summary: note.currentTask,
    });
});
server.registerTool('memory-handoff-read', {
    title: 'Read Handoff Note',
    description: 'Read a saved handoff/checkpoint. With no arg, returns the most recent. Pass `name` to load a named checkpoint, or `stamp` to load a specific timestamp. Set `list=true` to get recent checkpoints (deprecated — prefer memory-handoff-list).',
    inputSchema: z.object({
        name: z.string().optional().describe('Named checkpoint to load (e.g. "engram-named-checkpoints"). Takes precedence over stamp if both are provided.'),
        stamp: z.string().optional().describe('Handoff stamp to load (e.g. "2026-04-20_14-32-05"). If omitted and no name, returns the latest.'),
        list: z.boolean().optional().describe('Deprecated — use memory-handoff-list. If true, lists recent checkpoints.'),
        limit: z.number().min(1).max(50).optional().describe('For list mode: max entries to return (default 10).'),
    }),
}, async ({ name, stamp, list, limit }) => {
    if (list) {
        return json({ handoffs: listHandoffs(config.dataDir, limit ?? 10) });
    }
    const note = readHandoff(config.dataDir, name ?? stamp);
    if (!note) {
        const identifier = name ?? stamp;
        return json({
            found: false,
            message: identifier
                ? `No handoff found matching "${identifier}". Use memory-handoff-list to see saved checkpoints.`
                : 'No handoff note available.',
        });
    }
    return json({ found: true, ...note });
});
server.registerTool('memory-handoff-list', {
    title: 'List Handoff Checkpoints',
    description: 'List recent saved handoffs/checkpoints, newest first. Each entry includes stamp, timestamp, reason, currentTask snippet, and (if set) the user-facing name. Call this when the user asks to "resume" or "pick up where we left off" so you can present options before loading one with memory-handoff-read.',
    inputSchema: z.object({
        limit: z.number().min(1).max(50).optional().describe('Max checkpoints to return (default 10, max 50).'),
    }),
}, async ({ limit }) => {
    return json({ handoffs: listHandoffs(config.dataDir, limit ?? 10) });
});
server.registerTool('memory-context-pressure', {
    title: 'Context Pressure Check',
    description: 'Self-assess context window pressure and get an action plan. Call periodically during long sessions — especially after big tool outputs, many file reads, or when responses feel sluggish. Levels: ok, warm, hot, critical. Also call with phaseBoundary=true at natural phase boundaries (task complete, pivoting focus, finishing a subsystem) — pivots thrash the cache anyway, so that is the RIGHT moment to compact. Returns an ordered actionPlan telling you exactly what to do (save memories, write handoff, compact).',
    inputSchema: z.object({
        level: z.enum(['ok', 'warm', 'hot', 'critical']).describe('Your honest assessment of current context pressure.'),
        reason: z.string().optional().describe('What triggered this check (e.g. "long file reads", "extended session", "near token limit", "phase complete").'),
        phaseBoundary: z.boolean().optional().describe('True when a task/phase just finished or you are about to pivot focus. Forces the action plan toward a proactive compact, even at ok/warm levels.'),
    }),
}, async ({ level, reason, phaseBoundary }) => {
    return json(assessPressure(level, reason ?? '', phaseBoundary ?? false));
});
// ─────────────────────────────────────────────────────────────────────
// CLOUD AUTH — device-code login + credentials file management
// ─────────────────────────────────────────────────────────────────────
// The MCP login flow is two-step because device-code pairing needs the
// user to approve in a browser, which usually takes longer than a single
// MCP tool call can wait. Tool 1 starts the pairing and returns the URL +
// user code. Tool 2 polls for approval in chunks short enough to stay
// under the MCP tool timeout. The caller re-invokes tool 2 if the user
// is still finishing the browser flow.
function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Cap a single resume call well under the MCP tool timeout. Leaves
// headroom for the final pollDeviceCode round-trip after the loop's
// "still pending" exit check.
const RESUME_MAX_DURATION_MS = 45_000;
server.registerTool('memory-login', {
    title: 'Cloud Login (start device-code pairing)',
    description: [
        'Start a device-code login against a przm Cloud server (the same flow as the `przm-memory login` CLI command).',
        'Returns the URL and user code the human must visit + enter in a browser. AFTER showing those to the user, call `memory-login-resume` with the returned `deviceCode` to poll for approval — it may need to be called more than once if the user is slow.',
        'On approval the credentials file at `~/.pyre/credentials.json` (or $PYRE_CREDENTIALS_FILE) is written and przm Memory\'s cloud storage adapter starts using it on next server start.',
    ].join(' '),
    inputSchema: z.object({
        serverUrl: z.string().describe('przm Cloud base URL (e.g. https://przm.sh). No trailing slash needed.'),
        label: z.string().optional().describe('Friendly device label to attach to the issued credential. Defaults to this machine\'s hostname.'),
    }),
}, async ({ serverUrl, label }) => {
    const apiUrl = serverUrl.trim().replace(/\/+$/, '');
    if (!apiUrl) {
        return json({ ok: false, error: 'serverUrl is required (e.g. https://przm.sh).' });
    }
    try {
        const start = await startDeviceCode(fetch, apiUrl, label?.trim() || hostname(), sleepMs);
        const expiresAt = Date.now() + start.expires_in * 1000;
        return json({
            ok: true,
            serverUrl: apiUrl,
            verificationUrl: start.verification_url,
            userCode: start.user_code,
            deviceCode: start.device_code,
            intervalSeconds: start.interval,
            expiresInSeconds: start.expires_in,
            expiresAt,
            instructions: `Show the user this URL and code, then call memory-login-resume({ serverUrl: "${apiUrl}", deviceCode: "${start.device_code}", intervalSeconds: ${start.interval}, expiresAt: ${expiresAt} }) to poll for approval. If it returns "pending", call it again.`,
        });
    }
    catch (err) {
        return json({ ok: false, error: `Could not reach ${apiUrl}: ${err.message}` });
    }
});
server.registerTool('memory-login-resume', {
    title: 'Cloud Login (resume / poll device-code)',
    description: [
        'Poll a device-code pairing started by `memory-login`. Polls for ~45s, then returns one of: approved, pending, denied, expired, error.',
        'If "pending" is returned and `expiresAt` has not passed, call this tool again with the same arguments to keep waiting.',
        'On "approved" the credentials file is written and the response includes the storage api_url assigned by the server.',
    ].join(' '),
    inputSchema: z.object({
        serverUrl: z.string().describe('przm Cloud base URL — must match the one passed to memory-login.'),
        deviceCode: z.string().describe('device_code returned by memory-login.'),
        intervalSeconds: z.number().min(1).max(60).describe('Polling interval suggested by the server (returned by memory-login).'),
        expiresAt: z.number().describe('Epoch ms after which the device code is expired (returned by memory-login).'),
    }),
}, async ({ serverUrl, deviceCode, intervalSeconds, expiresAt }) => {
    const apiUrl = serverUrl.trim().replace(/\/+$/, '');
    const intervalMs = Math.max(1, intervalSeconds) * 1000;
    const stopAt = Math.min(Date.now() + RESUME_MAX_DURATION_MS, expiresAt);
    while (Date.now() < stopAt) {
        await sleepMs(intervalMs);
        if (Date.now() >= stopAt)
            break;
        let body;
        try {
            body = await pollDeviceCode(fetch, apiUrl, deviceCode);
        }
        catch {
            // Transient — keep polling until our window closes.
            continue;
        }
        if (body.status === 'pending')
            continue;
        if (body.status === 'denied') {
            return json({ ok: false, status: 'denied', error: 'Authorization denied.' });
        }
        if (body.status === 'expired') {
            return json({ ok: false, status: 'expired', error: 'Pairing code expired. Call memory-login again.' });
        }
        if (body.status === 'approved') {
            try {
                const creds = credentialsFromApproval(body);
                writeCredentials(creds);
                return json({
                    ok: true,
                    status: 'approved',
                    apiUrl: creds.api_url,
                    label: creds.label,
                    scopes: creds.scopes,
                    credentialsPath: credentialsPath(),
                    note: 'Credentials written. Restart the przm Memory MCP server (or your MCP client) for cloud storage to take effect.',
                });
            }
            catch (err) {
                return json({ ok: false, status: 'error', error: `Could not write credentials: ${err.message}` });
            }
        }
    }
    if (Date.now() >= expiresAt) {
        return json({ ok: false, status: 'expired', error: 'Pairing code expired. Call memory-login again.' });
    }
    return json({
        ok: true,
        status: 'pending',
        secondsUntilExpiry: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
        note: 'Still waiting on browser approval. Call memory-login-resume again with the same arguments.',
    });
});
server.registerTool('memory-login-status', {
    title: 'Cloud Login Status',
    description: 'Inspect the local przm Cloud credentials file. Returns whether the user is logged in, the api_url and label of the active credential, and the credentials file path. No network calls.',
    inputSchema: z.object({}),
}, async () => {
    const path = credentialsPath();
    const stat = credentialsStat();
    const creds = readCredentials();
    if (!creds) {
        return json({ loggedIn: false, credentialsPath: path, fileExists: stat !== null });
    }
    return json({
        loggedIn: true,
        credentialsPath: path,
        apiUrl: creds.api_url,
        label: creds.label,
        scopes: creds.scopes,
        issuedAt: creds.issued_at,
    });
});
server.registerTool('memory-logout', {
    title: 'Cloud Logout',
    description: 'Delete the local przm Cloud credentials file. Idempotent — succeeds whether or not the file existed. przm Memory falls back to local LanceDB on next server start.',
    inputSchema: z.object({}),
}, async () => {
    const path = credentialsPath();
    const removed = deleteCredentials();
    return json({
        ok: true,
        loggedOut: removed,
        alreadyLoggedOut: !removed,
        credentialsPath: path,
        note: removed ? 'Restart the przm Memory MCP server to fall back to local storage.' : undefined,
    });
});
// ─────────────────────────────────────────────────────────────────────
// DIAGNOSTIC RETRIEVAL TRACES
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-trace-recent', {
    title: 'Recent Retrieval Traces',
    description: [
        'List the most recent diagnostic retrieval traces. Each trace captures: query text, filters, per-stage candidate counts (corpus → vector above/below floor → keyword → final), result IDs, and total latency.',
        'Use this when investigating "why didn\'t you find the obvious doc" complaints — the trace shows whether the result was retrieved at all, whether it survived the floor, and which stage dropped it.',
        'Traces only persist when ENGRAM_ENABLE_RETRIEVAL_TRACES=true (default off). Returns an empty list when traces are disabled or no searches have run.',
    ].join(' '),
    inputSchema: z.object({
        limit: z.number().min(1).max(200).optional().describe('Max traces to return (default: 25, max: 200).'),
    }),
}, async ({ limit }) => {
    if (!config.enableRetrievalTraces) {
        return json({
            enabled: false,
            traces: [],
            note: 'Retrieval traces are disabled. Enable with ENGRAM_ENABLE_RETRIEVAL_TRACES=true (then restart przm Memory).',
        });
    }
    const traces = await listRecentTraces({ dataDir: config.dataDir, retentionDays: config.retrievalTraceRetentionDays }, limit ?? 25);
    return json({
        enabled: true,
        retentionDays: config.retrievalTraceRetentionDays,
        count: traces.length,
        traces,
    });
});
// ─────────────────────────────────────────────────────────────────────
// IMPORT
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory-import', {
    title: 'Import',
    description: 'Bulk import from chat exports: claude-jsonl, chatgpt-json, or plain-text.',
    inputSchema: z.object({
        format: z.enum(['claude-jsonl', 'chatgpt-json', 'plain-text']).describe('Export format.'),
        content: z.string().describe('Raw export content.'),
    }),
}, async ({ format, content }) => {
    const storage = await ensureStorage();
    const result = await importConversation(config, storage, format, content);
    return json(result);
});
// ─────────────────────────────────────────────────────────────────────
// ENGRAM-* BACKWARD COMPATIBILITY ALIASES
// ─────────────────────────────────────────────────────────────────────
// Tool names were renamed from engram-* → memory-* in v1.0.0-beta.7.
// These aliases keep existing installations working. The canonical names
// are memory-*; the engram-* aliases will be removed in v2.
//
// Implementation: after all canonical registrations are done, copy each
// registered-tool entry into the SDK's internal registry under the old
// name. Shares the same handler and schema — no logic duplication.
{
    const rt = server._registeredTools;
    const aliases = [
        ['memory-search', 'engram-search'],
        ['memory-ingest', 'engram-ingest'],
        ['memory-scratch-promote', 'engram-scratch-promote'],
        ['memory-extract', 'engram-extract'],
        ['memory-maintain', 'engram-maintain'],
        ['memory-rules', 'engram-rules'],
        ['memory-outcome', 'engram-outcome'],
        ['memory-session', 'engram-session'],
        ['memory-stats', 'engram-stats'],
        ['memory-govern', 'engram-govern'],
        ['memory-kg-add', 'engram-kg-add'],
        ['memory-kg-query', 'engram-kg-query'],
        ['memory-kg-invalidate', 'engram-kg-invalidate'],
        ['memory-kg-timeline', 'engram-kg-timeline'],
        ['memory-diary-write', 'engram-diary-write'],
        ['memory-diary-read', 'engram-diary-read'],
        ['memory-handoff-write', 'engram-handoff-write'],
        ['memory-handoff-read', 'engram-handoff-read'],
        ['memory-context-pressure', 'engram-context-pressure'],
        ['memory-import', 'engram-import'],
    ];
    for (const [canonical, alias] of aliases) {
        if (rt[canonical])
            rt[alias] = rt[canonical];
    }
}
// ── Start Server ────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('przm Memory MCP server running on stdio');
    console.error(`Data dir: ${config.dataDir}`);
    console.error(`LLM: ${isLlmAvailable() ? 'enabled' : 'disabled (heuristic mode)'}`);
    console.error(`Embeddings: local (${process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'})`);
    console.error(`Mem0: ${config.mem0ApiKey ? 'enabled' : 'disabled'}`);
    console.error(`Retrieval traces: ${config.enableRetrievalTraces ? `enabled (${config.retrievalTraceRetentionDays}d retention)` : 'disabled'}`);
    // Best-effort trace GC on startup. Drops day-directories older than
    // retentionDays. Cheap when the feature is off (no traces dir to scan).
    if (config.enableRetrievalTraces) {
        void gcOldTraces({ dataDir: config.dataDir, retentionDays: config.retrievalTraceRetentionDays });
    }
    // Fire-and-forget warmup of the local embedding model so the user's
    // first search/recall doesn't pay the 1.5–5s ONNX cold-start cost
    // (or the 10–30s first-run model download). The MCP handshake +
    // typical user "what should I ask?" think-time runs in parallel
    // with this and usually fully overlaps it.
    void warmEmbeddings();
}
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map