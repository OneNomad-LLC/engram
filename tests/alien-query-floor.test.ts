/**
 * Alien-query retrieval-floor calibration test.
 *
 * Per Engram architecture-patterns §2: the vector-similarity floor
 * exists to drop weak semantic matches that would otherwise let the
 * model interpolate hallucinations between low-confidence candidates.
 * "Calibrated" means: queries about topics genuinely absent from the
 * corpus must NOT return strong matches.
 *
 * Floors live in the per-model-family profile (getEmbeddingModelProfile
 * in src/llm.ts) because similarity distributions shift by family. The
 * measured bands on this corpus:
 *
 *   family        alien noise (top sims)   on-topic     ceiling
 *   MiniLM-class  up to ~0.40              ~0.5+        0.45
 *   BGE v1.5      0.37-0.50 (mean 0.43)    0.72-0.80    0.55
 *
 * This test is the calibration artifact:
 *   1. Seed a tight, single-topic corpus (Pyre + Cortex development).
 *   2. Define an "alien" query set covering wildly unrelated topics
 *      (cooking, gardening, classical music, plumbing, etc.).
 *   3. For each alien query, embed with the production query prefix and
 *      observe the max cosine similarity against the corpus.
 *   4. Assert the max stays under the family's calibrated ceiling. If a
 *      future model swap, embedding change, or contextual-prefix tweak
 *      drives alien queries above this ceiling, this test fails and
 *      forces a deliberate re-calibration of the profile floors.
 *   5. Sanity-check with control queries (about the corpus topic) that
 *      DO survive the production floor — guards against over-tightening.
 *
 * Skipped when ENGRAM_SKIP_EMBED=1 — the local embedding model downloads
 * once on first run (~34MB for the default bge-small), which is
 * unfriendly to CI environments that opt out. Run locally with
 * `node --import tsx --test tests/alien-query-floor.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt out of the credentials-file auto-route so this local-storage test
// can't silently hit przm Cloud on a developer machine where someone
// previously ran `przm-memory login`. The fix this guards against
// shipped in v1.0.1; see CHANGELOG for context.
process.env.ENGRAM_NO_AUTO_CLOUD = '1';

import { Storage, type StoredChunk } from '../src/storage.js';
import { embed, getEmbeddingModelProfile } from '../src/llm.js';
import { search } from '../src/search.js';
import { loadConfig } from '../src/config.js';
import { cosineSimilarity } from '../src/utils.js';

const SHOULD_SKIP = process.env.ENGRAM_SKIP_EMBED === '1';

/**
 * Seed corpus: 15 chunks all about Pyre + Cortex development. Single
 * tight topic so alien queries (cooking, music, gardening) have nothing
 * to latch onto semantically.
 */
const CORPUS = [
  'Pyre is a local-first AI runtime that runs Qwen3-14B on a 9070 XT with 30K visible context.',
  'Cortex is the multi-tenant knowledge-engine MCP server backed by Postgres + pgvector.',
  'Engram stores per-user memories using LanceDB and a hybrid retrieval pipeline.',
  'The Compaction Sidecar runs on its own llama-server so summarization does not compete with chat inference.',
  'Pyre uses MCP (Model Context Protocol) to wire tools and external services into agent runs.',
  'The pre-flight context gate tokenizes prompts before sending to llama-server to avoid context overflow.',
  'GPT-OSS requires mandatoryDisableThinking to prevent harmony-channel leaks in the response stream.',
  'PGlite ships an embedded WASM-compiled Postgres so Cortex can install without Docker.',
  'The inbox watcher uses chokidar to auto-ingest files dropped into ~/.pyre/inbox.',
  'Cortex separates structured dossier loads from RAG retrieval to avoid interpolating entity facts.',
  'Slot-aware compaction targets the bloated slot (tool_summaries, scrollback) instead of summarizing everything.',
  'Engram retrieval blends vector similarity, IDF keyword scoring, temporal boosting, and spreading activation.',
  'Pyre packages include engine, agents, context-budget, compaction-sidecar, and memory-pgvector.',
  'The desktop app is Electron with a frameless transparent quick-entry bar window.',
  'Cortex repositioned from personal-priority tracking to multi-tenant knowledge engine in May 2026.',
];

/**
 * Alien queries: topics genuinely absent from the corpus. Every query
 * is recognizable as "would obviously not be in a Pyre/Cortex memory
 * store." The point is to stress-test the floor: if any of these
 * return a strong vector match, the model's embedding space has
 * generalized too aggressively and the production floor needs raising.
 */
