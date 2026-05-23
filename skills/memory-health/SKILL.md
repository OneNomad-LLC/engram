---
name: memory-health
description: "Show memory system health, statistics, and maintenance status. Use when the user says /memory-health, asks about memory stats, wants to know how many memories are stored, or wants to run maintenance."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Memory Health

Check on the memory system and run maintenance.

## Usage

```
/memory-health [maintain]
```

## Behavior

### Default (no args): Show health overview

1. Call `memory-stats` for tier/layer/type breakdown (includes KG stats)
2. Call `memory-rules` for active procedural rule count
4. Present a clean summary:
   - Total memories by tier (daily / short-term / long-term / archive)
   - Cognitive layer breakdown (episodic / semantic / procedural)
   - Active procedural rules count
   - Knowledge graph: entities, triples, active vs invalidated
   - Last maintenance run (if available)
   - Any warnings (high archive count suggests stale data, low procedural rules means the system hasn't learned much yet)

### With `maintain`: Run consolidation

1. Call `memory-maintain` to trigger the full consolidation cycle
2. This runs: importance decay, tier promotion/demotion, duplicate detection and merging, stale memory archival, and graph edge cleanup
3. Report what changed

## Formatting

Present stats in a clean, readable format. Don't just dump JSON. Highlight anything unusual or noteworthy.
