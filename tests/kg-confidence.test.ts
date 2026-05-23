/**
 * kg-confidence — R-002 + R-004 regression tests.
 *
 * R-002: confidence is stored and round-tripped through the storage layer,
 *        not silently clamped to 0.5 on read.
 *
 * R-004: duplicate active triples (same subject/predicate/object) are
 *        prevented.  File backend prevents them via the app-level
 *        check-then-insert in addTriple().  Postgres backend prevents
 *        them at the DB level via the partial UNIQUE index.
 *
 * File backend:    always runs (no network dependency).
 * Postgres backend: gated on SMOKE_POSTGRES_URL.
 *
 * Run: `npm test` or `node --import tsx --test tests/kg-confidence.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from '../src/storage.js';
import { addTriple } from '../src/knowledge-graph.js';
import type { StorageAdapter } from '../src/storage-adapter.js';
import type { KnowledgeTriple } from '../src/types.js';

// ── File backend — integration through addTriple() ──────────────────

describe('kg-confidence — file backend', () => {
  it('confidence round-trips and sequential duplicate triples are prevented', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-kg-conf-file-'));
    try {
      // Storage(dataDir) uses file adapter by default.
      const storage = new Storage(dir);
      await storage.ensureReady();

      // ── R-002: addTriple respects and returns the supplied confidence ──
      const t1 = await addTriple(storage, 'Alice', 'knows', 'Bob', 'test', 0.8);
      assert.equal(t1.confidence, 0.8, 'first addTriple should return supplied confidence');

      // Read back via queryTriples — confidence must be persisted, not hardcoded
      const fetched = await storage.queryTriples({ subject: 'Alice', predicate: 'knows', activeOnly: true });
      const fromStore = fetched.find((t) => t.object === 'Bob');
      assert.ok(fromStore, 'triple should be queryable after addTriple');
      assert.equal(fromStore.confidence, 0.8, 'persisted confidence must match, not hardcoded 0.5');

      // ── R-004: second addTriple on same SPO bumps confidence; no duplicate ──
      const t2 = await addTriple(storage, 'Alice', 'knows', 'Bob', 'test');
      assert.ok(
        t2.confidence > 0.8,
        `second addTriple should bump confidence above 0.8; got ${t2.confidence}`,
      );

      const afterSecond = await storage.queryTriples({
        subject: 'Alice',
        predicate: 'knows',
        activeOnly: true,
      });
      const active = afterSecond.filter((t) => t.object === 'Bob');
      assert.equal(
        active.length,
        1,
        `expected exactly 1 active Alice-knows-Bob triple; got ${active.length}`,
      );
      assert.ok(
        active[0].confidence > 0.8,
        `the surviving triple should have bumped confidence; got ${active[0].confidence}`,
      );
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

// ── Postgres backend — adapter-level tests (gated on SMOKE_POSTGRES_URL) ──

const POSTGRES_URL = process.env.SMOKE_POSTGRES_URL;

async function runPgConfidenceTests(adapter: StorageAdapter): Promise<void> {
  await adapter.ensureReady();

  const now = new Date().toISOString();

  // ── R-002: confidence is stored in the column, not hardcoded 0.5 ────
  const triple: KnowledgeTriple = {
    id: randomUUID(),
    subject: 'Carol',
    predicate: 'works-at',
    object: 'Acme',
    source: 'kg-confidence-test',
    confidence: 0.75,
    validFrom: now,
    validTo: null,
    createdAt: now,
  };
  await adapter.saveTriple(triple);

  const fetched = await adapter.queryTriples({
    subject: 'Carol',
    predicate: 'works-at',
    activeOnly: true,
  });
  const fromDb = fetched.find((t) => t.object === 'Acme');
  assert.ok(fromDb, 'triple should be queryable after saveTriple');
  assert.equal(
    fromDb.confidence,
    0.75,
    `confidence must be read from the DB column (got ${fromDb.confidence}), not hardcoded to 0.5`,
  );

  // ── R-004: second saveTriple with different ID but same active SPO ──
  //   — the UNIQUE partial index must prevent a duplicate active row.
  //   saveTriple uses ON CONFLICT DO NOTHING + UPDATE, so the second
  //   call must (a) not create a new row and (b) bump confidence.
  const triple2: KnowledgeTriple = {
    ...triple,
    id: randomUUID(), // different UUID
    confidence: 0.5,  // would reset to 0.5 if not handled by constraint
  };
  await adapter.saveTriple(triple2);

  const afterSecond = await adapter.queryTriples({
    subject: 'Carol',
    predicate: 'works-at',
    activeOnly: true,
  });
  const active = afterSecond.filter((t) => t.object === 'Acme');
  assert.equal(
    active.length,
    1,
    `UNIQUE index should prevent duplicate active triples; got ${active.length}`,
  );
  assert.ok(
    active[0].confidence > 0.75,
    `confidence should be bumped by ON CONFLICT UPDATE; got ${active[0].confidence}`,
  );
}

describe('kg-confidence — postgres backend', () => {
  it(
    'confidence column is persisted; UNIQUE index blocks duplicate active triples',
    { skip: !POSTGRES_URL && 'SMOKE_POSTGRES_URL not set; skipping postgres backend' },
    async () => {
      const { PostgresStorageAdapter } = await import('../src/storage-postgres.js');
      const tenantId = `kg-conf-${randomUUID()}`;
      const adapter = new PostgresStorageAdapter({
        databaseUrl: POSTGRES_URL!,
        tenantId,
      });
      try {
        await runPgConfidenceTests(adapter);
      } finally {
        try { await adapter.close?.(); } catch { /* noop */ }
      }
    },
  );
});
