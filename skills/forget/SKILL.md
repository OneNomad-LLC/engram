---
name: forget
description: "Remove or correct specific memories. Use when the user says /forget, 'forget that', 'that's wrong', 'delete that memory', or wants to correct something przm Memory remembers incorrectly."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Forget

Remove, correct, or archive specific memories.

## Usage

```
/forget <what to forget>
```

## Behavior

1. Search for memories matching what the user wants removed using `memory-search`
2. Show the user what was found and confirm before taking action
3. For corrections: use `memory-outcome` with type "corrected" on the wrong memory, then `memory-ingest` the corrected version
4. For deletions: use `memory-outcome` with type "irrelevant" to heavily demote the memory. Mark it multiple times if needed to push it toward archival.
5. For knowledge graph facts that are wrong: use `memory-kg-invalidate` to mark the fact as no longer valid, then `memory-kg-add` the correct fact if applicable
6. For procedural rules that are wrong: note the contradiction so the rule's confidence drops

## Important

Always confirm with the user before acting. Show them exactly which memories you found so they can pick which ones to remove or correct. Don't delete blindly.

If the user says "forget everything about X" be extra careful. Confirm the scope.
