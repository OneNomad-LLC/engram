---
name: recall
description: "Search and surface memories about a topic, person, event, or time period. Use when the user says /recall or asks 'what do you know about X', 'what did I tell you about X', 'do you remember X'. Searches przm Memory's hybrid pipeline (vector + keyword + temporal + knowledge graph + spreading activation)."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Recall

Search memories about anything the user asks.

## Usage

```
/recall <query>
```

## Behavior

1. Call `memory-search` with the user's query
2. If the query mentions a specific time ("last week", "in March", "before I switched jobs"), the temporal pipeline will handle it automatically
3. If the query mentions a person or entity, the knowledge graph lookup kicks in
4. Present results naturally in conversation, not as a raw dump
5. If no results, say so honestly. Don't make things up.
6. If results seem stale or wrong, ask the user if they want to correct them (use `memory-outcome` with "corrected")

## Examples

- `/recall TypeScript preferences` - What does przm Memory know about the user's TypeScript opinions?
- `/recall what was I working on in January` - Temporal search for January activities
- `/recall Matt's job history` - Knowledge graph entity lookup with timeline
- `/recall deployment process` - Procedural rules and facts about how the user deploys

## Formatting

Keep it conversational. Group related memories together. If there are procedural rules relevant to the query, call those out specifically since they represent things the user explicitly told you to do or avoid.