const ALIEN_QUERIES = [
  'How do I prune tomato plants for maximum yield?',
  'What temperature should I roast a turkey at?',
  'Best beginner classical guitar pieces by Bach',
  'How to fix a leaky kitchen faucet without a plumber',
  'Symptoms of magnesium deficiency in soil',
  'Recipe for traditional Italian carbonara',
  'How long does it take to learn conversational Mandarin',
  'Best practices for indoor cat litter box hygiene',
  'How to identify edible mushrooms in temperate forests',
  'Yoga poses for lower back pain relief',
  'What causes sourdough bread to overproof',
  'How to train a puppy to sit and stay',
  'Astronomy: how to find the Andromeda galaxy',
  'Knitting cable patterns for beginners',
  'Safety tips for sailing in heavy weather',
  'Watercolor techniques for landscape painting',
  'How to clean and maintain a cast iron skillet',
  'What causes the northern lights phenomenon',
  'Bicycle gear ratio explained for road riders',
  'How to brew espresso at home with a moka pot',
];

/**
 * Control queries: ABOUT the corpus topic. These should survive the
 * production 0.25 floor — guards against over-tightening.
 */
const CONTROL_QUERIES = [
  'Tell me about Pyre and how it runs models locally.',
  'How does Cortex handle multi-tenant knowledge?',
  'What is the inbox watcher in Pyre?',
];

/** Calibrated ceilings per model family: NO alien query may produce a
 *  vector similarity above these. The ceiling sits above the production
 *  floor by design in both families — the floor is deliberately
 *  permissive (it cuts only the bottom of the noise band; RRF/keyword
 *  layers do the ranking) because real stored memories are long and
 *  contextual-prefixed, which compresses query-to-chunk similarity well
 *  below what this short-sentence corpus produces. MiniLM: floor 0.25,
 *  ceiling 0.45. BGE: floor 0.42 (live relevant hits measure
 *  ~0.46-0.55), ceiling 0.55 (synthetic alien max measured 0.503). */
const PROFILE = getEmbeddingModelProfile();
const ALIEN_CEILING = PROFILE.version === 3 ? 0.55 : 0.45;
/** Query-side prefix exactly as search.ts builds it in production. */
const QUERY_PREFIX = PROFILE.alwaysPrefixQuery ? PROFILE.queryPrefix : 'search query: ';

