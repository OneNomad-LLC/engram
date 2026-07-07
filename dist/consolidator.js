import { DEFAULT_CONFIG } from './types.js';
import { cosineSimilarity, getEdgeTargetIds, addEdge } from './utils.js';
import { consolidateEpisodic } from './episodic-consolidator.js';
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Background consolidation pass: links, decays, promotes, demotes, and merges memories.
 * Run this periodically (e.g., daily or at session start).
 */
export async function consolidate(storage, config) {
    const cfg = config ?? DEFAULT_CONFIG;
    const stats = {
        linked: 0, decayed: 0, promoted: 0, demoted: 0,
        reactivated: 0, dailyMoved: 0, merged: 0,
        episodicClustered: 0, episodicSummarized: 0,
        selfOrganized: 0, scratchPurged: 0,
    };
    let chunks = await storage.listChunks();
    // Buffer every updateChunk/deleteChunk the passes below issue into one
    // batch, committed once at the end. Each pass still reads from the
    // in-memory `chunks` snapshot (not storage), so buffering the writes
    // doesn't change what any pass sees — only how the writes hit disk.
    // Without this, decay + link + merge fire thousands of per-row LanceDB
    // updates and a full pass over a few-thousand-chunk store takes >1h.
    storage.beginBatch();
    try {
        // Scratch tier: session-only memories. Purge expired ones first, then
        // exclude live scratch from all other consolidation paths so they never
        // get linked, decayed, merged, or promoted.
        stats.scratchPurged = await purgeExpiredScratch(storage, chunks);
        chunks = chunks.filter(c => c.tier !== 'scratch');
        // Biased replay: prioritize chunks by importance * recency * surprise
        if (cfg.enableBiasedReplay) {
            chunks = sortByReplayPriority(chunks);
        }
        stats.dailyMoved = await processDailyTier(storage, chunks);
        stats.promoted = await promoteChunks(storage, chunks);
        stats.demoted = await demoteToArchive(storage, chunks);
        stats.reactivated = await reactivateArchived(storage, chunks);
        stats.linked = await linkRelated(storage, chunks);
        stats.decayed = cfg.enableFSRS
            ? await decayFSRS(storage, chunks) + await decayIrrelevant(storage, chunks)
            : await decayImportance(storage, chunks) + await decayIrrelevant(storage, chunks);
        stats.merged = await mergeNearDuplicates(storage, chunks);
        // Self-organizing memories: auto-describe undescribed memories and generate cross-links
        stats.selfOrganized = await selfOrganize(storage, chunks);
        // Episodic-to-semantic consolidation (Improvement 8). Its new summary
        // chunks are inserted directly (saveChunks isn't buffered); its updates
        // to source chunks ride the same batch.
        if (cfg.enableEpisodicConsolidation) {
            const episodic = await consolidateEpisodic(cfg, storage);
            stats.episodicClustered = episodic.clustered;
            stats.episodicSummarized = episodic.summarized;
        }
    }
    finally {
        await storage.flushBatch();
    }
    return stats;
}
// ── Scratch tier: session-only memories ──────────────────────────────
// Created by callers who want to keep something in the working set without
// it being treated as canonical knowledge. Purged after SCRATCH_TTL_MS unless
// promoted explicitly via engram-scratch-promote.
async function purgeExpiredScratch(storage, chunks) {
    let purged = 0;
    const now = Date.now();
    for (const chunk of chunks) {
        if (chunk.tier !== 'scratch')
            continue;
        if (now - new Date(chunk.createdAt).getTime() >= SCRATCH_TTL_MS) {
            await storage.deleteChunk(chunk.id);
            purged++;
        }
    }
    return purged;
}
// ── Daily → Short-term ───────────────────────────────────────────────
async function processDailyTier(storage, chunks) {
    let moved = 0;
    const now = Date.now();
    const retentionMs = 2 * 86_400_000;
    for (const chunk of chunks) {
        if (chunk.tier !== 'daily')
            continue;
        if (now - new Date(chunk.createdAt).getTime() >= retentionMs) {
            if (chunk.importance >= 0.3 || chunk.recallCount > 0) {
                await storage.updateChunk(chunk.id, { tier: 'short-term' });
                moved++;
            }
        }
    }
    return moved;
}
// ── Short-term → Long-term ───────────────────────────────────────────
async function promoteChunks(storage, chunks) {
    let promoted = 0;
    for (const chunk of chunks) {
        if (chunk.tier !== 'short-term')
            continue;
        const ageDays = daysSince(chunk.createdAt);
        const lastRecalledDays = chunk.lastRecalledAt ? daysSince(chunk.lastRecalledAt) : Infinity;
        const helpfulCount = chunk.recallOutcomes.filter(o => o.outcome === 'helpful').length;
        const shouldPromote = chunk.importance >= 0.8 ||
            (chunk.recallCount >= 3 && ageDays >= 7) ||
            (helpfulCount >= 2 && lastRecalledDays < 7) ||
            (chunk.cognitiveLayer === 'procedural' && chunk.importance >= 0.5) ||
            (chunk.recallCount >= 1 && ageDays >= 30 && lastRecalledDays < 7);
        if (shouldPromote) {
            await storage.updateChunk(chunk.id, { tier: 'long-term' });
            promoted++;
        }
    }
    return promoted;
}
// ── Long-term → Archive ──────────────────────────────────────────────
async function demoteToArchive(storage, chunks) {
    let demoted = 0;
    const now = Date.now();
    for (const chunk of chunks) {
        if (chunk.tier !== 'long-term')
            continue;
        // User-asserted memories are user-territory: never auto-archive.
        // The user can explicitly delete or update_metadata to retire them.
        if (chunk.origin === 'user')
            continue;
        const ageMs = now - new Date(chunk.createdAt).getTime();
        const lastRecallMs = chunk.lastRecalledAt
            ? now - new Date(chunk.lastRecalledAt).getTime()
            : Infinity;
        const tooOld = ageMs >= 90 * 86_400_000;
        const inactive = lastRecallMs >= 30 * 86_400_000;
        if (tooOld || (inactive && chunk.importance < 0.3)) {
            await storage.updateChunk(chunk.id, { tier: 'archive' });
            demoted++;
        }
    }
    return demoted;
}
// ── Archive → Long-term (reactivation) ───────────────────────────────
async function reactivateArchived(storage, chunks) {
    let reactivated = 0;
    const now = Date.now();
    for (const chunk of chunks) {
        if (chunk.tier !== 'archive' || !chunk.lastRecalledAt)
            continue;
        if (now - new Date(chunk.lastRecalledAt).getTime() < 7 * 86_400_000) {
            await storage.updateChunk(chunk.id, { tier: 'long-term' });
            reactivated++;
        }
    }
    return reactivated;
}
// ── Tag-based Linking ────────────────────────────────────────────────
async function linkRelated(storage, chunks) {
    let linked = 0;
    const tagIndex = new Map();
    const chunkMap = new Map();
    for (const chunk of chunks) {
        if (chunk.tier === 'archive')
            continue;
        chunkMap.set(chunk.id, chunk);
        for (const tag of chunk.tags) {
            const ids = tagIndex.get(tag) ?? [];
            ids.push(chunk.id);
            tagIndex.set(tag, ids);
        }
    }
    const seen = new Set();
    for (const [, ids] of tagIndex) {
        if (ids.length < 2 || ids.length > 50)
            continue;
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = chunkMap.get(ids[i]);
                const b = chunkMap.get(ids[j]);
                const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                if (getEdgeTargetIds(a.relatedMemories).includes(b.id))
                    continue;
                const overlap = a.tags.filter(t => b.tags.includes(t));
                if (overlap.length >= 2 || (overlap.length >= 1 && a.cognitiveLayer === b.cognitiveLayer)) {
                    const rel = a.source === b.source ? 'temporal' : 'semantic';
                    const weight = Math.min(1.0, 0.3 + overlap.length * 0.15);
                    const aEdges = addEdge(a.relatedMemories, b.id, rel, weight);
                    const bEdges = addEdge(b.relatedMemories, a.id, rel, weight);
                    await storage.updateChunk(a.id, { relatedMemories: aEdges });
                    await storage.updateChunk(b.id, { relatedMemories: bEdges });
                    a.relatedMemories = aEdges;
                    b.relatedMemories = bEdges;
                    linked++;
                }
            }
        }
    }
    return linked;
}
// ── Importance Decay ─────────────────────────────────────────────────
async function decayImportance(storage, chunks) {
    let decayed = 0;
    const now = Date.now();
    const rates = { procedural: 0.98, semantic: 0.97, episodic: 0.95 };
    const floors = { procedural: 0.15, semantic: 0.10, episodic: 0.05 };
    for (const chunk of chunks) {
        if (chunk.tier === 'archive')
            continue;
        const lastTouch = chunk.lastRecalledAt
            ? new Date(chunk.lastRecalledAt).getTime()
            : new Date(chunk.createdAt).getTime();
        const daysSinceTouch = (now - lastTouch) / 86_400_000;
        if (daysSinceTouch < 7)
            continue;
        const rate = rates[chunk.cognitiveLayer] ?? 0.97;
        const floor = floors[chunk.cognitiveLayer] ?? 0.10;
        const weeks = daysSinceTouch / 7;
        const newImportance = Math.max(floor, chunk.importance * Math.pow(rate, weeks));
        if (Math.abs(newImportance - chunk.importance) > 0.01) {
            await storage.updateChunk(chunk.id, { importance: newImportance });
            decayed++;
        }
    }
    return decayed;
}
// ── Decay Irrelevant ─────────────────────────────────────────────────
async function decayIrrelevant(storage, chunks) {
    let decayed = 0;
    for (const chunk of chunks) {
        const outcomes = chunk.recallOutcomes;
        if (outcomes.length < 3)
            continue;
        const recent = outcomes.slice(-5);
        const irrelevant = recent.filter(o => o.outcome === 'irrelevant').length;
        if (irrelevant >= 3) {
            const newImportance = Math.max(0.05, chunk.importance - 0.2);
            await storage.updateChunk(chunk.id, { importance: newImportance });
            // Never auto-archive user-asserted memories on recall-outcome decay —
            // the user explicitly saved them; "irrelevant for this query" doesn't
            // mean retire.
            if (newImportance <= 0.1 && chunk.origin !== 'user') {
                await storage.updateChunk(chunk.id, { tier: 'archive' });
            }
            decayed++;
        }
    }
    return decayed;
}
// ── Near-duplicate Merging ───────────────────────────────────────────
async function mergeNearDuplicates(storage, chunks) {
    let merged = 0;
    const consumed = new Set();
    const candidates = chunks
        .filter(c => c.cognitiveLayer === 'semantic' && c.embedding && c.embedding.length > 0)
        .sort((a, b) => new Date(b.lastRecalledAt ?? b.createdAt).getTime() -
        new Date(a.lastRecalledAt ?? a.createdAt).getTime())
        .slice(0, 200);
    for (const chunk of candidates) {
        if (consumed.has(chunk.id))
            continue;
        for (const other of candidates) {
            if (other.id === chunk.id || consumed.has(other.id))
                continue;
            if (!other.embedding || !chunk.embedding)
                continue;
            if (cosineSimilarity(chunk.embedding, other.embedding) > 0.9) {
                // Pick keeper by importance, but a user-origin memory always wins
                // over a derived one — user-asserted text is canonical, never
                // displaced by an auto-extracted near-duplicate.
                let keeper;
                let loser;
                if (chunk.origin === 'user' && other.origin !== 'user') {
                    keeper = chunk;
                    loser = other;
                }
                else if (other.origin === 'user' && chunk.origin !== 'user') {
                    keeper = other;
                    loser = chunk;
                }
                else if (chunk.origin === 'user' && other.origin === 'user') {
                    // Both user-asserted near-duplicates: leave both. Merging would
                    // delete content the user explicitly wrote.
                    continue;
                }
                else {
                    keeper = chunk.importance >= other.importance ? chunk : other;
                    loser = keeper === chunk ? other : chunk;
                }
                await storage.updateChunk(keeper.id, {
                    recallCount: keeper.recallCount + loser.recallCount,
                    importance: Math.min(1.0, keeper.importance + 0.03),
                });
                await storage.deleteChunk(loser.id);
                consumed.add(loser.id);
                merged++;
            }
        }
    }
    return merged;
}
// ── FSRS Decay (Improvement 3) + Adaptive Forgetting ──────────────
// Free Spaced Repetition Scheduler: R = (1 + t/(9*S))^(-1)
// More principled than exponential decay. Stability grows with successful recall.
//
// Adaptive forgetting (FadeMem-inspired): semantic proximity to recently
// active memories modulates decay rate. Memories near active clusters
// decay slower (proximity shield), isolated memories decay faster.
function fsrsRetrievability(t, S) {
    return Math.pow(1 + t / (9 * S), -1);
}
/**
 * Collect recently active memories (recalled or ingested in the last N days)
 * to serve as "active cluster" exemplars for adaptive forgetting.
 */
