import { randomUUID } from 'node:crypto';
import { embed, llmComplete, isLlmAvailable, getEmbeddingModelProfile } from './llm.js';
import { cosineSimilarity, buildContextPrefix } from './utils.js';
/**
 * Run episodic-to-semantic consolidation.
 * Clusters related episodic memories older than 7 days,
 * generates summaries, and stores them as L1 semantic chunks.
 */
export async function consolidateEpisodic(config, storage) {
    const stats = { clustered: 0, summarized: 0, promoted: 0 };
    const chunks = await storage.listChunks({ cognitiveLayer: 'episodic' });
    const now = Date.now();
    // Only consolidate L0 episodic chunks older than 7 days
    const candidates = chunks.filter(c => {
        const age = (now - new Date(c.createdAt).getTime()) / 86_400_000;
        return age >= 7 && (c.consolidationLevel ?? 0) === 0;
    });
    if (candidates.length < 3)
        return stats;
    // Cluster by tag overlap + domain match + temporal proximity
    const clusters = clusterMemories(candidates);
    stats.clustered = clusters.length;
    for (const cluster of clusters) {
        if (cluster.length < 3)
            continue;
        // Generate summary
        const summary = await summarizeCluster(config, cluster);
        if (!summary || summary.length < 10)
            continue;
        // Create L1 summary chunk
        const summaryChunk = {
            id: randomUUID(),
            tier: 'long-term',
            content: summary,
            type: 'fact',
            cognitiveLayer: 'semantic',
            tags: extractSharedTags(cluster),
            domain: cluster[0].domain,
            topic: cluster[0].topic,
            source: `consolidation:${Date.now()}`,
            importance: Math.max(...cluster.map(c => c.importance)),
            sentiment: 'neutral',
            createdAt: new Date().toISOString(),
            lastRecalledAt: null,
            recallCount: 0,
            relatedMemories: [],
            recallOutcomes: [],
            stability: 5.0, // Higher initial stability for consolidated memories
            difficulty: 0.2,
            consolidationLevel: 1,
            sourceChunkIds: cluster.map(c => c.id),
            embeddingVersion: getEmbeddingModelProfile().version,
            origin: 'derived',
        };
        // Embed the summary
        try {
            const prefix = buildContextPrefix(summaryChunk);
            summaryChunk.embedding = await embed(config, summary, prefix);
        }
        catch { /* best-effort */ }
        await storage.saveChunk(summaryChunk);
        stats.summarized++;
        // Reduce importance of source chunks and mark them as consolidated
        // so they are excluded from future consolidation passes.
        // R-003: was incorrectly 0, which left chunks eligible for
        // re-selection and caused duplicate L1 summaries on every run.
        for (const source of cluster) {
            await storage.updateChunk(source.id, {
                importance: Math.max(0.05, source.importance * 0.7),
                consolidationLevel: 1,
            });
        }
    }
    // Promote L1 summaries to L2 if they've been around 30+ days with 3+ recalls
    const l1Chunks = await storage.listChunks({ cognitiveLayer: 'semantic' });
    for (const chunk of l1Chunks) {
        if ((chunk.consolidationLevel ?? 0) !== 1)
            continue;
        const age = (now - new Date(chunk.createdAt).getTime()) / 86_400_000;
        if (age >= 30 && chunk.recallCount >= 3) {
            await storage.updateChunk(chunk.id, {
                consolidationLevel: 2,
                stability: Math.max(chunk.stability ?? 5, 30), // L2 = very stable
            });
            stats.promoted++;
        }
    }
    return stats;
}
// ── Clustering ─────────────────────────────────────────────────────
function clusterMemories(chunks) {
    // Sort by createdAt (then id, deterministic tiebreak) so consecutive
    // memory-maintain runs against the same corpus produce the same
    // clusters. Without this, listChunks() scan order can vary between
    // LanceDB fragment states and the L1 summaries become non-
    // reproducible.
    const sorted = [...chunks].sort((a, b) => {
        const ta = Date.parse(a.createdAt ?? '');
        const tb = Date.parse(b.createdAt ?? '');
        if (ta !== tb)
            return ta - tb;
        return a.id.localeCompare(b.id);
    });
    const clusters = [];
    const assigned = new Set();
    for (const chunk of sorted) {
        if (assigned.has(chunk.id))
            continue;
        const cluster = [chunk];
        assigned.add(chunk.id);
        for (const other of sorted) {
            if (assigned.has(other.id))
                continue;
            if (shouldCluster(chunk, other, cluster)) {
                cluster.push(other);
                assigned.add(other.id);
            }
        }
        if (cluster.length >= 3) {
            clusters.push(cluster);
        }
    }
    return clusters;
}
function shouldCluster(seed, candidate, cluster) {
    // Tag overlap (Jaccard > 0.3)
    const seedTags = new Set(seed.tags);
    const candTags = new Set(candidate.tags);
    if (seedTags.size > 0 && candTags.size > 0) {
        let intersection = 0;
        for (const t of seedTags)
            if (candTags.has(t))
                intersection++;
        const union = new Set([...seedTags, ...candTags]).size;
        if (intersection / union > 0.3)
            return true;
    }
    // Same domain + topic
    if (seed.domain && seed.domain === candidate.domain && seed.topic && seed.topic === candidate.topic) {
        return true;
    }
    // Temporal proximity (within 7 days)
    const seedTime = new Date(seed.createdAt).getTime();
    const candTime = new Date(candidate.createdAt).getTime();
    const daysDiff = Math.abs(seedTime - candTime) / 86_400_000;
    if (daysDiff <= 7 && seed.domain === candidate.domain) {
        return true;
    }
    // Embedding similarity (if available)
    if (seed.embedding && candidate.embedding && seed.embedding.length === candidate.embedding.length) {
        if (cosineSimilarity(seed.embedding, candidate.embedding) > 0.6) {
            return true;
        }
    }
    return false;
}
// ── Summarization ──────────────────────────────────────────────────
async function summarizeCluster(config, cluster) {
    const contents = cluster.map(c => c.content).join('\n- ');
    if (isLlmAvailable()) {
        try {
            return await llmComplete(config, 'You consolidate related memories into a single concise summary. Extract the shared principle, pattern, or key fact. Output 1-2 sentences maximum. Do not add commentary.', `Related memories:\n- ${contents}`, { maxTokens: 150, temperature: 0 });
        }
        catch { /* fall through to heuristic */ }
    }
    // Heuristic: extract shared tags and build template
    const sharedTags = extractSharedTags(cluster);
    const dateRange = getDateRange(cluster);
    const domain = cluster[0].domain || 'general';
    return `Over ${dateRange}, ${cluster.length} interactions about ${domain}${sharedTags.length > 0 ? ` involving ${sharedTags.join(', ')}` : ''}. ${cluster[0].content.slice(0, 100)}`;
}
function extractSharedTags(cluster) {
    const tagCounts = new Map();
    for (const chunk of cluster) {
        for (const tag of chunk.tags) {
            tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
    }
    // Tags that appear in at least 50% of the cluster
    const threshold = cluster.length * 0.5;
    return Array.from(tagCounts.entries())
        .filter(([, count]) => count >= threshold)
        .map(([tag]) => tag);
}
function getDateRange(cluster) {
    const dates = cluster.map(c => new Date(c.createdAt)).sort((a, b) => a.getTime() - b.getTime());
    const first = dates[0].toISOString().split('T')[0];
    const last = dates[dates.length - 1].toISOString().split('T')[0];
    return first === last ? first : `${first} to ${last}`;
}
//# sourceMappingURL=episodic-consolidator.js.map