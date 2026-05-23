---
name: memory
description: "Quick memory operations: save something, check for duplicates, view diary, or import memories from other sources. Use when the user says /memory, wants to save something specific, import from ChatGPT/Claude, or view session diary entries."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Memory

Quick memory operations.

## Usage

```
/memory <subcommand> [args]
```

**Subcommands:**

- `/memory save <content>` - Save a specific memory right now
- `/memory diary [date]` - View diary entries (today if no date)
- `/memory diary write <entry>` - Write a diary entry
- `/memory import <source>` - Import memories from external sources
- `/memory rules` - View active procedural rules
- `/memory session [show|clear]` - View or clear the session scratchpad

## Behavior

### save
Call `memory-ingest` with the content (duplicate detection runs inline). Let the user know it's saved.

### diary
Call `memory-diary-read` with the date (or today). Present entries chronologically.

### diary write
Call `memory-diary-write` with the entry content.

### import
Ask the user for the file path and format:
- Claude Code JSONL (exported conversation history)
- ChatGPT JSON (exported from OpenAI)
- Plain text (one memory per line or paragraph)

Call `memory-import` with the file path and format.

### rules
Call `memory-rules`. Show active procedural rules with their confidence scores and domains. Flag any low-confidence rules that might need reinforcement or removal.

### session
Call `memory-session` with show or clear. The session scratchpad is hot RAM for the current working context. Show it formatted, or clear it at end of session.