function getActiveExemplars(chunks, windowDays = 7) {
    const now = Date.now();
    const cutoff = now - windowDays * 86_400_000;
    return chunks
        .filter(c => {
        if (c.tier === 'archive')
            return false;
        const lastActive = c.lastRecalledAt
            ? Math.max(new Date(c.lastRecalledAt).getTime(), new Date(c.createdAt).getTime())
            : new Date(c.createdAt).getTime();
        return lastActive >= cutoff;
    })
        .filter(c => c.embedding && c.embedding.length > 0)
        .sort((a, b) => {
        const aTime = new Date(a.lastRecalledAt ?? a.createdAt).getTime();
        const bTime = new Date(b.lastRecalledAt ?? b.createdAt).getTime();
        return bTime - aTime;
    })
        .slice(0, 10); // Keep top 10 most recent as exemplars
}
/**
 * Compute max cosine similarity between a chunk and active exemplars.
 * Returns 0 if no embedding available — falls back to tag overlap.
 */
function computeProximityFactor(chunk, exemplars) {
    if (exemplars.length === 0)
        return 0;
    // Embedding-based proximity
    if (chunk.embedding && chunk.embedding.length > 0) {
        let maxSim = 0;
        for (const ex of exemplars) {
            if (!ex.embedding || ex.embedding.length !== chunk.embedding.length)
                continue;
            const sim = cosineSimilarity(chunk.embedding, ex.embedding);
            if (sim > maxSim)
                maxSim = sim;
        }
        return maxSim;
    }
    // Tag-based fallback: Jaccard similarity between tags
    if (chunk.tags.length === 0)
        return 0;
    const chunkTags = new Set(chunk.tags);
    let maxJaccard = 0;
    for (const ex of exemplars) {
        if (ex.tags.length === 0)
            continue;
        const exTags = new Set(ex.tags);
        let intersection = 0;
        for (const t of chunkTags)
            if (exTags.has(t))
                intersection++;
        const union = new Set([...chunkTags, ...exTags]).size;
        const jaccard = union > 0 ? intersection / union : 0;
        if (jaccard > maxJaccard)
            maxJaccard = jaccard;
    }
    return maxJaccard;
}
async function decayFSRS(storage, chunks) {
    let decayed = 0;
    const now = Date.now();
    const floors = { procedural: 0.15, semantic: 0.10, episodic: 0.05 };
    // Adaptive forgetting: compute active exemplars once
    const exemplars = getActiveExemplars(chunks);
    for (const chunk of chunks) {
        if (chunk.tier === 'archive')
            continue;
        const lastTouch = chunk.lastRecalledAt
            ? new Date(chunk.lastRecalledAt).getTime()
            : new Date(chunk.createdAt).getTime();
        const daysSinceTouch = (now - lastTouch) / 86_400_000;
        if (daysSinceTouch < 3)
            continue;
        const baseStability = chunk.stability ?? 1.0;
        // Adaptive forgetting: proximity to active memories modulates stability
        const proximity = computeProximityFactor(chunk, exemplars);
        let effectiveStability;
        if (proximity > 0.5) {
            // Proximate memories: stability boosted by up to 3x
            effectiveStability = baseStability * (1 + proximity * 2);
        }
        else if (proximity < 0.2) {
            // Isolated memories: accelerated decay (70% stability)
            effectiveStability = baseStability * 0.7;
        }
        else {
            // Moderate proximity: normal decay
            effectiveStability = baseStability;
        }
        const floor = floors[chunk.cognitiveLayer] ?? 0.10;
        const retrievability = fsrsRetrievability(daysSinceTouch, effectiveStability);
        const newImportance = Math.max(floor, chunk.importance * retrievability);
        if (Math.abs(newImportance - chunk.importance) > 0.01) {
            await storage.updateChunk(chunk.id, { importance: newImportance });
            decayed++;
        }
    }
    return decayed;
}
/**
 * Update FSRS stability after a recall outcome.
 * Call this from outcome.ts when a memory is recalled.
 */
