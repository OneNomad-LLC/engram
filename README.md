# przm Memory <sub>(engram)</sub>

[![przm: Memory](https://img.shields.io/badge/przm-Memory-E84040?style=flat-square&labelColor=1a1a1a)](https://przm.sh)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square&labelColor=1a1a1a)](LICENSE)

The memory surface of [przm](https://przm.sh), OneNomad's AI reliability suite. Project codename: `engram`. The GitHub repo is now [`OneNomad-LLC/przm-memory`](https://github.com/OneNomad-LLC/przm-memory) (old URLs redirect); the npm package publishes as `@onenomad/przm-memory` at v1.0. Until then, install from source.

A memory system for AI agents. LLMs can't remember anything between conversations by default, and the existing solutions are either too simple (just dump everything in a vector DB) or too expensive (send your entire history to an API every time). przm Memory sits in the middle. It runs locally, doesn't need an API key for basic operation, and scores **96.8% R@5 / 98.8% R@10 on LongMemEval** and **85.1% R@5 / 92.0% R@10 on LoCoMo**. On R@10 it beats MemPalace hybrid v5 (88.9%) by +3.1pp on LoCoMo and approaches MemPalace hybrid v4's R@5 (98.4%) on LongMemEval, at **44ms p50 search latency** on a 53-session corpus. Methodology is reproducible from a fresh clone with one command. See [`benchmarks/results/published/`](benchmarks/results/published) for committed result JSONs.

The core idea is that memory shouldn't just be "find similar text." When someone asks "where was I working last March?" the system needs to actually reason about time, not just pattern match on the word "March." So the search pipeline combines vector similarity, keyword matching with IDF weighting, temporal inference, a knowledge graph, and spreading activation over a memory graph. Each piece handles a different kind of recall that the others miss.

## Table of Contents

- [Benchmark Results](#benchmark-results)
- [How It Works](#how-it-works)
- [Compatibility](#compatibility)
- [Installation](#installation) (Claude Code, Claude Desktop, Cursor/Windsurf/Cline, Source)
- [Configuration](#configuration)
- [Tools](#tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Benchmarks](#benchmarks)
- [Security](#security)
- [Use Cases](#use-cases)
- [Pairs Well With: przm Voice (persona)](#pairs-well-with-przm-voice-persona)
- [License](#license)

## Benchmark Results

Tested against the [LoCoMo benchmark](https://github.com/snap-research/locomo) (1,986 QA pairs across 10 long conversations). No LLM reranking, just the retrieval pipeline on its own.

```
Per-category:
  adversarial               R@5= 89.7%  R@10= 95.1%
  open-domain               R@5= 88.8%  R@10= 94.3%
  single-hop                R@5= 78.0%  R@10= 86.9%
  temporal                  R@5= 82.6%  R@10= 91.6%
  temporal-inference        R@5= 61.5%  R@10= 74.0%

  OVERALL                   R@5=85.1%   R@10=92.0%
  Embedding model           Xenova/all-MiniLM-L6-v2 (23MB, runs on CPU)
```

For details on recent benchmark optimization work including regression fixes, sub-session chunking, and reranking analysis, see [docs/benchmark-optimization.md](docs/benchmark-optimization.md).

### How to read these numbers

Most "AI memory" projects publish one of two very different metrics, and the field treats them as interchangeable when they aren't:

- **Retrieval recall (R@K)** — did the right memory land in the top K candidates? Computed deterministically from the dataset's ground-truth session IDs. No LLM in the loop. Reproducible from a clone.
- **LLM-judge accuracy** — did the final answer (an LLM-generated response that USED the retrieved memory) match the ground truth, as graded by ANOTHER LLM? Outcome depends on the answer LLM, the judge LLM, and the judge prompt.

These are not directly comparable. A system can hit 95% R@10 (the right memory was retrieved) and still produce wrong answers (the answer LLM ignored it or hallucinated). A system can hit 95% LLM-judge (lenient grader rewarded paraphrases) without ever retrieving the right memory.

przm Memory publishes R@10. The two tables below are split by metric so you can compare like to like.

#### Retrieval recall — direct comparisons

LongMemEval (n=500, methodology-clean, verified 2026-05-16):

| System | LongMemEval R@5 | LongMemEval R@10 | Requires API | Notes |
|--------|-----------------|------------------|--------------|-------|
| MemPalace hybrid v4 (held-out) | 98.4% | — | No | Their best zero-API config |
| **przm Memory** | **96.8%** | **98.8%** | **No** | **Local MiniLM, 9-stage hybrid, no rerank — R@10 exceeds MemPalace's R@5** |
| MemPalace raw ChromaDB | 96.6% | — | No | Baseline ChromaDB embeddings |
| MemMachine v0.2 | — | — | Yes | (different metric, see LLM-judge table) |

LoCoMo (n=1,986, R@10 retrieval recall):

| System | LoCoMo R@10 | Requires API | Notes |
|--------|-------------|--------------|-------|
| **przm Memory** | **91.9%** | **No** | **Verified 2026-05-16, full 1,986 QA, post-fix code path** |
| MemPalace hybrid v5 | 88.9% | No | Same metric, same dataset |
| Supermemory | 83.5% | No | |

#### LLM-judge accuracy — different metric, listed for context only

| System | LoCoMo LLM-judge | Judge model | Notes |
|--------|------------------|-------------|-------|
| Mem0 | 91.6% (April 2026 claim) | gpt-4o-mini | See methodology caveats below |
| MemMachine v0.2 | 91.7% | GPT-4.1-mini | |
| Backboard | 90.1% | GPT-4.1 | |
| Zep Graphiti | 85.2% | — | Graph-based retrieval |
| Letta | ~83.2% | — | |
| Zep (standard) | 75.1% | — | |
| Mem0 | 64-67% (pre-2026 published) | — | The number widely cited before mem0's April 2026 update |
| OpenAI memory | 52.9% | — | Built-in ChatGPT memory |

#### Methodology caveats on the LLM-judge numbers

LLM-judge scores are sensitive to choices that aren't always disclosed in headline numbers. Things worth checking when comparing:

- **Grader bias.** mem0's published judge prompt at [`evaluation/metrics/llm_judge.py:23`](https://github.com/mem0ai/mem0/blob/main/evaluation/metrics/llm_judge.py) instructs the LLM verbatim: *"you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT."* Generous grading inflates scores vs strict matching.
- **Question filtering.** mem0's eval drops Category 5 (adversarial) questions before averaging ([`llm_judge.py:87-89`](https://github.com/mem0ai/mem0/blob/main/evaluation/metrics/llm_judge.py)). Adversarial robustness doesn't enter the headline.
- **OSS vs hosted code path.** mem0's eval calls the hosted Platform via `MemoryClient`, not the OSS `Memory` class ([`evaluation/src/memzero/add.py:47-51`](https://github.com/mem0ai/mem0/blob/main/evaluation/src/memzero/add.py)). The published numbers can't be reproduced on the OSS code anyone can install.
- **Extraction tuning.** mem0's eval pushes LoCoMo-specific `custom_instructions` to the project before ingest, including `"Extract memories only from user messages, not incorporating assistant responses"` ([`add.py:39`](https://github.com/mem0ai/mem0/blob/main/evaluation/src/memzero/add.py)) — corroborating Zep's [public critique](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/).

These aren't "gotchas" that disqualify the numbers — they're choices, and other projects make their own. The point is that LLM-judge accuracy isn't a standardized metric the way R@K is. Compare like to like.

The R@10 numbers above are reproducible from a fresh clone with `pnpm bench:locomo` (committed result JSON in `benchmarks/results/published/`). The methodology is the architecture documented above; there's no benchmark-specific tuning in the search pipeline. Run the bench yourself.

## How It Works

### The Search Pipeline

This is where the interesting stuff happens. A query goes through nine stages before results come back.

**Stage 1: Signal Extraction.** Before any search happens, the query gets parsed for dates, entities (proper nouns), quoted phrases, and temporal language. If someone writes "What was Matt working on before he switched jobs in June?" the system extracts the date (June), the entity (Matt), and flags it as a temporal inference query because of the word "before."

**Stage 2: Vector Search.** Standard ANN search against LanceDB using cosine distance on 384-dim embeddings. This handles the "find semantically similar stuff" part. Candidates need at least 0.25 similarity to make the cut.

**Stage 3: IDF Keyword Scoring.** Rare terms in the query get weighted higher than common words. If you search for "Matt TypeScript" both terms will dominate scoring because they appear in relatively few memories. Proper nouns get an extra 1.5x boost. Results from this stage get blended with vector scores. The blend shifts toward keywords when entities are present, since names and specific nouns are better matched by exact text than by embedding similarity.

**Stage 4: Bonus Factors.** Every candidate gets adjustments for recency, recall frequency, tier, importance, and cognitive layer. Procedural memories (rules about how you want things done) get a small boost because they tend to be more immediately useful.

**Stage 5: Temporal Boost.** If the query mentions dates, memories get boosted based on whether they contain matching date strings or were created near the query date. Exact date matches in content get up to +0.4, timestamp proximity up to +0.3.

**Stage 6: Time-Window Retrieval.** This is the big one for temporal inference. When the system detects temporal signals, it pulls memories from the relevant time period into the candidate pool regardless of semantic similarity. "Where was I working in March 2024?" needs memories *from* March 2024, not just memories that happen to mention the word "March." Window size adapts to date precision. A specific day gets +/- 3 days, a month gets the full month plus buffer, a year gets the full year. If the query says "before March," the window extends 90 days earlier.

**Stage 7: Knowledge Graph Lookup.** When entities and time are both present, the system queries the knowledge graph for facts that were valid at the query time. If there's a triple like `(Matt, works-at, Acme Corp, valid 2024-01 to 2024-06)` and the query asks about Matt in March 2024, memories mentioning "Acme Corp" get boosted.

**Stage 8: Spreading Activation.** Based on [Collins & Loftus (1975)](https://en.wikipedia.org/wiki/Spreading_activation). The top 5 scoring memories activate their graph neighbors, which in turn activate their neighbors. Two hops deep, with activation decaying at each hop. Temporal edges get a 1.5x multiplier when the query involves time reasoning.

**Stage 9: Token Budget.** Results get sorted by score and trimmed to fit within a configurable token budget (default 1500 tokens). This prevents context bloat when injecting memories into prompts.

### Memory Tiers

Memories flow through four tiers with automatic promotion and demotion, plus a fifth scratch tier that sits outside the lifecycle:

```
scratch (24h, never promoted, manual promote only)

daily (2 days) --> short-term (14 days) --> long-term (90 days) --> archive
                        ^                                             |
                        +------ reactivation (if recalled) -----------+
```

Promotion isn't just about age. A memory moves to long-term if it's been recalled multiple times, has high importance, received "helpful" feedback, or is a procedural rule. Memories that keep getting recalled stay promoted. Memories that never get touched decay and eventually archive.

**Scratch tier** is for exploratory, session-only notes that you may want to discard. Pass `tier: 'scratch'` to `engram-ingest` and the chunk is excluded from every consolidation path: no promotion, no merging, no decay-to-archive, no linking. After 24 hours scratch chunks are auto-purged. Use `engram-scratch-promote` to graduate one to short-term once you've decided it's worth keeping.

### Memory Origin

Every chunk carries an `origin` tag that distinguishes user-asserted memory from auto-derived memory:

- **`user`** — written explicitly via `engram-ingest`. Treated as canonical user-territory: the consolidator never auto-merges, near-duplicate-deletes, or archives these. Importance still decays normally, but the content and lifecycle stay sacred.
- **`extracted`** — pulled from a conversation by `engram-extract` or the Mem0 provider.
- **`imported`** — bulk-loaded via `engram-import`.
- **`derived`** — produced by consolidation (e.g. episodic-to-semantic summaries).

The split mirrors the journal pattern in [przm Voice](https://github.com/OneNomad-LLC/przm-voice) (persona): a clean ownership boundary between what the user said and what the system inferred. If you want auto-extracted memories to lose to your hand-written ones in a near-duplicate fight, this is what makes that happen.

Importance decays exponentially over time, but the rates differ by cognitive layer:
- **Procedural** (rules): decays slowest (0.98/week, floor 0.15). Rules tend to stay relevant.
- **Semantic** (facts): medium decay (0.97/week, floor 0.10)
- **Episodic** (events): decays fastest (0.95/week, floor 0.05). Specific moments matter less over time.

### Cognitive Layers

Every memory gets classified into one of three layers:

- **Episodic** is for events tied to a specific moment. "User debugged a schema migration and it took most of the session."
- **Semantic** is for durable facts. "User prefers TypeScript over Python." "User's dog is named Ellie."
- **Procedural** is for behavioral rules about how the user wants things done. "Always show code before explanation." "Never use em-dashes."

The system can extract these from conversations using LLM-powered classification or, if no API key is available, a set of heuristic patterns. The heuristics catch things like "I always prefer X" (procedural), "I work at Y" (semantic fact), and "no, don't do that" (correction/procedural).

### Procedural Rules

Learned from user corrections and direct instructions. Each rule has a confidence score that shifts with evidence:

- Reinforcement (user repeats or confirms the rule): confidence +0.1
- Contradiction (user does the opposite): confidence -0.2

The asymmetry is intentional. Contradictions should weigh more because they often mean the rule was wrong. Rules that hit zero confidence get pruned.

### Knowledge Graph

Entity-relationship triples with temporal validity. Each triple records when a fact became true and optionally when it stopped being true.

```
("Matt", "works-at", "Acme Corp",  validFrom: 2024-01, validTo: 2024-06)
("Matt", "works-at", "NewCo",      validFrom: 2024-06, validTo: null)
("finch-core", "uses", "TypeScript", validFrom: 2025-01, validTo: null)
```

When a fact changes, the old triple gets invalidated (marked with an end date) and a new one gets created. The full history is preserved so the system can answer questions about the past. Adding a triple that already exists just bumps its confidence score.

### Reconsolidation

Borrowed from neuroscience. When a memory gets recalled during a relevant conversation and marked as helpful, the system can update it with new context. A memory like "User prefers TypeScript" might get refined to "User prefers TypeScript for large projects but uses Python for quick scripts" if that nuance comes up in conversation.

This only triggers if the memory hasn't been reconsolidated in the last 24 hours (to prevent over-updating) and requires an LLM API key.

### Recall Outcomes

A feedback loop that lets the system learn which memories are actually useful:

- **Helpful**: importance +0.05, triggers reconsolidation, strengthens graph edges to co-recalled memories
- **Corrected**: importance -0.10 (memory was wrong)
- **Irrelevant**: importance -0.05

If a memory gets marked irrelevant 3+ times out of the last 5 recalls, its importance drops sharply and it may get archived.

### Knowledge Graph Auto-Population

When a memory is ingested, the system heuristically extracts entity-relationship triples and adds them to the knowledge graph automatically. It detects 12 relationship types including `works-at`, `uses`, `depends-on`, `prefers`, `chose`, `located-in`, and more. This means the knowledge graph grows passively as memories accumulate, without needing explicit `engram-kg-add` calls for every fact.

### Governance Middleware

Advisory checks that flag potential issues without auto-deleting anything:

- **Contradiction detection**: Combines vector similarity, keyword heuristics, and optional LLM analysis to find memories that conflict with each other. Flags them for review.
- **Semantic drift monitoring**: Tracks how the memory store's content distribution shifts over time. Alerts if the store is drifting significantly from its historical baseline.
- **Memory poisoning checks**: Detects patterns that suggest adversarial injection — unusual embedding distributions, suspiciously high importance scores, or content that doesn't fit the user's established patterns.

### Adaptive Forgetting

Inspired by [FadeMem (Jan 2026)](https://arxiv.org/abs/2501.xxxxx). Standard FSRS decay is purely time-based, but real memory doesn't work that way. A fact that's semantically close to things you keep recalling should decay slower than an isolated fact you never revisit.

Adaptive forgetting modulates the decay rate based on semantic proximity to recently recalled memories. If a memory's nearest neighbors are getting recalled, it decays slower. If nothing nearby is ever accessed, it fades faster. This reduces storage without losing contextually relevant information.

### Self-Organizing Memories

During consolidation, the system does two passes of housekeeping beyond decay and promotion. First, any memory missing a short description gets one auto-generated from its content, which makes it easier to surface in summaries and the knowledge graph. Second, the consolidator scans for semantically related memories that aren't yet linked and generates cross-links between them, so spreading activation has more edges to traverse the next time a query comes in. The graph densifies passively as the store grows.

### Duplicate Detection and Merging

New memories get checked against existing ones using Jaccard similarity on word sets (threshold 0.75). If a duplicate is found, it doesn't get stored.

During consolidation, the system also scans for near-duplicates using cosine similarity on embeddings (threshold 0.9). When found, the higher-importance memory absorbs the other's recall count and the duplicate gets deleted.

### Handoff Protocol

Context compaction is irreversible, and if the window fills completely before compaction runs the user has to abandon the chat. przm Memory treats this as a first-class failure mode and ships three tools that mechanize the fix:

- `engram-handoff-write` persists a structured "where we left off" snapshot to `handoffs/YYYY-MM-DD_HH-MM-SS.{json,md}` — currentTask, completed, nextSteps, openQuestions, file references, decisions, and free-form notes. The JSON half is for programmatic resume; the markdown half is for humans.
- `engram-handoff-read` loads the latest handoff (or a specific one by stamp). Agents call it at session start to pick up from exactly where the previous session stopped.
- `engram-context-pressure` is a self-nudge: the agent reports its own pressure level (`ok`/`warm`/`hot`/`critical`) and gets back a deterministic action plan — when to save, when to write the handoff, when to compact early rather than riding the window to the edge. Passing `phaseBoundary=true` (task complete, pivoting focus, finishing a subsystem) overrides level and forces a proactive compact; the reasoning is that pivots thrash Anthropic's 5-minute prompt cache anyway, so eating that miss at the boundary is effectively free and avoids carrying the verbose tool output of the finished phase into the next one.

The bundled `engram_precompact_hook.sh` runs autonomously before compaction: it approves immediately if a fresh handoff (`reason="compact"`, written within the last 5 minutes) already exists; otherwise it auto-generates a mechanical handoff from the transcript (recent user messages, edited files, tool calls, commits) and approves. `/compact` "just works" — no two-step ritual.

#### Installing the hooks

przm Memory ships two optional Claude Code hooks: `hooks/engram_precompact_hook.sh` (runs before `/compact`) and `hooks/engram_stop_hook.sh` (runs at session end to write a rolling checkpoint). Wire them in `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
  "hooks": {
    "PreCompact": [
      { "type": "command", "command": "/absolute/path/to/przm-memory/hooks/engram_precompact_hook.sh" }
    ],
    "Stop": [
      { "type": "command", "command": "/absolute/path/to/przm-memory/hooks/engram_stop_hook.sh" }
    ]
  }
}
```

Use the absolute path to the hook script — Claude Code does not resolve relative paths from your project root. On Windows, the hooks require WSL or Git Bash on PATH (they're bash scripts); native PowerShell is not supported.

The hooks are optional. The MCP tools work without them. The hooks just make the handoff lifeline reliable across `/compact` and session end without requiring you to remember to call `engram-handoff-write` manually.

## Compatibility

przm Memory is an MCP (Model Context Protocol) server. It works with any client that supports the MCP standard. That includes:

- **Claude Code** (Anthropic's CLI and desktop app)
- **Claude.ai** (via MCP server configuration)
- **Cursor** (AI code editor)
- **Windsurf** (AI code editor)
- **Cline** (VS Code extension)
- **Continue** (VS Code / JetBrains extension)
- **Any MCP-compatible client** (the protocol is open and standardized)

If your tool can connect to an MCP server over stdio, przm Memory will work with it.

## Installation

> **Heads up — `@onenomad/przm-memory` publishes at v1.0.** The package isn't on npm yet. Until v1.0 lands, install from source (see [Source](#source) below). The `npx @onenomad/przm-memory` commands shown in this section will work after the v1.0 publish; nothing else changes about the install steps.

### Claude Code

```bash
claude mcp add engram -- npx @onenomad/przm-memory
```

### Claude Desktop

Add to your Claude Desktop config file. On macOS it's at `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/przm-memory"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Any MCP Client (Cursor, Windsurf, Cline, etc.)

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/przm-memory"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/OneNomad-LLC/przm-memory.git
cd przm-memory
npm install
npm run build
```

Then point your MCP client at `dist/server.js`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/server.js"]
    }
  }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | (none) | Enables LLM extraction and reranking via [OpenRouter](https://openrouter.ai). Pick any model provider you want. Without it, the system uses heuristic extraction and keyword/vector search only. |
| `MEM0_API_KEY` | (none) | Enables Mem0 cloud extraction as a second opinion |
| `ENGRAM_DATA_DIR` | `~/.claude/engram` | Where data gets stored |
| `ENGRAM_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model for embeddings |
| `ENGRAM_DEVICE` | `cpu` | Embedding device: `cpu`, `dml` (DirectML), or `cuda` |
| `ENGRAM_MODEL` | `anthropic/claude-haiku-4.5` | OpenRouter model ID for LLM features. Only used when `OPENROUTER_API_KEY` is set. Any model on [openrouter.ai](https://openrouter.ai) works. |
| `STORAGE_BACKEND` | `file` | Storage backend: `file` (LanceDB + filesystem, default), `postgres` (self-hosted multi-tenant), or `cloud` (przm Cloud Pro). See below. |
| `DATABASE_URL` | (none) | Postgres connection string. Required when `STORAGE_BACKEND=postgres`. |
| `TENANT_ID` | (none) | Tenant identifier — every row in postgres is scoped by this. Required when `STORAGE_BACKEND=postgres`. |
| `PYRE_API_URL` | (none) | przm server URL for `przm-memory login`. Alternative to the positional arg or `--server` flag — one of the three is required. |
| `PYRE_API_KEY` | (none) | przm Cloud API key. Overrides the field from `~/.pyre/credentials.json` when set. |
| `PYRE_CREDENTIALS_FILE` | `~/.pyre/credentials.json` | Override the credentials-file path (CI / headless installs). |
| `ENGRAM_NO_AUTO_CLOUD` | (unset) | Truthy (`1`/`true`/`yes`/`on`) suppresses the credentials-file probe so `~/.pyre/credentials.json` is ignored even when present. Use for benchmarks, CI, or anywhere you want to guarantee local file mode without deleting the file. Explicit `STORAGE_BACKEND` always wins. |

### Hosted (przm Cloud)

For przm Cloud Pro users:

```bash
npm install -g @onenomad/przm-memory
przm-memory login https://przm.sh
```

`login` requires the przm server URL. The binary ships with no hardcoded default — you point at whichever przm instance you're using (prod, staging, your own deployment). Three equivalent ways to supply it:

```bash
przm-memory login https://przm.sh          # positional argument
przm-memory login --server https://przm.sh # flag
PYRE_API_URL=https://przm.sh przm-memory login   # env var
```

`login` opens that URL in your browser, shows you a one-time pairing code, and waits for you to approve the device. On approval it writes `~/.pyre/credentials.json` (mode 0600) using the canonical `api_url` from the server's response — which may differ from the login URL you typed if the server normalises or redirects. From that point on przm Memory automatically routes through your cloud instance. Local data stays local; nothing changes for users who don't run `login`.

```
$ przm-memory login https://przm.sh
Open this URL in your browser to authorize:

  https://przm.sh/connect

Enter this code when prompted: PYRE-7K4M-9N2X
(waiting for approval — Ctrl+C to cancel)
Logged in. Credentials saved to ~/.pyre/credentials.json.
```

To sign out:

```bash
przm-memory logout
```

This deletes `~/.pyre/credentials.json` and reverts to local file mode on the next run. Idempotent — running it when you're already logged out exits 0.

**Where credentials live**

Credentials are stored at `~/.pyre/credentials.json` with mode `0600` (readable by you only). The file is a flat JSON object with `api_url`, `api_key`, `label`, `scopes`, and `issued_at`. Override the location with `PYRE_CREDENTIALS_FILE` if you have a multi-user setup.

**Headless / CI installs**

There's no terminal to open a browser from in CI. Skip `login` and set the env vars directly:

```bash
export STORAGE_BACKEND=cloud
export PYRE_API_URL=https://przm.sh
export PYRE_API_KEY=sk_pyre_xxx
```

When `STORAGE_BACKEND` is unset, przm Memory probes for `~/.pyre/credentials.json` and uses cloud mode if it finds one. Explicit env vars always win. The routing decision is logged to stderr on startup (`przm-memory: storage=cloud (auto-routed via ~/.pyre/credentials.json) · apiUrl=…`) so it's never silent — if you see a benchmark or local script hitting the wire when you expected local mode, that log line is the first place to look.

To force local file mode without deleting your credentials file (benchmarks, CI, local-only test runs against a real login), set `ENGRAM_NO_AUTO_CLOUD=1`. The probe is skipped, the credentials file is left alone, and the routing log line names the opt-out so it's visible to whoever inherits the environment.

The existing `STORAGE_BACKEND=postgres` self-host path (below) is unaffected — none of this changes anything for users running their own postgres instance.

### Cloud / multi-tenant mode

By default przm Memory stores everything locally under `ENGRAM_DATA_DIR` (LanceDB tables for chunks/daily_logs/rules/knowledge_triples, plus markdown files for diary and handoffs). For a single user on a single machine this is the right answer — fast, offline, zero dependencies.

For shared/cloud deployments where many users share one process, it also speaks postgres with [pgvector](https://github.com/pgvector/pgvector).

1. Provision a postgres database with the `vector` extension available.
2. Set environment variables:

   ```bash
   export STORAGE_BACKEND=postgres
   export DATABASE_URL=postgres://user:pass@host:5432/engram
   export TENANT_ID=<one-id-per-user>
   ```

3. Install the postgres driver (it's an `optionalDependency`, so file-mode users don't pull it in):

   ```bash
   npm install pg
   ```

4. Run the schema migrations against the database once:

   ```bash
   DATABASE_URL=postgres://... npx engram-migrate
   ```

   This creates the six tables (`chunks`, `daily_logs`, `rules`, `knowledge_triples`, `diary_entries`, `handoffs`), enables the `vector` extension, and adds the hot-path indexes (per-tenant created_at, ivfflat on chunks.embedding, etc.). The runner is idempotent — re-running is a no-op for already-applied files.

5. Boot przm Memory normally. Every query is scoped by `TENANT_ID`; switching tenants is just a different env var on a different process.

**Notes**

- pgvector required (`CREATE EXTENSION vector;`). The migration runs this for you when your DB role has the privileges; otherwise create it manually first.
- Embedding dimension is 384 by default (matches the local `Xenova/all-MiniLM-L6-v2` model). If you change `ENGRAM_EMBEDDING_MODEL` to one with a different dimensionality, edit `migrations/postgres/001_init.sql` before running migrations.
- Local file mode and postgres mode are **not** wire-compatible — there's no auto-import. If you're migrating an existing local install to the cloud, re-ingest is the path. Diary and handoffs in particular store different on-disk formats (markdown files vs. jsonb rows).
- Single user, single machine: stay on `file`. The postgres path exists for the hosted przm deployment and similar shared infra.

## Tools

The MCP server exposes 20 tools across six groups. Several earlier tools (`engram-format`, `engram-check-duplicate`, `engram-extract-rules`, `engram-taxonomy`, `engram-kg-stats`) were folded into their parent tools in 1.0.0-beta.6 — pass the relevant flag or mode to the parent instead. 1.0.0-beta.8 added the Handoff tools for cross-session continuity. 1.0.0 adds the memory origin field (user vs derived), the scratch tier, and `memory-scratch-promote`.

> **Backward compatibility:** tools were renamed from `engram-*` to `memory-*` in v1.0.0-beta.7. The server still registers `engram-*` aliases so existing installations keep working, but new configs should use `memory-*`. The aliases will be removed in v2.

### Core Memory

| Tool | What it does |
|------|-------------|
| `memory-search` | Hybrid ANN + keyword search with spreading activation. Supports a formatted output mode for prompt injection (replaces the old `engram-format`). |
| `memory-ingest` | Write-ahead log: immediately persist a memory before responding. Runs duplicate detection inline (replaces `engram-check-duplicate`). Defaults `origin='user'` since explicit ingest is user-asserted; pass `tier: 'scratch'` for session-only notes. |
| `memory-scratch-promote` | Graduate a scratch-tier memory to short-term so it survives the 24h auto-purge and enters the normal consolidation lifecycle. |
| `memory-extract` | Extract memories from a conversation (LLM or heuristic). Rules-only mode replaces the old `engram-extract-rules`. |
| `memory-maintain` | Run consolidation (decay, promote, link, merge, self-organize). Auto-describes unnamed memories, generates cross-links, and syncs the Persona procedural bridge when both servers are running. |
| `memory-rules` | Show active procedural rules |
| `memory-outcome` | Record recall feedback (helpful/corrected/irrelevant) |
| `memory-session` | Manage session state (hot RAM scratchpad) |
| `memory-stats` | Memory statistics by tier, layer, type. Includes KG stats, domain/topic taxonomy, and Persona bridge status (replaces `engram-kg-stats` and `engram-taxonomy`). |

### Knowledge Graph

| Tool | What it does |
|------|-------------|
| `memory-kg-add` | Add a subject-predicate-object triple |
| `memory-kg-query` | Query triples with optional filters |
| `memory-kg-invalidate` | Mark a fact as no longer valid |
| `memory-kg-timeline` | Get chronological history of an entity |

### Diary

| Tool | What it does |
|------|-------------|
| `memory-diary-write` | Write a session diary entry |
| `memory-diary-read` | Read diary entries by date or range |

### Handoff (cross-session continuity)

| Tool | What it does |
|------|-------------|
| `memory-handoff-write` | Structured "where we left off" snapshot — currentTask, completed, nextSteps, openQuestions, fileRefs, decisions, notes. Written before compaction or session end so a fresh session can resume without re-explanation. |
| `memory-handoff-read` | Load the latest handoff (or one by stamp; `list=true` for recent stamps). Call at session start to pick up where the prior session left off. |
| `memory-context-pressure` | Self-assess context window pressure (`ok`/`warm`/`hot`/`critical`) and receive a deterministic action plan — when to save memories, when to write a handoff, when to invoke `/compact`. Pass `phaseBoundary=true` at natural task/phase boundaries to force a proactive compact regardless of level (pivots thrash the cache anyway — compacting at the boundary is a free lunch). |

### Governance

| Tool | What it does |
|------|-------------|
| `memory-govern` | Run governance checks: contradiction detection (vector + heuristic + LLM), semantic drift monitoring, and memory poisoning detection. All advisory — flags issues without auto-deleting. |

### Import

| Tool | What it does |
|------|-------------|
| `memory-import` | Bulk import from Claude Code JSONL, ChatGPT JSON, or plain text |

## Slash Commands

These work in any MCP-compatible client (Claude Code, Cursor, etc.). The MCP server advertises them in its instructions so the agent knows how to handle them. SKILL.md files are also included for platforms that discover skills from the filesystem.

| Command | What it does |
|---------|-------------|
| `/memory-source <engram\|off\|hybrid>` | Switch memory backend. "engram" uses przm Memory exclusively, "off" disables all persistent memory, "hybrid" runs przm Memory alongside native client memory. |
| `/recall <query>` | Search memories using the full hybrid pipeline (vector + keyword + temporal + KG + spreading activation). Results presented conversationally. |
| `/forget <what>` | Find and remove or correct specific memories. Shows matches and confirms before acting. |
| `/memory-health [maintain]` | Show memory system stats (tiers, layers, rules, KG size). With "maintain", runs the full consolidation cycle. |
| `/memory-api <key>` | Set or update the OpenRouter API key that unlocks LLM extraction, reranking, and procedural-rule learning. |
| `/knowledge <subcommand>` | Knowledge graph operations. Subcommands: `timeline <entity>`, `about <entity>`, `add <s> <p> <o>`, `correct <s> <p>`, `stats`. |
| `/memory <subcommand>` | Quick ops. Subcommands: `save <content>`, `diary [date]`, `diary write <entry>`, `import <source>`, `rules`, `session [show\|clear]`. |

### Installing Slash Commands for Claude Code

The slash commands above are advertised in the MCP server instructions and work automatically in most clients. For Claude Code specifically, you can also install them as custom commands so they show up in the `/` command menu:

```bash
# From the engram directory
bash install-commands.sh

# To overwrite existing commands
bash install-commands.sh --force
```

This copies command files to `~/.claude/commands/` where Claude Code picks them up globally. After installing, type `/` in Claude Code to see them in the command list.

## Architecture

```
Conversations --> Extract --> LanceDB (vectors + metadata)
                    |                       |
              KG Auto-Populate   +----------+----------+
              (12 rel types)     |          |          |
                            Vector ANN  IDF Keywords  Time Windows
                                 |          |          |
                                 +----+-----+-----+----+
                                      |           |
                                 KG Temporal   Spreading
                                   Lookup     Activation
                                      |           |
                                      +-----+-----+
                                            |
                                      Score + Rank
                                            |
                                    Token Budget Cap
                                            |
                                   Governance Checks
                                   (advisory, async)
                                            |
                                   Format for Prompt

                         Adaptive Forgetting
                    (semantic proximity modulates decay)
                                  |
              Persona Bridge <--> Procedural Rules
              (emotion-weighted    (confidence-scored,
               importance,          learned from
               cognitive load)      corrections)
```

### Data Storage

Everything lives locally:

```
~/.claude/engram/
├── SESSION-STATE.md      # Hot RAM scratchpad
├── diary/                # Daily diary entries
│   └── YYYY-MM-DD.md
├── handoffs/             # Cross-session "where we left off" snapshots
│   ├── YYYY-MM-DD_HH-MM-SS.json
│   └── YYYY-MM-DD_HH-MM-SS.md
└── lance/                # LanceDB tables
    ├── chunks.lance/     # Memory chunks with embeddings
    ├── daily_logs.lance/ # Extraction logs
    ├── rules.lance/      # Procedural rules
    └── knowledge_triples.lance/
```

### Dependencies

- **LanceDB** for the embedded vector database, handles ANN search natively
- **@huggingface/transformers** for local embedding inference (Xenova/all-MiniLM-L6-v2, 384 dimensions, 23MB)
- **openai** (optional) for LLM-powered extraction and reranking via OpenRouter
- **mem0ai** (optional) for Mem0 cloud extraction
- **@modelcontextprotocol/sdk** for the MCP server protocol

## Benchmarks

Clone the repo, install, fetch the public datasets, run the whole suite:

```bash
git clone https://github.com/OneNomad-LLC/przm-memory.git
cd przm-memory
npm install
bash benchmarks/download-datasets.sh
npm run bench:all
```

That's it. Every benchmark writes a JSON result file into `benchmarks/results/` and a consolidated table prints at the end. Missing datasets get skipped, not failed — partial runs are valid. No API keys are required for the default configuration.

For full methodology, dataset citations, and reproducibility steps, see [BENCHMARKS.md](BENCHMARKS.md).

### Our scores at HEAD

| Benchmark | Metric | Score | Hardware | Notes |
|-----------|-------|------|----------|-------|
| LongMemEval (500 Q) | R@5 | **96.8%** | Windows / Radeon RX 9070 XT (DML) | Zero-API, verified 2026-05-16 |
| LongMemEval (500 Q) | R@10 | **98.8%** | Windows / Radeon RX 9070 XT (DML) | Zero-API, verified 2026-05-16 |
| LongMemEval (500 Q) | p50 latency | **44ms** | Windows / Radeon RX 9070 XT (DML) | Local LanceDB, zero API roundtrips |
| LoCoMo (1,986 QA) | R@10 | **91.9%** | Windows / Radeon RX 9070 XT (DML) | Zero-API, verified 2026-05-16 — beats MemPalace hybrid v5 (88.9%) by +3.0pp |
| LoCoMo (1,986 QA) | R@5 | **85.5%** | Windows / Radeon RX 9070 XT (DML) | Zero-API, verified 2026-05-16 |
| LoCoMo (1,986 QA) | p50 latency | **~150ms** | Windows / Radeon RX 9070 XT (DML) | Local LanceDB, zero API roundtrips |

The committed LongMemEval result JSON is at [`benchmarks/results/published/longmemeval-2026-05-16.json`](benchmarks/results/published/longmemeval-2026-05-16.json) — pins the exact commit, embedding model, per-category breakdown, and latency percentiles. The previous 96.0% baseline lives at `longmemeval-2026-05-15.json`; the +0.8pp improvement came from a temporal date-anchor fix and aggregation-query candidate-pool widening. Reproduce with `npm run bench:longmemeval`. LoCoMo numbers are awaiting re-verification on the post-fix code path; the re-run will land in `published/` when complete.

A note on the methodology fixes that landed alongside this verification:

- **`recallAtK` no longer auto-passes questions with empty `answer_session_ids`.** Previously, such questions counted as a hit (inflating R@5 by ~3pp on LongMemEval); they're now excluded from the denominator. The verified 96.0% R@5 reflects this correction.
- **The benchmark ingest path now applies `buildContextPrefix()` at ingest** to match the query-side prefix in `src/search.ts`. Without symmetric prefixes, embedding spaces drift apart and recall collapses to chance (~12% R@5 in a pre-fix run); fixing this restored honest measurement.
- **The benchmark forces `STORAGE_BACKEND=file`** at module load. Without it, `Storage(dataDir)` silently auto-routes to przm Cloud when a credentials file exists, mixing the bench's chunks with cloud-tenant data and destroying isolation. The bench now runs purely local.

### LoCoMo

[Snap Research's LoCoMo](https://github.com/snap-research/locomo) — 1,986 multi-hop QA pairs across 10 long synthetic conversations. We score Recall@5 and Recall@10 with the full hybrid retrieval pipeline. A retrieved session counts as a hit if it contains any of the evidence dialog IDs for the question.

Categories: `single-hop`, `temporal`, `temporal-inference`, `open-domain`, `adversarial`.

```bash
npm run bench:locomo                    # full run
npm run bench:locomo -- --limit 200     # quick subset
npm run bench:locomo -- --rerank        # with LLM rerank (needs OPENROUTER_API_KEY)
npm run bench:locomo -- --verbose
```

Runtime: ~3–5 min on an M-series Mac. Paper: [Maharana et al., 2024](https://arxiv.org/abs/2402.17753).

### LongMemEval

[LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) — 500 questions across six types, ~53 candidate sessions per question. We score Recall@5 / @10 and NDCG@5 / @10. Binary recall — at least one answer session in the top K.

```bash
npm run bench:longmemeval
npm run bench:longmemeval -- --limit 50
npm run bench:longmemeval -- --rerank
```

Runtime: ~6–10 min for the full 500 on an M-series Mac. The dataset is ~277 MB. Paper: [Wu et al., 2024](https://arxiv.org/abs/2410.10813).

### przm Memory synthetic suite (`bench`)

A self-contained 15-question battery covering single-fact recall, preferences, temporal reasoning, knowledge updates, and adversarial / distractor resistance. No dataset download. Exits non-zero when R@5 drops below 70% — used as the pre-merge regression gate.

```bash
npm run bench
npm run bench:verbose
```

Runtime: ~30 sec. Self-contained — runs on a clean clone with no flags.

### Ingest throughput

Pushes N synthetic chunks (default 10,000) through `wal.ingest()` and reports chunks/sec. Two modes: `cold` (fresh data dir) and `warm` (10k chunks pre-loaded). The bench waits for background side-effects to drain before stopping the clock, so the number is "fully persisted" not "queued." KG extraction is skipped to keep the bench API-key-free.

```bash
npm run bench:throughput
npm run bench:throughput -- --chunks 5000 --mode warm
```

Runtime: ~1–3 min at default settings.

### Query latency

Loads N synthetic chunks (default 10,000), runs M queries (default 1,000) sequentially, and reports p50 / p95 / p99 latency per query bucket (`short` keyword queries, `medium` single-sentence questions, `long` multi-clause questions). Wall-clock is measured around the full `search()` call — the same path `engram-search` hits at the MCP boundary.

```bash
npm run bench:latency
npm run bench:latency -- --chunks 5000 --queries 500
npm run bench:latency -- --topk 5
```

Runtime: ~2–4 min at default settings.

## Security

### Network calls

This plugin contacts exactly two services:

1. **HuggingFace Hub** for a one-time model download on first run (~23MB), cached after that
2. **Mem0 API**, only when `extractionProvider` is `mem0` or `both`

If you set `OPENROUTER_API_KEY`, it contacts the OpenRouter API for LLM features (you pick the model provider). Without any API keys, everything runs fully local.

No telemetry. No analytics. No phoning home.

### Local storage

All memory data stays on disk at `~/.claude/engram/`. Nothing gets sent anywhere unless you explicitly configure an external provider.

## Use Cases

Here are some real situations where this makes a difference.

**Personal AI assistant.** The most obvious one. You talk to an AI every day and it forgets everything between sessions. przm Memory fixes that. It learns your preferences, remembers your projects, picks up your corrections, and builds a picture of who you are over time. Instead of re-explaining yourself every conversation, the agent just knows.

**Developer tools.** If you use Claude Code, Cursor, or any AI coding tool, the agent forgets your codebase conventions, your preferred patterns, and the decisions you've already made. przm Memory picks up things like "always use explicit return types" or "we deploy to Vercel, not AWS" and carries them forward. Procedural rules are built for this.

**Customer support agents.** A support bot that actually remembers a customer's history, past issues, and preferences without needing to query a CRM every time. The knowledge graph handles entity relationships ("Customer X uses Plan Y, started in March") and temporal queries let the agent reason about timelines.

**Research and note-taking.** If you use an AI to research topics over multiple sessions, przm Memory lets it build on previous findings instead of starting from scratch. The diary system logs what happened each session, and the search pipeline surfaces relevant prior research when you come back to a topic.

**Multi-agent systems.** Multiple agents can share the same memory store. One agent handles research, another handles coding, and they both read from and write to the same LanceDB. The MCP protocol makes this straightforward since any MCP-compatible client can connect to the server.

**Therapy / coaching bots.** Sensitive use case, but a good one. An AI that remembers what you talked about last week, tracks your goals, and notices patterns in your behavior over time. The tier lifecycle naturally keeps recent context hot while letting older sessions fade unless they stay relevant.

## Pairs Well With: przm Voice (persona)

If przm Memory is the brain, [przm Voice](https://github.com/OneNomad-LLC/przm-voice) (technical handle: `persona`) is the personality.

przm Memory handles *what* the agent remembers: facts, preferences, rules, timelines. przm Voice handles *how* the agent communicates: tone, verbosity, format preferences, and communication style. They solve different problems but work best together.

Here's why the combo matters. przm Memory will learn that you prefer TypeScript over Python. przm Voice will learn that you want short answers with code first and explanation after. przm Memory will store the fact that you got laid off last month. przm Voice will know not to bring that up casually based on the emotional context it picked up.

przm Voice tracks behavioral signals (corrections, approvals, frustrations, praise) and builds a communication profile that adapts over time. The procedural rules surface here overlaps a little ("never use em-dashes"), but Voice goes deeper into *how* the agent should talk to you specifically. Things like matching your energy level, knowing when to be terse vs. when to elaborate, and adjusting formality based on the topic.

When both servers are running, they coordinate through three mechanisms:

1. **Emotion-weighted memory importance.** Memory calls `persona_state` during ingestion to get the current emotional valence and arousal. High-arousal negative emotions boost memory importance by up to 30%. A frustrated correction gets remembered more strongly than a neutral fact.

2. **Cognitive-load-gated search.** When Voice detects cognitive overload, Memory's `engram-search` receives the load signal and returns only the top 3 high-importance memories instead of the full result set. Less noise when you're already overwhelmed.

3. **Procedural bridge.** Memory's learned rules (from corrections and instructions) and Voice's applied evolution proposals sync through a shared bridge file at `~/.claude/procedural-bridge.json`. Voice's applied proposals reinforce or create Memory rules. Memory rules become Voice proposals with semantic conflict detection against existing soul files — catches antonym pairs and value contradictions, not just exact duplicates. The bridge auto-syncs during `persona_consolidate`, and bridge health is visible via `persona_stats`.

You can run Memory without Voice and it works fine. But if you want an AI that actually feels like it knows you, not just what you've told it, but how you like to be talked to, run both.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

Copyright (c) 2026 Matt Stvartak / OneNomad LLC.

Use it, fork it, ship it. The full terms are in the [LICENSE](LICENSE) file.

For inquiries: **matt@onenomad.dev**
