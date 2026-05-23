# Roadmap

Ordered work derived from the May 2026 cross-cutting audit
(`/tmp/research/przm-memory/REPORT.md` and the four section reports under
the same directory). Each item is sized so it can become a single PR.
The "Why" line is the load-bearing rationale; the "Revisit if" line is
when this item should be deferred or skipped.

This file is forward-looking. The backward-looking record of choices
already made and deliberately deferred lives in `ARCHITECTURE_DEBT.md`;
items closed out here graduate to that ledger as resolved entries.

---

## P0 — ship this week

These are bugs, not features. Two of them block any credible cloud
launch; the third is undermining the product's user-facing surface today.

### R-001 — Fix the engram → przm naming drift across docs, skills, hooks, and runtime strings

**Where:** `README.md:458-525` (Tools table), all seven
`skills/*/SKILL.md` files, `hooks/engram_stop_hook.sh`,
`hooks/engram_precompact_hook.sh`, `src/context-pressure.ts:28-58`
(action-plan strings returned to the LLM), `SKILL.md:1-6`,
`install-commands.sh`.

**Why:** `src/server.ts:111+` registers tools as `memory-*` but every
piece of documentation an LLM reads at session start still says
`engram-*`. A fresh agent following the README or any skill file calls
tools that don't exist. The action-plan strings returned by
`memory-context-pressure` themselves contain `engram-ingest` and
`engram-handoff-write`, which the receiving LLM dutifully tries to
call. This is the highest user-visible defect in the project.

**Approach:** Either rename every doc/skill/hook/string to `memory-*`,
or register both names as aliases in `src/server.ts` (lower-risk
rollback path). Aliasing is the recommended approach because it
unblocks existing installations that have hardcoded the old names.

**Effort:** S.

**Revisit if:** never — this is launch-blocking.

---

### R-002 — Fix KG confidence loss in Postgres

**Where:** `src/storage-postgres.ts:660` (`pgRowToTriple` hardcodes
`confidence: 0.5`); `migrations/postgres/001_init.sql:48-52`
(`knowledge_triples` table has no `confidence` column);
`src/knowledge-graph.ts:28-44` (`addTriple` writes confidence into
nothing).

**Why:** Every cloud / Postgres user runs a KG with uniformly-weighted
edges, regardless of how many times a triple has been reinforced. The
"confidence grows with evidence" design claim is a no-op on
Postgres. Spreading activation, graph rerank, and KG-temporal lookup
all weight by confidence — all three are broken for Postgres users.

**Approach:** Add a `003_kg_confidence.sql` migration with
`ALTER TABLE knowledge_triples ADD COLUMN confidence REAL NOT NULL
DEFAULT 0.5`. Update `saveTriple` to write it. Update `pgRowToTriple`
to read it.

**Effort:** XS.

**Revisit if:** never — blocks the prosumer / hosted launch (R-016).

---

### R-003 — Stop episodic L1 summaries duplicating on every consolidation

**Where:** `src/episodic-consolidator.ts:103` — sets
`consolidationLevel: 0` on source chunks after summarizing them.

**Why:** The filter at `consolidateEpisodic` selects candidates with
`consolidationLevel === 0`. After running once, source chunks remain
at level 0, so the next `memory-maintain` run produces another L1
summary for the same cluster. Repeated runs accumulate duplicate
summaries that the near-duplicate merge pass only sometimes catches.

**Approach:** One-line change: set `consolidationLevel: 1` instead of
`0` after summarizing.

**Effort:** XS.

**Revisit if:** never.

---

### R-004 — Add UNIQUE constraint on active KG triples in Postgres

**Where:** new `migrations/postgres/003_*.sql`.

**Why:** `addTriple` does a check-then-insert (`queryTriples` followed
by conditional `INSERT`). Two concurrent ingests of the same content
both pass the check and produce duplicate active triples. LanceDB is
single-writer so the race doesn't exist there; Postgres needs the
constraint.

