# Changelog

All notable changes to `@onenomad/przm-memory` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
