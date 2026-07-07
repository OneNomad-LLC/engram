# Architecture Debt

Living ledger of known shortcuts in Engram's architecture. Each entry
captures the choice, why we made it, what hurts today (or what *will*
hurt), and the trigger that should make us revisit. The point is not
to fix everything — it's to make the choices visible so we don't
rediscover them under pressure.

Add new entries at the bottom. When closing one out, leave the entry
in place with a `## Resolved (YYYY-MM-DD)` heading and a one-line note
on what shipped — the historical record is more useful than a clean
slate.

---

## DEBT-001 — No tenant isolation in storage

**Where:** `src/storage.ts`, LanceDB collection layout, all retrieval
paths.

**Choice:** Engram runs single-user / single-process. Memories are
keyed by user only via the calling client; there's no DB-layer
enforcement that one user cannot read another user's rows.

**Why:** The product today is a personal MCP server installed locally;
there is no second user on the box. Adding RLS / row-level isolation
costs real complexity and would have slowed the LoCoMo benchmark loop
that was the priority for this segment.

**What hurts:** The moment Engram Cloud lands (or anyone deploys this
multi-tenant), every retrieval call becomes a leak vector. The same
pattern Cortex needs (Postgres RLS keyed off
`current_setting('app.user_id')`) applies here.

**Revisit when:** First multi-user deployment is on the roadmap, or
Cortex's RLS work lands and we want to share the pattern.

**Pattern reference:** Engram architecture-patterns §1, Cortex
architecture-patterns §1.

---

## DEBT-002 — `engram-dossier` exists, but `engram-search` doesn't auto-route entity-shaped queries to it

**Where:** `src/search.ts` (every entity-shaped query goes straight
through the hybrid retrieval pipeline). `engram-dossier` lives in
`src/server.ts` as a separate MCP tool the caller has to invoke
explicitly.

**Choice:** The dossier surface is built and returns the right
structured snapshot (KG facts where entity is subject + referencedBy,
plus categorized memory chunks). But there's no intent classifier
that detects "what do you know about Matt" and routes the call to
`engram-dossier` ahead of `engram-search`. The agent has to know to
ask for the dossier.

**Why:** Building the classifier means a small LLM call per search
(latency + cost) or a heuristic-based router (false positives /
negatives). Both punted on so the dossier could ship without
blocking on classification.

**What hurts:** Agents that don't know about `engram-dossier` —
which is most of them, since `engram-search` is the canonical entry
point — fall back to RAG-style retrieval for entity queries.
Authoritative entity facts get retrieved as memories with relevance
scores rather than loaded as ground truth, and the model can
interpolate fields the dossier would have made authoritative.

**Revisit when:** A workload appears where the diagnostic traces
(DEBT-004) show entity-shaped queries are routinely missing the
dossier. The hook is in `src/search.ts` before the vector stage.

**Pattern reference:** Engram architecture-patterns §3.

---

## Resolved (2026-05-09) — DEBT-003: Retrieval floor calibration

**Was:** The 0.25 vector-similarity floor in `src/search.ts` was picked
empirically during benchmark tuning with no permanent test artifact
guarding against drift.

**Resolved by:** `tests/alien-query-floor.test.ts`, which runs:
1. **Vector calibration** — 20 alien queries against a single-topic
   (Pyre + Cortex) 15-chunk corpus, asserts max raw cosine similarity
   stays under 0.45 (margin of ~0.20 above the production 0.25 floor).
2. **Pipeline leak check** — full `search()` against same corpus,
   asserts no alien query produces a composite score ≥ 0.10.
3. **Control queries** — 3 corpus-topic queries assert the floor
   isn't over-tightened (real queries still return results).

A future model swap, contextual-prefix change, or embedding-dim tweak
that drifts the alien-query distribution will fail (1) and force a
deliberate re-calibration of the production floor.

**Pattern reference:** Engram architecture-patterns §2.

---

---

## DEBT-004 — Diagnostic retrieval traces ship minimal stages, replay tool not built