export function computeFSRSUpdate(chunk, outcome) {
    const S = chunk.stability ?? 1.0;
    const D = chunk.difficulty ?? 0.3;
    switch (outcome) {
        case 'helpful': {
            // Stability growth: easier memories grow faster
            const growth = S * (1 + Math.exp(0.1) * (11 - D * 10) * Math.pow(S, -0.2));
            return { stability: Math.min(365, growth), difficulty: Math.max(0, D - 0.02) };
        }
        case 'corrected': {
            // Halve stability, increase difficulty
            return { stability: Math.max(0.5, S * 0.5), difficulty: Math.min(1.0, D + 0.1) };
        }
        case 'irrelevant': {
            // Reduce stability, slight difficulty increase
            return { stability: Math.max(0.5, S * 0.8), difficulty: Math.min(1.0, D + 0.05) };
        }
    }
}
// ── Biased Replay (Improvement 5) ──────────────────────────────────
// Prioritize consolidation by importance * recency * surprise.
// High-surprise memories (corrections, contradictions) get extra attention.
function sortByReplayPriority(chunks) {
    const now = Date.now();
    return [...chunks].sort((a, b) => {
        const priorityA = replayPriority(a, now);
        const priorityB = replayPriority(b, now);
        return priorityB - priorityA;
    });
}
function replayPriority(chunk, now) {
    const lastTouch = chunk.lastRecalledAt
        ? new Date(chunk.lastRecalledAt).getTime()
        : new Date(chunk.createdAt).getTime();
    const recencyDays = (now - lastTouch) / 86_400_000;
    const recency = Math.exp(-recencyDays / 30); // Half-life ~30 days
    const importance = chunk.importance;
    // Surprise: corrections and corrected outcomes score higher
    let surprise = 0;
    if (chunk.type === 'correction')
        surprise += 0.5;
    const recentOutcomes = chunk.recallOutcomes.slice(-5);
    const correctedCount = recentOutcomes.filter(o => o.outcome === 'corrected').length;
    surprise += correctedCount * 0.2;
    return importance * recency * (1 + surprise);
}
// ── Helpers ──────────────────────────────────────────────────────────
// ── Self-Organizing Memories ─────────────────────────────────────────
// Auto-generate domain/topic for memories that lack them, and create
// cross-links between semantically related memories that share no tags.
// Runs during consolidation — no new MCP tools needed.
async function selfOrganize(storage, chunks) {
    let organized = 0;
    // Phase 1: Auto-describe — infer domain/topic from content heuristics
    const undescribed = chunks.filter(c => c.tier !== 'archive' && (!c.domain || !c.topic));
    for (const chunk of undescribed.slice(0, 50)) {
        const updates = {};
        const lower = chunk.content.toLowerCase();
        // Domain inference from keywords
        if (!chunk.domain) {
            const domainSignals = {
                code: ['function', 'import', 'export', 'typescript', 'react', 'component', 'api', 'endpoint', 'bug', 'refactor', 'deploy'],
                design: ['figma', 'layout', 'color', 'font', 'responsive', 'ui', 'ux', 'component', 'tailwind'],
                infrastructure: ['vercel', 'docker', 'ci/cd', 'deploy', 'database', 'postgres', 'env', 'server'],
                business: ['pricing', 'customer', 'marketing', 'revenue', 'competitor', 'launch', 'user'],
                personal: ['prefer', 'like', 'dislike', 'always', 'never', 'habit', 'schedule'],
            };
            for (const [domain, keywords] of Object.entries(domainSignals)) {
                const hits = keywords.filter(k => lower.includes(k)).length;
                if (hits >= 2) {
                    updates.domain = domain;
                    break;
                }
            }
        }
        // Topic inference from tags or content
        if (!chunk.topic && chunk.tags.length > 0) {
            // Use the most specific tag as topic
            updates.topic = chunk.tags
                .filter(t => t.length > 2 && !['general', 'misc', 'other'].includes(t))
                .sort((a, b) => b.length - a.length)[0];
        }
        if (Object.keys(updates).length > 0) {
            await storage.updateChunk(chunk.id, updates);
            organized++;
        }
    }
    // Phase 2: Cross-link — find semantically similar memories with no existing edges
    const candidates = chunks
        .filter(c => c.tier !== 'archive' && c.embedding && c.embedding.length > 0)
        .slice(0, 100);
    for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i];
        const existingTargets = new Set(getEdgeTargetIds(a.relatedMemories));
        for (let j = i + 1; j < candidates.length; j++) {
            const b = candidates[j];
            if (existingTargets.has(b.id))
                continue;
            const sim = cosineSimilarity(a.embedding, b.embedding);
            if (sim > 0.7 && sim < 0.9) { // Related but not duplicate
                const weight = Math.min(1.0, sim);
                const aEdges = addEdge(a.relatedMemories, b.id, 'semantic', weight);
                const bEdges = addEdge(b.relatedMemories, a.id, 'semantic', weight);
                await storage.updateChunk(a.id, { relatedMemories: aEdges });
                await storage.updateChunk(b.id, { relatedMemories: bEdges });
                a.relatedMemories = aEdges;
                b.relatedMemories = bEdges;
                organized++;
            }
        }
    }
    return organized;
}
function daysSince(dateStr) {
    return (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
}
//# sourceMappingURL=consolidator.js.map