**Approach:**
```sql
CREATE UNIQUE INDEX knowledge_triples_active_spo_idx
  ON knowledge_triples (tenant_id, subject, predicate, object)
  WHERE invalidated_at IS NULL;
```
Change the INSERT to `ON CONFLICT DO NOTHING` then a separate UPDATE
for confidence reinforcement.

**Effort:** S.

**Revisit if:** never — race is real under concurrent agents on
Postgres.

---

### R-005 — Default Postgres SSL

**Where:** `src/storage-postgres.ts:85-88`.

**Why:** `new Pool({ connectionString, max })` doesn't set `ssl`. Cloud
Postgres (Supabase, Neon, Heroku, RDS) typically requires
`sslmode=require`. Users who don't know to append it get connection
errors; users whose `DATABASE_URL` includes the flag but whose driver
doesn't pick it up correctly get plaintext connections.

**Approach:**
```ts
new Pool({
  connectionString,
  max,
  ssl: connectionString.includes('localhost')
    ? false
    : { rejectUnauthorized: true },
})
```
Document an `ENGRAM_PG_SSL=off` opt-out for local dev.

**Effort:** XS.

**Revisit if:** never.

---

## P1 — ship this quarter

Items that are not bugs but are gating either performance, the
prosumer launch, or the credibility of the benchmark numbers.

### R-006 — Replace `updateChunk` N+1 in Postgres with a real partial UPDATE

**Where:** `src/storage-postgres.ts:252-263`.

**Why:** Every update is a `getChunk` + `saveChunk` (full row
read-then-write). Consolidation loops call this inside O(n²) inner
passes. At 10k chunks, a consolidation run can issue 20k+ Postgres
round-trips for what should be one UPDATE per chunk. This is the
single biggest performance cliff for any Postgres / cloud user.

**Approach:** Replace with a partial UPDATE:
```sql
UPDATE chunks
   SET metadata = metadata || $2::jsonb
 WHERE tenant_id = $1 AND id = $3
```
Add `updateChunks(updates: Array<{id, patch}>)` to the adapter
interface with a batched implementation in Postgres (unnest + CASE WHEN)
so the consolidation loops can pipeline.

**Effort:** M.

**Revisit if:** the prosumer launch decides to ship file-only
(unlikely — see R-016).

---

### R-007 — Drop CSV-string params, use arrays

**Where:** `src/server.ts:280` (`memory-ingest.tags`),
`src/server.ts:572` (`memory-outcome.chunkIds`),
`src/server.ts:1005-1009` (`memory-handoff-write.completed /
nextSteps / openQuestions / fileRefs / decisions`).

**Why:** Six locations where the schema takes a `z.string()` and the
handler comma-splits. An LLM that puts a comma in a `fileRefs` path or
a `decisions` text silently corrupts the field. Removes a class of
silent corruption; matches JSON-Schema norms LLM callers expect.

**Approach:** Change to `z.array(z.string())` throughout. Remove the
`splitCsv` helpers. Update tool descriptions to drop the
"comma-separated" hint.

**Effort:** S.

**Revisit if:** never.

---

### R-008 — Trim server `instructions` block; pull `memory-context-pressure` out of mandatory flow

**Where:** `src/server.ts:86-103` (the McpServer `instructions`
payload), `src/context-pressure.ts:28-58` (return strings).

**Why:** 600+ characters of MANDATORY-shouty protocol binds the LLM to
a 6-step handoff dance every session, assumes Claude Code (mentions
`/compact`), and primes hypervigilance. It overlaps with the
autonomous stop-hook that does the same job server-side. The
`memory-context-pressure` tool itself is honor-system telemetry —
the LLM self-reports a 4-level scale with no grounding signal.