**Where:** `src/retrieval-trace.ts` defines the trace primitive;
`src/search.ts` records `corpusSize`, `vectorAboveFloor`,
`vectorBelowFloor`, `keywordMatches`, and `finalCount`. The
`engram-trace-recent` MCP tool surfaces them.

**Choice:** Stage instrumentation is intentionally minimal — vector
above/below floor + keyword matches + final count. The remaining
stages (bonus factors, temporal boost, time-window retrieval, KG
lookup, spreading activation) are NOT instrumented. There is no
replay tool that re-runs a saved query against the current corpus.
Traces are off by default (`ENGRAM_ENABLE_RETRIEVAL_TRACES`).

**Why:** The minimal stage set covers the most common diagnostic
question — *did the result get pulled and did it survive the floor* —
without making every retrieval call carry a 9-stage instrumentation
tax. The replay tool is a separate piece of work that needs the
full stage set first to be useful.

**What hurts:** Misses that pass the vector floor but get dropped in
later stages (e.g. bonus factors push them below the cap, or the time
window excludes them) are not visible from the trace alone — you can
see the result *wasn't returned*, but not *which stage dropped it*.

**Revisit when:** A diagnostic session needs to know which post-vector
stage dropped a candidate. Add per-stage `recordStage` calls in the
boost / window / KG / spreading-activation passes.

**Pattern reference:** Engram architecture-patterns §5.

---

## DEBT-005 — No approval / lifecycle workflow on memories

**Where:** `src/storage.ts`, `src/governance.ts` (governance covers
write-side validation but not lifecycle).

**Choice:** Every memory is immediately retrievable as soon as it's
written. There's no `experimental → approved → transactional`
lifecycle, no role-gated approval, no audit table tracking who
approved what.

**Why:** The local-first single-user deployment doesn't have a "the
agent wrote it, now an admin approves it" workflow at all — the user
is the only actor. Building the lifecycle now would be over-
engineering for the current shape.

**What hurts:** Existential blocker for any regulated-vertical
deployment (legal, finance, healthcare, anything SOC 2 / HIPAA / SOX-
adjacent). They will not deploy without a legal audit trail of who
approved what.

**Revisit when:** First regulated-vertical customer is in the
pipeline, OR Engram Cloud's enterprise tier ships.

**Pattern reference:** Engram architecture-patterns §4.

---

## DEBT-006 — No write-time isolation validator on KG edges

**Where:** `src/knowledge-graph.ts` (edge writes don't validate that
both endpoints are in the same isolation scope).

**Choice:** Today every edge write succeeds as long as both nodes
exist. There's no check that the two nodes belong to the same tenant
/ workspace / scope.

**Why:** With single-user storage (DEBT-001), there's only one scope,
so the check is a no-op. Building it now would be guarding against a
boundary that doesn't exist yet.

**What hurts:** As soon as DEBT-001 closes, every cross-scope edge
becomes a silent isolation leak. Query-time filters fail open; one
missed `WHERE tenant_id = ?` and data crosses boundaries. By the time
you notice, you've shown customer A's data to customer B.

**Revisit when:** DEBT-001 closes, AT THE SAME TIME — these two are
linked. Don't ship multi-tenant storage without the write-time
validator.

**Pattern reference:** Engram architecture-patterns §6.

---

## DEBT-007 — No audit events with trace IDs on mutations

**Where:** `src/storage.ts`, every write path
(`engram-ingest`, `engram-update-metadata`, `engram-kg-add`, etc.).

**Choice:** Writes succeed (or fail), but no separate audit event is
emitted with actor + scope + before/after diff + trace ID linking back
to the originating MCP call.

**Why:** Single-user means there's only one actor; the existing
governance log captures enough for the local case.

**What hurts:** Multi-tenant deployments need this for compliance
(who modified what, when, why). It's also what feeds incident
response when something goes wrong — without trace IDs linking writes
back to the originating MCP call, root-causing a bad write requires
log correlation by hand.

**Revisit when:** Bundle with DEBT-005 (approval workflow) — the
audit table is the same table both features write to.

**Pattern reference:** Engram architecture-patterns §7.

---

## DEBT-008 — Embedding model is effectively hardcoded — RESOLVED