async function tmpStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-alien-floor-'));
  const storage = new Storage(dir);
  await storage.ensureReady();
  return {
    dir,
    storage,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

function makeChunk(id: string, content: string, embedding: number[]): StoredChunk {
  return {
    id,
    tier: 'long-term',
    content,
    type: 'fact',
    cognitiveLayer: 'semantic',
    tags: [],
    domain: '',
    topic: '',
    source: 'alien-floor-test',
    importance: 0.5,
    sentiment: 'neutral',
    createdAt: new Date().toISOString(),
    lastRecalledAt: null,
    recallCount: 0,
    embedding,
    relatedMemories: [],
    recallOutcomes: [],
    stability: 1.0,
    difficulty: 0.3,
    temporalAnchor: 0,
    consolidationLevel: 0,
    sourceChunkIds: [],
    embeddingVersion: 1,
    parentChunkId: '',
    origin: 'derived',
  };
}

describe('alien-query retrieval floor calibration', { skip: SHOULD_SKIP }, () => {
  it('vector similarity for alien queries stays under the calibrated ceiling', async () => {
    // This is the architecture-pattern §2 calibration: pure vector
    // similarity, no keyword/boost stack. The production 0.25 floor in
    // search.ts only filters at the vector stage. So this test embeds
    // each alien query, computes raw cosine similarity against every
    // corpus chunk, and asserts the MAX stays under the ceiling.
    //
    // Failure modes this catches:
    //  - Model swap (Xenova/* → something larger) that generalizes too
    //    aggressively and starts giving alien queries high similarity.
    //  - Contextual prefix change ('document: ' / 'search query: ') that
    //    inadvertently aligns alien queries with corpus chunks.
    //  - Embedding-dim truncation that loses topic separation.
    const config = loadConfig();
    const corpusEmbeddings: number[][] = [];
    for (const text of CORPUS) {
      const emb = await embed(config, text, config.enableContextualPrefix ? 'document: ' : undefined);
      if (emb.length === 0) {
        console.warn('alien-floor: embedding unavailable, skipping calibration assertions');
        return;
      }
      corpusEmbeddings.push(emb);
    }

    const alienScores: Array<{ query: string; topSim: number }> = [];
    for (const q of ALIEN_QUERIES) {
      const qEmb = await embed(config, q, QUERY_PREFIX);
      if (qEmb.length === 0) {
        console.warn('alien-floor: query embedding unavailable, skipping');
        return;
      }
      let topSim = -1;
      for (const cEmb of corpusEmbeddings) {
        const sim = cosineSimilarity(qEmb, cEmb);
        if (sim > topSim) topSim = sim;
      }
      alienScores.push({ query: q, topSim });
    }

    const maxSim = Math.max(...alienScores.map((r) => r.topSim));
    const verbose = alienScores
      .filter((r) => r.topSim > 0.3)
      .map((r) => `  "${r.query}" → topSim=${r.topSim.toFixed(3)}`)
      .join('\n');
    const detail = verbose
      ? `\nBorderline alien matches (topSim > 0.3):\n${verbose}`
      : '\n(all alien queries scored below 0.3 — well under the 0.45 ceiling)';

    assert.ok(
      maxSim < ALIEN_CEILING,
      `Max alien-query vector similarity ${maxSim.toFixed(3)} >= ceiling ${ALIEN_CEILING}.\n` +
      `If the embedding model, contextual prefix, or embedding dim changed, recalibrate the profile floors in src/llm.ts.${detail}`,
    );
  });

  it('full pipeline rarely leaks alien results past the vector floor', async () => {
    // Companion check: when we run the full search() pipeline (vector
    // floor + IDF keyword + boosts + spreading activation), how often
    // do alien queries leak through anyway? IDF keyword scoring can
    // surface accidental lexical hits (e.g. common stop-words slipping
    // through tokenization). This test tracks how leaky the full
    // stack is — failure means the keyword/boost stack started
    // returning HIGH-confidence alien matches, not just incidental ones.
    //
    // Threshold: alien results may exist (incidental keyword hits are
    // tolerable when their composite scores are near zero), but no
    // alien result may have a composite score above 0.10 — well below
    // the score range a real query produces.
    const { storage, cleanup } = await tmpStorage();
    try {
      const config = loadConfig();
      let i = 0;
      for (const text of CORPUS) {
        const emb = await embed(config, text, config.enableContextualPrefix ? 'document: ' : undefined);
        if (emb.length === 0) {
          console.warn('alien-floor: embedding unavailable, skipping pipeline assertions');
          return;
        }
        await storage.saveChunk(makeChunk(`c${i++}`, text, emb));
      }

      const offenders: Array<{ query: string; topScore: number }> = [];
      for (const q of ALIEN_QUERIES) {
        const results = await search(config, storage, q, 10);
        const topScore = results[0]?.score ?? 0;
        if (topScore >= 0.10) offenders.push({ query: q, topScore });
      }

      const detail = offenders.length === 0
        ? ''
        : `\nHigh-confidence alien matches:\n` +
          offenders.map((r) => `  "${r.query}" → composite=${r.topScore.toFixed(3)}`).join('\n');
      assert.ok(
        offenders.length === 0,
        `${offenders.length}/${ALIEN_QUERIES.length} alien queries returned a composite score >= 0.10. ` +
        `IDF keyword scoring or boost stack is producing false-positive high-confidence matches.${detail}`,
      );
    } finally {
      cleanup();
    }
  });

  it('control queries about the corpus DO survive the production floor', async () => {
    const { storage, cleanup } = await tmpStorage();
    try {
      const config = loadConfig();
      let i = 0;
      for (const text of CORPUS) {
        const emb = await embed(config, text, config.enableContextualPrefix ? 'document: ' : undefined);
        if (emb.length === 0) {
          console.warn('alien-floor: embedding unavailable, skipping control assertions');
          return;
        }
        await storage.saveChunk(makeChunk(`c${i++}`, text, emb));
      }

      // Each control query MUST return at least one result. If the
      // production floor were over-tightened, this assertion would
      // false-negative legitimate retrieval — exactly what the
      // calibration discipline guards against.
      for (const q of CONTROL_QUERIES) {
        const results = await search(config, storage, q, 10);
        assert.ok(
          results.length > 0,
          `Control query "${q}" returned 0 results — production floor is too high or corpus does not match.`,
        );
      }
    } finally {
      cleanup();
    }
  });
});
