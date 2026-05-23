---
name: knowledge
description: "View and manage the knowledge graph: entities, relationships, and timelines. Use when the user says /knowledge, asks about entity relationships ('who works where', 'what tools do I use'), or wants to see the timeline of a specific entity."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Knowledge

Explore and manage the knowledge graph.

## Usage

```
/knowledge <subcommand> [args]
```

**Subcommands:**

- `/knowledge timeline <entity>` - Show chronological history of an entity
- `/knowledge about <entity>` - Show all current facts about an entity
- `/knowledge add <subject> <predicate> <object>` - Add a new fact
- `/knowledge correct <subject> <predicate>` - Fix a wrong fact (invalidates old, prompts for new)
- `/knowledge stats` - Knowledge graph overview

## Behavior

### timeline
Call `memory-kg-timeline` for the entity. Present results chronologically with valid-from/valid-to dates. Show both current and historical facts so the user can see how things changed over time.

### about
Call `memory-kg-query` filtered to the entity as subject. Show all currently valid triples in a readable format. Group by predicate type if there are many.

### add
Call `memory-kg-add` with the triple. Confirm what was added. If the fact contradicts an existing one (e.g., user already "works-at" somewhere else), ask if the old fact should be invalidated.

### correct
Search for existing triples matching the subject and predicate. Show them. Ask the user what the correct value is. Invalidate the old triple with `memory-kg-invalidate` and add the new one with `memory-kg-add`.

### stats
Call `memory-stats`. Show entity count, triple count, active vs invalidated, and most connected entities.
