---
name: memory-api
description: "Set or update the OpenRouter API key for przm Memory's LLM features (extraction, reranking, procedural rules). Use when the user says /memory-api, wants to configure their API key, or asks about enabling LLM features."
user-invocable: true
metadata: {"version":"1.0.0-beta.2"}
---

# Memory API

Set the OpenRouter API key for LLM-powered features.

## Usage

```
/memory-api <key>
```

## Behavior

1. Take the provided API key
2. Find the przm Memory MCP server's `.mcp.json` configuration file
3. Update the `OPENROUTER_API_KEY` value in the env section
4. Tell the user to run `/reload-plugins` for the change to take effect
5. Confirm the key was set (show only the last 4 characters for security)
6. If no key is provided, show current status (key set or not, last 4 chars if set)

## Notes

- The key is stored locally in the plugin cache, never committed to git
- Get a key at https://openrouter.ai/keys
- Without a key, przm Memory still works but falls back to heuristic extraction and keyword/vector search only
- With a key, you get LLM-powered memory extraction, reranking, procedural rule detection, and reconsolidation
- Default model is anthropic/claude-haiku-4.5. Override with `ENGRAM_MODEL` env var in the same .mcp.json file