**Approach:** Shrink the `instructions` block to three declarative
lines describing what the server does. Move trigger-language ("call
before answering about prior work", etc.) into per-tool descriptions
where it's contextual. Derive `memory-context-pressure` level
server-side from the transcript the stop hook already reads; keep
the LLM-driven tool for manual override only, gated on an optional
`tokensEstimate` parameter when called.

**Effort:** S.

**Revisit if:** post-rename (R-001) someone wants to relitigate the
prescriptiveness question.

---

### R-009 — Strip benchmark-only knobs off `memory-ingest`

**Where:** `src/server.ts:291-293` (`skipKgExtraction`,
`skipDailyEntry`, `awaitSideEffects`).

**Why:** Documented in-schema as "benchmark harnesses only." Shipping
them on the production tool surface costs tokens (every LLM reads the
descriptions), invites misuse, and confuses tool selection. Keep them
on the library API only (`src/index.ts`).

**Approach:** Remove from MCP server registration. Leave the
underlying handler args; just don't expose them on the schema.

**Effort:** XS.

**Revisit if:** the benchmark harness moves out of process and needs
to drive ingestion through the MCP surface (we'd add a separate
benchmark tool, not re-expose these).

---

### R-010 — Bench a cross-encoder reranker on top-30

**Where:** `src/reranker.ts:46-72` (stub for
`Xenova/ms-marco-MiniLM-L-6-v2`).

**Why:** DEBT-009 (`ARCHITECTURE_DEBT.md`) concluded "no reranker"
based on a test of `selectRelevant()` — a listwise LLM reranker
calling Haiku with 200-character truncated docs. That's a different
cost class from cross-encoder reranking (~50ms CPU per top-30 vs
~2000ms LLM). NDCG@10 = 0.875 with R@10 = 0.988 on LongMemEval is
exactly the "found but not first" failure shape that cross-encoders
fix. Predicted lift: +5 to +10pp on LoCoMo temporal-inference (74.0%
R@10 today). Total p50 latency goes from 44ms → ~100ms.

**Approach:** Wire the stub to use `bge-reranker-v2-m3` or
`mxbai-rerank-large-v1`. Rerank top-30 after candidate scoring. Bench
against the held-out set. Reopen DEBT-009 with the cross-encoder
result.

**Effort:** M.

**Revisit if:** the bench actually shows no lift (then DEBT-009's
update should explicitly cite "cross-encoder reranking also tested,
no improvement" with the test details).

---

### R-011 — Swap MiniLM-L6-v2 → bge-small-en-v1.5

**Where:** `src/storage.ts` (embedding model reference), and
config / utils for the contextual prefix.

**Why:** Same 384-dim, same ONNX runtime, same DB schema. MTEB
retrieval avg ~51.7 vs MiniLM's ~41.9. The drop-in upgrade with the
highest expected lift / lowest schema risk in the project.

**Approach:** Update the model path. Audit and update the
`buildContextPrefix` in `src/utils.ts:77-108` (or remove it; BGE-small
uses empty prefix). Run a full corpus re-embed pass. Verify the
similarity floor at `src/search.ts:120` still calibrates correctly
against the alien-query floor test.

**Effort:** M (mostly the re-embed and prefix audit).

**Revisit if:** the floor calibration fails and we'd need to retune
multiple thresholds — punt to the model-abstraction work
(DEBT-008).

---

### R-012 — Add a tuned-BM25 baseline + 3-dataset BEIR OOD benchmark

**Where:** new files under `benchmarks/`.

**Why:** Until you know what a strong sparse baseline does on the
same data, the dense+graph+spreading apparatus's value-add is
literally unmeasured. The README's "no benchmark-specific tuning"
claim cannot be verified without OOD evidence — meanwhile at least
five LoCoMo-tuned constants exist in the pipeline.

**Approach:** Wire `bm25` (npm) or call Pyserini in the bench harness.
Run on LoCoMo R@10 and three BEIR datasets (TREC-COVID, SCIDOCS,
FiQA). Commit results to `benchmarks/results/published/`. If
tuned-BM25 hits within 5pp of przm on LoCoMo, the README's framing
needs to soften to "tuned against LoCoMo and LongMemEval; OOD
performance measured below."

**Effort:** M (annotation-free; mostly harness work).

**Revisit if:** never — this is a launch gate for any new
methodology claim, not optional.

---

### R-013 — Wire HippoRAG PPR into search.ts (or delete `graph-rerank.ts`)

**Where:** `src/graph-rerank.ts:175-298` (full PPR implementation,
unwired); `src/graph-rerank.ts` 1-hop lite variant
(`graphAwareRerank`, also unwired); `src/search.ts` integration
point.

**Why:** Dead code that implies a shipped feature. Current state is
the worst: cognitive overhead in the codebase, the competitive audit
claims "przm has absorbed the HippoRAG lesson" when in fact the
lesson isn't running in production. Either wire it (predicted +2-5pp
on multi-hop questions) or delete it (removes a false implied claim).

**Approach:** Add a `graphRerank: 'off' | 'lite' | 'ppr'` option to
`memory-search`. Wire after candidate scoring, before the token
budget cap. Bench against existing benchmark suite plus the OOD set
from R-012. If results don't justify keeping it, delete the file.

**Effort:** S (wire) or XS (delete).

**Revisit if:** the bench is ambiguous; deletion is always available
as the fallback.

---

## P2 — ship this year

Larger items, mostly gated on the P0/P1 work landing first.

### R-014 — Multi-tenancy + RLS + audit log bundle (DEBT-001 + 005 + 006 + 007)

Postgres RLS keyed on `current_setting('app.user_id')`. Write-time KG
edge isolation validator (DEBT-006). Audit table with trace IDs
linking back to MCP calls (DEBT-007). Approval / lifecycle workflow
for regulated verticals (DEBT-005). Pattern-share with Cortex.

**Effort:** L-XL as a bundle.

**Gates:** R-016 (prosumer tier) and any regulated-vertical deal.

---

### R-015 — Ship a Vercel AI SDK provider

`@onenomad/przm-memory-ai-sdk` targeting PR
[#11861](https://github.com/vercel/ai/pull/11861)'s `MemoryAdapter`
interface. Mem0 and Letta already ship providers — whichever memory
backend ships the popular adapter wins default-status for
Next.js / Vercel-hosted agents.

**Effort:** S (~3-5 days; the interface is small).

**Why it's not P1:** strategic, not gating. Move it earlier if Mem0
or Letta announces a Next.js integration push.

---

### R-016 — Hosted prosumer tier

$9-15/mo, single-user, multi-device sync. Cuts off Mem0's
Hobby → Starter funnel. Gated on R-014 closing for safety.

**Effort:** M as product work once the platform is ready.

---

### R-017 — HTTP MCP transport + minimal REST API

MemMachine ships both stdio and HTTP MCP; przm-memory is
stdio-only. The Cortex repo has an auth-token pattern
(`PRZM_CORTEX_MCP_AUTH_TOKEN`) — extract a shared transport layer.
Unblocks web embedding and the prosumer tier.

**Effort:** M.

---

### R-018 — Publish a memory-benchmark methodology standard

A blog post / methodology spec: "How to compare AI memory systems
honestly." Side-by-side LoCoMo R@10 vs LLM-judge with the
methodology caveats spelled out. Force competitors to disclose their
grading prompts and dropped categories. Get one independent
third-party (Vectorize.io or OSS Insight) to validate the R@K
table. This converts existing engineering work into market
position.

**Effort:** M (writing + outreach; no new code).

**Gates:** R-010, R-011, R-012 results should be in hand first so the
post can include the strongest possible numbers.

---

### R-019 — Autonomous local consolidation daemon ("Dreaming")

Background scheduler running `memory-maintain` +
adaptive-forgetting recalculation + diary insights surfacing.
Counters Anthropic's Claude Dreaming (May 6, 2026) with the
no-API-cost local version.

**Effort:** M.

---

### R-020 — Replace `translateFilter` with typed filter parameters

**Where:** `src/storage-postgres.ts:592-598`.

Regex string substitution on SQL fragments is structurally fragile.
Currently safe because the filter strings are constructed from a
small fixed set of predicates in `search.ts`, but the coupling means
any new filter that contains the substring `tier`, `domain`,
`topic`, or `cognitive_layer` in a string literal silently corrupts
the WHERE clause. Replace with explicit boolean params on
`vectorSearch` (`excludeArchived`, `excludeParentContainers`, etc.).

**Effort:** S.

---

## Backlog (low-priority cleanups)

These are real and tracked but not load-bearing. Address opportunistically
or bundle into a "tidy week."

- Replace IDF-weighted bag-of-words with real BM25
  (`src/search.ts:160-211, 512-559`). Small absolute gain (+1-2pp on
  rare-term queries) but removes a "your hybrid isn't actually using
  BM25" honesty issue.
- Bounded `listChunks` and aggregate-query `getTaxonomy`
  (`src/storage-postgres.ts:243-249, 302-312`). Unbounded full table
  scans break at scale. Switch to native
  `SELECT domain, metadata->>'topic', COUNT(*) FROM chunks GROUP BY 1, 2`.
- Canonical predicate vocabulary in KG (`src/kg-extractor.ts`,
  `src/knowledge-graph.ts:49`). Predicates are free-text after
  `.toLowerCase()`. Define a closed enum so `memory-kg-query`
  queries are reliable.
- Persistent source dedup cache or document the limitation
  (`src/wal.ts:168-198`). In-memory only; restart loses it.
- LanceDB schema migration runner (`src/storage-file.ts:77-79`).
  Ad-hoc inline try/catch. Mirror the Postgres migration pattern.
- Embedding version check on cross-chunk comparisons
  (`src/consolidator.ts`). `embeddingVersion` is stored but never
  read defensively. Fires the moment DEBT-008 closes.
- Unify `HandoffNote.name` between filesystem and adapter types
  (`src/storage-adapter.ts:37-48` vs `src/handoff.ts:21`).
- Pin the `pg` driver in regular `dependencies` with version range,
  add `@types/pg` (`package.json`, `src/storage-postgres.ts:41-44`).
- Merge `memory-budget` into `memory-search` with optional
  `budgetTokens` (`src/server.ts:190-269`).
- Make `memory-extract.messages` a real array, not a JSON-encoded
  string (`src/server.ts:461-526`).
- Restructure `memory-ingest` duplicate response to include
  `recommendation` + `nextAction` fields
  (`src/server.ts:301-315`).
- Namespace persona coupling. `memory-search.cognitiveLoad`,
  `memory-ingest.sentiment/emotionalValence/emotionalArousal` →
  `persona: {...}` (`src/server.ts`).
- Episodic clustering determinism. Sort candidates by `createdAt`
  before greedy clustering (`src/episodic-consolidator.ts:127-151`).
- Backup tooling for LanceDB. Add a `przm-memory-backup` CLI.
- Update WAL filename / comment alignment
  (`src/wal.ts:1`, `src/index.ts:47`). Either implement the WAL or
  rename the file.

---

## Don't build

These were considered and deliberately rejected; the rationale is the
load-bearing part.

- **Source connectors** (Notion, GDrive, Slack, Gmail). Cortex's job.
  Adding them here collapses the suite story.
- **Project / people taxonomy / ontology.** Same.
- **LLM listwise reranker.** Already proven harmful on LoCoMo
  (DEBT-009). The cross-encoder rerank in R-010 is a different
  decision and should be evaluated on its own merits.
- **Speculative embedding-model abstraction** beyond the planned bge
  swap. Wait for the pull (DEBT-008). Document the dim-coupling risk
  in the meantime.
- **17k+ LLM routing.** Out of scope. Use OpenRouter; let the user
  pick.
- **"100% LongMemEval" as a headline.** MemPalace's path required
  teaching to the test; chasing the number doesn't help. NDCG@5 and
  OOD scores are the credible numbers in the saturated regime.
