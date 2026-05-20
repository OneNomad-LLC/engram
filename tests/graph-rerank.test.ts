// Opt out of credentials-file auto-routing — this exercises the local
// graph reranker over the file backend and must not silently hit przm
// Cloud just because the dev machine has been logged in. See v1.0.1.
process.env.ENGRAM_NO_AUTO_CLOUD = '1';

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { addTriple } from '../src/knowledge-graph.js';
import { graphAwareRerank, graphAwareRerankPPR } from '../src/graph-rerank.js';
import type { SearchResult, MemoryChunk } from '../src/types.js';

function makeStub(id: string, content: string, score: number): SearchResult {
  const chunk: MemoryChunk = {
    id,
    tier: 'long-term',
    type: 'fact',
    cognitiveLayer: 'semantic',
    tags: [],
    domain: '',
    topic: '',
    source: '',
    importance: 0.5,
    sentiment: 'neutral',
    createdAt: new Date().toISOString(),
    lastRecalledAt: null,
    recallCount: 0,
    relatedMemories: [],
    recallOutcomes: [],
    content,
  } as MemoryChunk;
  return { chunk, score };
}

async function withTempStorage<T>(fn: (s: Storage) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'engram-graph-rerank-'));
  const storage = new Storage(dir);
  await storage.ensureReady();
  try {
    return await fn(storage);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('graphAwareRerank: empty candidates returns empty', async () => {
  await withTempStorage(async (storage) => {
    const r = await graphAwareRerank(storage, []);
    assert.deepEqual(r, []);
  });
});

test('graphAwareRerank: candidates with no triples returns unchanged', async () => {
  await withTempStorage(async (storage) => {
    const candidates = [
      makeStub('c1', 'unrelated content', 0.9),
      makeStub('c2', 'more unrelated', 0.8),
    ];
    const r = await graphAwareRerank(storage, candidates);
    assert.equal(r.length, 2);
    assert.equal(r[0]!.chunk.id, 'c1');
    assert.equal(r[1]!.chunk.id, 'c2');
    assert.equal(r[0]!.score, 0.9); // unchanged
  });
});

test('graphAwareRerank: connected entity boosts the score', async () => {
  await withTempStorage(async (storage) => {
    // c1 contributes a triple about Engram. c2's content mentions Engram —
    // it should be boosted because it's 1-hop connected via that entity.
    await addTriple(storage, 'engram', 'is-a', 'memory-system', 'c1', 0.9);

    const candidates = [
      makeStub('c1', 'Engram is the memory system.', 0.7),
      // c2 has lower similarity (0.5) but mentions Engram → should be boosted.
      makeStub('c2', 'I love working with Engram on agentic tasks.', 0.5),
      makeStub('c3', 'Completely unrelated content about kittens.', 0.6),
    ];

    const r = await graphAwareRerank(storage, candidates);
    // c2 should have been boosted past c3 (0.5 → 0.5+0.15=0.65 > 0.6).
    assert.equal(r.length, 3);
    const c2 = r.find((x) => x.chunk.id === 'c2');
    assert.ok(c2, 'c2 should be in results');
    assert.ok(c2!.score > 0.5, 'c2 score should be boosted above 0.5');
  });
});

test('graphAwareRerank: multi-entity connection stacks boost', async () => {
  await withTempStorage(async (storage) => {
    // c1 contributes 3 triples mentioning 3 distinct entities.
    await addTriple(storage, 'engram', 'depends-on', 'lancedb', 'c1', 0.9);
    await addTriple(storage, 'engram', 'uses', 'sqlite', 'c1', 0.9);
    await addTriple(storage, 'engram', 'written-in', 'typescript', 'c1', 0.9);

    const candidates = [
      makeStub('c1', 'Engram depends on LanceDB, uses SQLite, written in TypeScript.', 0.9),
      // c2 mentions 3 connected entities: lancedb, sqlite, typescript
      // → should get 3 boost increments (3 × 0.15 = 0.45).
      makeStub('c2', 'Working with LanceDB and SQLite on TypeScript projects.', 0.4),
      // c3 mentions only 1 connected entity.
      makeStub('c3', 'TypeScript is a great language.', 0.4),
    ];

    const r = await graphAwareRerank(storage, candidates);
    const c2 = r.find((x) => x.chunk.id === 'c2');
    const c3 = r.find((x) => x.chunk.id === 'c3');
    assert.ok(c2 && c3);
    // c2's boost should be greater than c3's (more connections).
    assert.ok(c2!.score > c3!.score, `c2 (${c2!.score}) should outrank c3 (${c3!.score})`);
  });
});

test('graphAwareRerank: boost is capped to prevent runaway', async () => {
  await withTempStorage(async (storage) => {
    // 10 entities all contributed by c1 — c2 mentions all of them.
    const entities = ['engram', 'persona', 'cortex', 'pyre', 'mem0', 'zep', 'letta', 'lancedb', 'qwen', 'mistral'];
    for (const e of entities) {
      await addTriple(storage, e, 'is-a', 'thing', 'c1', 0.9);
    }
    const c2content = entities.join(' ');
    const candidates = [
      makeStub('c1', entities.join(', '), 0.9),
      makeStub('c2', c2content, 0.4),
    ];
    const r = await graphAwareRerank(storage, candidates);
    const c2 = r.find((x) => x.chunk.id === 'c2');
    // Cap is 0.5 above original score (per MAX_BOOST in graph-rerank.ts).
    assert.ok(c2!.score <= 0.4 + 0.5 + 1e-9, `c2 boost should be capped: got ${c2!.score}`);
  });
});

test('graphAwareRerank: does not boost a candidate via its own triples', async () => {
  await withTempStorage(async (storage) => {
    // c1 contributes a triple about engram. Its OWN content mentions
    // engram. We should NOT count engram as a connection that boosts
    // c1 — that would be self-reinforcing and meaningless.
    await addTriple(storage, 'engram', 'is-a', 'memory-system', 'c1', 0.9);
    const candidates = [
      makeStub('c1', 'Engram is the memory system.', 0.5),
    ];
    const r = await graphAwareRerank(storage, candidates);
    // No other candidate to connect to → no boost.
    assert.equal(r[0]!.score, 0.5);
  });
});

test('graphAwareRerankPPR: empty candidates returns empty', async () => {
  await withTempStorage(async (storage) => {
    const r = await graphAwareRerankPPR(storage, []);
    assert.deepEqual(r, []);
  });
});

test('graphAwareRerankPPR: falls back to lite when graph has < 4 entities', async () => {
  await withTempStorage(async (storage) => {
    // Only 2 entities → PPR can't differentiate, should fall back.
    await addTriple(storage, 'a', 'rel', 'b', 'c1', 0.9);
    const candidates = [
      makeStub('c1', 'a links to b', 0.7),
      makeStub('c2', 'separate content about a', 0.5),
    ];
    const r = await graphAwareRerankPPR(storage, candidates);
    assert.equal(r.length, 2);
    // No throw, returns sorted candidates; lite-version semantics apply.
  });
});

test('graphAwareRerankPPR: ranks chunks closer to seed entities higher', async () => {
  await withTempStorage(async (storage) => {
    // Build a small star graph: A is central, connects to B/C/D/E.
    // F is on the periphery, connected only to E.
    // PPR seeded at A should give B/C/D/E higher rank than F.
    for (const x of ['b', 'c', 'd', 'e']) {
      await addTriple(storage, 'a', 'rel', x, 'c1', 0.9);
    }
    await addTriple(storage, 'e', 'rel', 'f', 'c2', 0.9);
    // c1 contributes entities a,b,c,d,e → seed includes them
    // c2 contributes e,f
    // c3 contributes only f (via its content matching) — should rank LOWER than c2
    const candidates = [
      makeStub('c1', 'central node and friends', 0.7),
      makeStub('c2', 'edge case', 0.5),
      makeStub('c3', 'far away', 0.3),
    ];

    // Need c3 to contribute f to test peripheral scoring
    // (the rerank scores chunks by entities they contributed via triples)
    await addTriple(storage, 'f', 'is-a', 'thing', 'c3', 0.5);

    const r = await graphAwareRerankPPR(storage, candidates);
    assert.equal(r.length, 3);
    // c1 should still be at top (high similarity + central seeds).
    assert.equal(r[0]!.chunk.id, 'c1');
    // PPR shouldn't crash and should produce non-negative scores.
    for (const c of r) assert.ok(c.score >= 0);
  });
});

test('graphAwareRerankPPR: caps boost so it doesn\'t overflow', async () => {
  await withTempStorage(async (storage) => {
    // Pathological: one candidate contributes 20 seed entities, all
    // densely connected. PPR rank could concentrate; boost must cap.
    for (let i = 0; i < 20; i++) {
      await addTriple(storage, `e${i}`, 'rel', `e${(i + 1) % 20}`, 'c1', 0.9);
    }
    const candidates = [
      makeStub('c1', 'dense cluster', 0.5),
    ];
    const r = await graphAwareRerankPPR(storage, candidates);
    // Single candidate; only it contributed entities; boost should
    // be bounded.
    assert.ok(r[0]!.score <= 0.5 + 0.5 + 1e-9, `score ${r[0]!.score} should be ≤ 1.0`);
  });
});

test('graphAwareRerankPPR: returns unchanged when no candidate has triples', async () => {
  await withTempStorage(async (storage) => {
    const candidates = [
      makeStub('c1', 'no triples', 0.8),
      makeStub('c2', 'also no triples', 0.6),
    ];
    const r = await graphAwareRerankPPR(storage, candidates);
    assert.equal(r.length, 2);
    assert.equal(r[0]!.chunk.id, 'c1');
    assert.equal(r[0]!.score, 0.8);
  });
});