**Resolved:** The default model is now `Xenova/bge-small-en-v1.5`
(same 384 dims). Model-family-specific retrieval knobs (query prefix,
similarity floors, dedupe thresholds) live in
`getEmbeddingModelProfile()` in `src/llm.ts`, so a swap is a profile
entry plus floor calibration via `tests/alien-query-floor.test.ts`.
The corpus migration story exists: `przm-memory-mcp reembed` rewrites
every stored vector with the active model, an `embedding-meta.json`
marker tracks which space the corpus is in, and the server warns at
boot on mismatch instead of silently degrading.

**Still true:** the LanceDB vector column width is fixed at table
creation (384), so a model with a different native dimension needs
either Matryoshka truncation (`ENGRAM_EMBEDDING_DIM`) or an
export/re-import into a fresh data dir. `reembed` preflights this and
refuses with instructions rather than corrupting the column.

---

## DEBT-009 — No reranker (intentional, but track the trade-off)

**Where:** `src/reranker.ts` exists as a stub — Engram intentionally
ships without an LLM reranker.

**Choice:** Per `docs/benchmark-optimization.md`, LLM reranking was
*actively harmful* on this pipeline against LoCoMo. We left the file
in place so it's easy to bring back, but no rerank runs in production.

**Why:** Cost (LLM call per query), latency (~500-2000ms), and the
benchmark says it doesn't help — adding it would make the system
slower, more expensive, and worse on the dataset we measure on.

**What hurts:** This is a *non-debt* entry — it's here so future-us
doesn't add a reranker reflexively. The cost is that some kinds of
retrieval (very long candidate lists, cross-language matching) might
benefit from a reranker even if LoCoMo doesn't show it.

**Revisit when:** A workload appears where the benchmark numbers
diverge from customer-reported quality, AND the diagnostic traces
(DEBT-004) show the candidates were correct but the ranking was
wrong. Both conditions matter.

---

## Resolved (2026-05-22) — R-001: engram → przm naming drift

**Was:** `src/server.ts` registered tools as `memory-*` but README,
all seven skill files, both hooks, `src/context-pressure.ts`
action-plan strings, and `SKILL.md` still referenced `engram-*`.
Fresh agents reading docs called tools that didn't exist.

**Resolved by:** Alias table in `src/server.ts:1333+` registers
every tool under both `memory-*` (canonical) and `engram-*`
(deprecation runway). README §Tools, all seven `skills/*/SKILL.md`,
both hooks, `src/context-pressure.ts:28-58`, and top-level
`SKILL.md` updated to canonical names. Existing installations
continue to work via the alias path.

---

## Resolved (2026-05-22) — R-002: KG confidence dropped in Postgres

**Was:** `src/storage-postgres.ts:660` (`pgRowToTriple`) hardcoded
`confidence: 0.5` because the column didn't exist in the schema.
KG reinforcement and spreading-activation weighting were no-ops
for all Postgres/cloud users.

**Resolved by:** `migrations/postgres/003_kg_confidence.sql` adds
the `confidence REAL NOT NULL DEFAULT 0.5` column. `saveTriple`
writes it; `pgRowToTriple` reads it. `tests/kg-confidence.test.ts`
exercises read-back-after-write and reinforcement.

---

## Resolved (2026-05-22) — R-003: Episodic L1 duplicates on repeat consolidation

**Was:** `src/episodic-consolidator.ts:103` set
`consolidationLevel: 0` on source chunks after summarizing them.
Every `memory-maintain` re-selected the same chunks as candidates
and produced another L1 summary for the same cluster.

**Resolved by:** One-line change to `consolidationLevel: 1`.
`tests/episodic-consolidation-level.test.ts` asserts L1 count is
stable across repeat consolidation passes.

---

## Resolved (2026-05-22) — R-004: TOCTOU race on KG triple uniqueness in Postgres

**Was:** `addTriple` did `queryTriples({activeOnly: true})` then
conditional insert. Two concurrent ingests of the same content
both passed the check and inserted duplicate active triples.

