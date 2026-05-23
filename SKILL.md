---
name: przm-memory
description: Intelligent memory manager with LLM-powered extraction, hybrid ANN vector+keyword search, tier lifecycle, spreading activation, procedural rules, WAL capture, and session-state hot RAM. Use when the user asks about memory, preferences, or past conversations.
homepage: https://github.com/OneNomad-LLC/przm-memory
metadata: {"version":"1.0.0-beta.7","categories":["memory","intelligence","personalization"]}
---

# przm Memory

An intelligent memory system that automatically extracts, stores, searches, and maintains memories from conversations. Inspired by cognitive science research on memory consolidation, spreading activation, and reconsolidation.

## How It Works

### Memory Extraction
After conversations, pipe the messages through the `extract` command. An LLM classifies each extracted memory by:
- **Type**: fact, preference, decision, context, correction
- **Cognitive Layer**: episodic (events), semantic (enduring facts), procedural (rules)
- **Importance**: 0.0-1.0 scale (conservative -- most memories are 0.3-0.6)
- **Sentiment**: frustrated, curious, satisfied, neutral, excited, confused

### Memory Search (Hybrid)
Search combines multiple signals:
1. **Vector similarity** -- embedding-based semantic matching
2. **Keyword matching** -- word-boundary regex (avoids "test" matching "contest")
3. **Recency bonus** -- newer memories score higher
4. **Frequency bonus** -- frequently recalled memories score higher
5. **Importance bonus** -- high-importance memories get a boost
6. **Spreading activation** -- walks the memory graph to find related memories not directly matching the query (Collins & Loftus 1975)

### Tier Lifecycle
- **Daily** (2 days) -> auto-moves to short-term if importance >= 0.3
- **Short-term** (14 days) -> promotes to long-term if recalled frequently or high importance
- **Long-term** (90 days) -> demotes to archive if stale and low importance
- **Archive** -> reactivates if recalled again within 7 days

### Procedural Rules
Learns behavioral rules from user corrections and explicit instructions. Rules have:
- **Confidence** (0.0-1.0): reinforced by +0.1, contradicted by -0.2
- **Domain**: code, communication, workflow, preference, general
- Dead rules (confidence = 0) are pruned automatically

### Recall Outcomes
When you mark recalled memories as helpful/corrected/irrelevant:
- **Helpful**: importance +0.05, triggers reconsolidation
- **Corrected**: importance -0.10
- **Irrelevant**: importance -0.05
- Co-recalled helpful memories strengthen their graph edges

## Session State (Hot RAM)

A fast-write scratchpad for active session state that survives compaction. Persisted as `SESSION-STATE.md` for direct injection into the agent's system prompt.

## Configuration

Set `ENGRAM_DATA_DIR` to change the data directory (default: `~/.claude/engram`).
Optional: set `MEM0_API_KEY` environment variable if using Mem0 cloud extraction.
