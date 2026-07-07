# Changelog

All notable changes to `@onenomad/przm-memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-07

### Added

- **`onboard` prompt (slash command).** The server now exposes an MCP
  prompt that Claude Code surfaces as a slash command (e.g.
  `/przm-memory (MCP) -> onboard`). It runs a guided onboarding for a
  fresh install: assess what rules already exist, interview the user for
  their durable rules and preferences (identity/attribution, emails,
  communication style, code + workflow conventions, hard rules, project
  scoping), store each as a `preference`/`correction` memory so it
  extracts into a procedural rule and (when przm-voice is connected)
  syncs into tone, and optionally add a przm-memory usage block to
  CLAUDE.md. Reachable on any MCP-connected install with no plugin or
  file copying. Safe to re-run to add more.

### Fixed

- **Search recall-stat writes are batched.** Every search bumps
  `recallCount` + `lastRecalledAt` on each returned chunk; that was one
  per-row LanceDB update apiece, and each writes a fresh fragment. A busy
  day of searches left thousands of fragment versions that only got
  reclaimed at the daily maintenance, so the store drifted into the
  hundreds of MB between runs. The bump is now a single `mergeInsert` per
  search (full-row upsert, embedding preserved), collapsing a search's
  writes into one version. Covered by `tests/recall-bump-batch.test.ts`,
  which pins that the upsert never clobbers the stored embedding.

## [1.1.1] - 2026-07-07

### Fixed

- **Consolidation is no longer O(hours) on real stores.** `consolidate()`
  issued a separate LanceDB point-update per chunk, and its decay/link
  passes touch nearly every row — on a ~1,300-chunk store that was
  thousands of serialized scan-and-rewrite operations, made far worse by
  fragment bloat (see below). One full pass took over 1.5 hours. It now
  buffers every update/delete and commits them as a single `mergeInsert`
  upsert + bulk delete + compaction: the same store consolidates in ~30s.
  New `Storage.beginBatch()` / `flushBatch()` and the adapter primitives
  `updateChunks` / `deleteChunks` / `optimizeChunks` back it.
- **`reembed` no longer bloats the store 15x.** The re-embed loop wrote
  one fragment per chunk with no compaction, so two passes grew a 260MB
  store to ~4GB of dead versions (which is what made consolidation
  pathological). It now batches the upserts and prunes old versions at
  the end.
- **Auto-maintenance now compacts.** Each consolidation flush prunes
  versions older than an hour, so per-search recall-stat writes and each
  pass stop silently re-bloating the store.

### Added

- **`przm-memory-mcp compact`** — prune non-current table versions and
  reclaim disk. Recovers stores already bloated by pre-1.1.1 writes (a
  live 4.2GB store compacted to 23MB with no data loss).

## [1.1.0] - 2026-07-07

### Changed

- **Default embedding model upgraded to `Xenova/bge-small-en-v1.5`**
  (same 384 dims, substantially better retrieval than MiniLM-L6-v2 on
  BEIR-style benchmarks). Model selection moved behind
  `getEmbeddingModelName()` with a new `PRZM_MEMORY_EMBEDDING_MODEL`
  env var (legacy `ENGRAM_EMBEDDING_MODEL` / `SMART_MEMORY_EMBEDDING_MODEL`
  still honored). Retrieval knobs that are model-family-specific —
  query-side prefix, vector similarity floors, dedupe thresholds — now
  come from a per-family profile (`getEmbeddingModelProfile()`), with
  BGE floors calibrated empirically — first against the alien-query
  corpus, then corrected against the live 1.3k-chunk store, where
  long contextual-prefixed memories compress relevant hits to
  ~0.46-0.55 (floor 0.42; synthetic alien noise tops out at 0.503).

- **Consolidation now runs automatically.** `consolidate()` used to fire
  only on a manual `memory-maintain` call, which in practice never
  happened — chunks sat frozen in short-term forever. The server now
  schedules a maintenance pass ~20s after boot when the last run is
  older than `PRZM_MEMORY_MAINTAIN_INTERVAL_HOURS` (default 24), plus
  an interval timer for long-lived processes. Disable with
  `PRZM_MEMORY_AUTO_MAINTAIN=0`. State in `<dataDir>/maintenance.json`.

- **Procedural rules extract automatically.** `memory-ingest` with
  `type: preference` or `type: correction` now runs the rule extractor
  over the content (LLM when a key is set, heuristic patterns
  otherwise). The first maintenance pass also replays existing
  preference/correction chunks through the extractor once (stamped in
  `maintenance.json` so confidence is never re-reinforced). New
  heuristic patterns for the `rule: ...` and bare `prefers X`
  phrasings that ingested memories actually use.

### Added

- **`przm-memory-mcp reembed`** — re-embeds the whole corpus with the
  active model (with `--dry-run`). An `embedding-meta.json` marker in
  the data dir records which model the corpus was embedded with; the
  server warns loudly at boot when it mismatches the active model, and
  `memory-stats` reports `corpusEmbeddedWith` / `reembedNeeded`.
  Stores that predate the marker are assumed to be MiniLM (the old
  default). Resolves DEBT-008.

### Fixed

- **Ingest dedupe was inert under RRF.** The duplicate check filtered
  on `score >= 0.75`, but RRF composite scores top out near ~0.07, so
  no ingest was ever flagged as a duplicate. Search results now carry
  `vectorSimilarity` (raw cosine, 0..1) alongside the composite score;
  dedupe and its recommendation ladder run against that, with
  thresholds from the model profile. `memory-search` results and the
  CLI expose the same field, and CLI `--min-relevance` filters on it.

## [1.0.3] - 2026-05-21

### Fixed

- **`npx @onenomad/przm-memory` crashed on startup with
  `ERR_MODULE_NOT_FOUND` for `web-streams-polyfill/dist/ponyfill.mjs`.**
  Root cause: `openai@^4.80` → `formdata-node@4.4.1` does a deep
  `import 'web-streams-polyfill/dist/ponyfill.mjs'`, but
  `formdata-node@4.4.1` itself declares a dependency on
  `web-streams-polyfill@4.0.0-beta.3` — and v4 dropped the `.mjs`
  file from `dist/` (only exposes it through the `exports` field as
  `./dist/ponyfill.js`). The deep import resolved against v4 and
  blew up before the MCP transport ever started. Fixed by pinning
  `web-streams-polyfill` to `^3.3.3` via the package's `overrides`
  field, which still has `dist/ponyfill.mjs` as a real file. No code
  changes required.

## [1.0.2] - 2026-05-20

### Added

- **`src/version.ts`** — single source of truth for the MCP server's
  self-reported version. Reads `package.json` once at startup and
  caches the result. Replaces the hardcoded `'1.0.0'` string in
  `server.ts` that drifted as soon as v1.0.1 shipped earlier today.
  The MCP server now identifies itself as `przm-memory@1.0.2` instead
  of `przm-memory@1.0.0` in client logs and the MCP debugger.
- **`warmEmbeddings()` in `llm.ts`** — exported helper that triggers
  the embedding-model pipeline construction. The server now fires
  this in the background after `server.connect(transport)` so the
  ~1.5–5s ONNX cold-start cost (or the 10–30s first-time model
  download) happens during the MCP handshake + user's "what should I
  ask?" think-time, instead of inside the user's first
  `memory-search`. No-op when `ENGRAM_SKIP_EMBED=1`. Failures are
  swallowed (server logs the warning but stays up; `embed()` continues
  to fall through to keyword-only mode on demand).

### Performance

- **First-query latency drops by the full embedding cold-start cost.**
  Previously: user opens an MCP client, server boots, accepts the
  first `memory-search`, then spends 1.5–5s loading the embedding
  pipeline before any results come back. Now: pipeline starts loading
  the moment the server connects, so the first search either finds it
  ready (typical case) or only waits for the residual load time. Hot
  path is unchanged — this only affects the very first query in each
  server process.

## [1.0.1] - 2026-05-20

### Security

- **Storage routing is no longer silent.** Every startup now logs the
  resolved backend to stderr (`przm-memory: storage=…`), naming the
  reason (explicit env var, auto-routed via credentials file, default
  file mode). Previously a stale `~/.pyre/credentials.json` would
  silently route writes to przm Cloud with no on-screen signal — a
  shared machine, a benchmark adapter, or a local script could leak
  memories to the wire without the operator noticing.
- **`ENGRAM_NO_AUTO_CLOUD=1` opt-out.** New escape hatch that suppresses
  the credentials-file probe entirely. The file is left in place,
  explicit `STORAGE_BACKEND=cloud` still works, but the implicit
  auto-route is disabled. Use this in benchmarks, CI, and local dev
  against a real credentials file you don't want consulted.

### Changed

- **Corrupt credentials file no longer crashes the server.** If
  `~/.pyre/credentials.json` exists but fails validation (malformed
  JSON, missing fields), the factory now falls through to local file
  mode and logs the fallback explicitly, rather than throwing inside
  the cloud branch when `readCredentials` returns null.

## [1.0.0] - 2026-05-19

Initial public release on npm under the `przm` umbrella. Prior internal development happened under the `engram` / `@onenomad/engram-mcp` name; that package is deprecated in favor of this one. The repo, package, and version line all start fresh at 1.0.0.

### Added

- **Hybrid retrieval pipeline.** Nine-stage search combining vector ANN (LanceDB, 384-dim MiniLM), IDF-weighted keyword scoring, temporal window retrieval, knowledge graph lookup, and spreading activation. Verified 96.8% R@5 / 98.8% R@10 on LongMemEval (n=500) and 91.9% R@10 / 85.5% R@5 on LoCoMo (n=1,986); both result JSONs committed under `benchmarks/results/published/`.
- **Memory tiers + lifecycle.** `scratch` (24h auto-purge) → `daily` (2d) → `short-term` (14d) → `long-term` (90d) → `archive`, with promotion driven by recall frequency, importance, and feedback signals.
- **Memory origin tags.** Every chunk carries `user` / `extracted` / `imported` / `derived`. User-origin memories are excluded from auto-merging, near-duplicate deletion, and archival decay.
- **Cognitive layers.** Episodic / semantic / procedural classification with layer-specific decay rates.
- **Procedural rules.** Learned from corrections and instructions. Confidence asymmetry: reinforcement +0.1, contradiction -0.2.
- **Knowledge graph.** Entity-relationship triples with temporal validity (`validFrom` / `validTo`). 12 relationship types auto-extracted at ingest. Tools: `engram-kg-add`, `engram-kg-query`, `engram-kg-invalidate`, `engram-kg-timeline`.
- **Reconsolidation, adaptive forgetting, self-organizing memories, duplicate detection** during the consolidation pass.
- **Governance middleware.** Advisory contradiction detection, semantic drift monitoring, and memory poisoning checks via `engram-govern`.
- **Handoff protocol.** `engram-handoff-write`, `engram-handoff-read`, `engram-context-pressure` for cross-session continuity. Two bundled Claude Code hooks (`engram_precompact_hook.sh`, `engram_stop_hook.sh`) automate handoff writes before `/compact` and at session end.
- **Persona bridge.** Coordinates with [`@onenomad/przm-voice`](https://github.com/OneNomad-LLC/przm-voice) when both servers run: emotion-weighted memory importance, cognitive-load-gated search results, and a procedural-bridge file (`~/.claude/procedural-bridge.json`) that syncs learned rules between Memory and Voice.
- **20 MCP tools across six groups:** core memory, knowledge graph, diary, handoff, governance, import.
- **7 slash commands:** `/memory-source`, `/recall`, `/forget`, `/memory-health`, `/memory-api`, `/knowledge`, `/memory`.
- **Storage backends.** `file` (default — LanceDB + filesystem), `postgres` (multi-tenant via pgvector), and `cloud` (przm Cloud, opt-in via `przm-memory login`).
- **`przm-memory login` / `logout` CLI** for przm Cloud pairing. Credentials at `~/.pyre/credentials.json` (mode 0600).
- **Engines requirement:** `node >=22.0.0`.

### Security

- **Path traversal hardening** in `engram-handoff-read`: `STAMP_RE` is anchored and a defense-in-depth `isSafeHandoffIdentifier()` rejects identifiers containing `/`, `\`, `..`, or NULL bytes.
- **Windows browser-open RCE prevented:** the login flow opens URLs via `rundll32.exe url.dll,FileProtocolHandler` (no shell layer) and validates URLs through `isSafeBrowserUrl()` (http/https only, no control or shell-significant chars).
- **LIKE-pattern injection patched** in `storage-file`'s tag filters: `escLike()` escapes `\`, `%`, `_` with an explicit `ESCAPE '\'` clause. Both `esc()` and `escLike()` reject NULL bytes.
- **Storage routing isolation:** benchmark harnesses force `STORAGE_BACKEND=file` at module load to prevent silent auto-routing to przm Cloud when a credentials file exists on the host.
- **Data directories created with mode 0700** (owner-only) for `storage-file`, `diary`, `handoff`, `session-state`, and `procedural-bridge`. Memory data isn't world-readable on multi-user systems.

[Unreleased]: https://github.com/OneNomad-LLC/przm-memory/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OneNomad-LLC/przm-memory/releases/tag/v1.0.0