**Resolved by:** `migrations/postgres/003_kg_confidence.sql`
adds `CREATE UNIQUE INDEX knowledge_triples_active_spo_idx ON
knowledge_triples (tenant_id, subject, predicate, object) WHERE
invalidated_at IS NULL`. INSERT uses `ON CONFLICT DO NOTHING`;
confidence reinforcement runs as a separate UPDATE.

---

## Resolved (2026-05-22) — R-005: No SSL enforcement on Postgres connections

**Was:** `src/storage-postgres.ts:85-88` initialized the Pool
without an `ssl` option. Cloud Postgres (Supabase, Neon, Heroku,
RDS) typically requires `sslmode=require`; users without it in
their `DATABASE_URL` got plaintext connections or confusing
errors.

**Resolved by:** `resolvePostgresSsl()` helper defaults to
`{ rejectUnauthorized: true }` unless the connection string is
localhost / 127.0.0.1 or `ENGRAM_PG_SSL=off` is set. Configuration
documented in README.

---

## Resolved (2026-05-23) — R-007: Drop CSV-string params; use arrays

**Was:** Six MCP-tool params took comma-separated strings and the
handler `.split(',')`-parsed them:
- `memory-ingest.tags` (`src/server.ts:280`)
- `memory-outcome.chunkIds` (`src/server.ts:572`)
- `memory-handoff-write.completed / nextSteps / openQuestions /
  fileRefs / decisions` (`src/server.ts:1005-1009`)

A comma in any of those values silently corrupted the field.

**Resolved by:** all six now `z.array(z.string())`. Handlers consume
arrays directly; the `splitCsv` helper and ad-hoc `.split(',')` calls
are gone. Tool descriptions updated to drop the "comma-separated" hint.

---

## Resolved (2026-05-23) — R-009: Strip benchmark-only knobs off `memory-ingest`

**Was:** `memory-ingest` exposed `skipKgExtraction`, `skipDailyEntry`,
and `awaitSideEffects` on the public MCP schema. All three were
documented as "benchmark harness only" — they wasted tokens (every LLM
reads every description), invited misuse, and confused tool selection.

**Resolved by:** removed from the MCP schema in `src/server.ts:271+`.
Production defaults apply on the MCP path. The benchmark harness still
calls the library entry point in `src/index.ts` directly and continues
to use these knobs there.

---

## Resolved (2026-05-23) — Backlog sweep #1

Three small backlog items shipped together as a sweep pass; each
is independently atomic and self-contained.

- **`memory-extract.messages` now an array.** `src/server.ts:465`
  previously took `z.string()` (a JSON-encoded array) with the
  handler calling `JSON.parse`. Same CSV-in-string anti-pattern as
  R-007. Now `z.array(z.object({role, content})).min(1)`; the byte
  cap became a turn count cap (10k) so the schema is honest about
  what it accepts.

- **Episodic clustering determinism.**
  `src/episodic-consolidator.ts:130` (`clusterMemories`) iterated
  in whatever order `listChunks()` returned. LanceDB scan order
  varies with fragment state, so consecutive `memory-maintain`
  runs against the same corpus could produce different L1
  summaries. Now sorted by `(createdAt, id)` before the greedy
  pass, so clustering is reproducible.

- **`memory-ingest` dup-detection response now actionable.**
  `src/server.ts:301` previously returned
  `{ingested: 0, duplicate: true, similar: [...]}` and left the
  caller guessing between accept-existing / retry-skipDedupe /
  give-up. Response now includes `recommendation` (`accept_existing`
  / `reinforce_existing` / `force_write_if_intentional_refinement`,
  thresholded on the top similar score) and a `nextAction` string
  telling the caller exactly which tool call to make next.

---

## How to add an entry

Pick the next `DEBT-NNN` number. Stick to this skeleton:

```
## DEBT-NNN — One-line title

**Where:** file path / module.
**Choice:** what we did.
**Why:** what trade-off we accepted.
**What hurts:** what this costs us today / what it will cost.
**Revisit when:** the trigger that should make us revisit.
**Pattern reference:** (optional) link to architecture pattern note.
```

Resist the urge to write "we should fix this later" as a closing
line. Every entry that survives in the ledger is one we explicitly
chose not to fix today; that's the whole point of the file.
