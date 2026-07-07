#!/usr/bin/env node

/**
 * przm Memory CLI router.
 *
 * Usage:
 *   przm-memory-mcp                                                 → run MCP stdio server (back-compat)
 *   przm-memory-mcp search --query <q> [--project <p>] [--limit N]
 *                     [--min-relevance F] [--format json|text]
 *   przm-memory-mcp query  [--project <p>] [--tier <t>]
 *                     [--min-importance F] [--limit N] [--format json|text]
 *   przm-memory-mcp help
 *
 * The CLI is additive — it wraps the same search/storage primitives the
 * MCP server uses so hook scripts can pull memories without speaking
 * stdio JSON-RPC.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { search, formatRecalledMemories } from './search.js';
import type { MemoryTier, SearchResult } from './types.js';
import type { StoredChunk } from './storage.js';

const HELP = `przm-memory-mcp — memory CLI

Usage:
  przm-memory-mcp                                              run MCP stdio server
  przm-memory-mcp search  --query <q> [opts]                   hybrid search
  przm-memory-mcp query   [opts]                               filter listing
  przm-memory-mcp reembed [--dry-run]                          re-embed all memories
                                                               with the active model
  przm-memory-mcp compact                                      prune old table versions,
                                                               reclaim disk
  przm-memory-mcp login   <server-url> | --server <url>        pair with przm Cloud
  przm-memory-mcp logout                                       remove cached credentials
  przm-memory-mcp help                                         this message

search options:
  --query <q>            (required) natural-language query
  --project <p>          filter by domain (project namespace)
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --limit <n>            max results (default 10)
  --min-relevance <f>    drop results with vector similarity < f (0..1)
  --format json|text     output mode (default json)
  --no-embed             skip embedding model load (keyword/IDF only,
                         ~1.5s faster cold-start, lower recall)

reembed options:
  --dry-run              report what would be re-embedded without writing
  Run this once after changing the embedding model (the server logs a
  warning at boot when stored vectors don't match the active model).

query options:
  --project <p>          filter by domain
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --tier <t>             daily | short-term | long-term | archive
  --layer <l>            episodic | semantic | procedural
  --min-importance <f>   drop chunks with importance < f (0..1)
  --limit <n>            max results (default 25)
  --format json|text     output mode (default json)

login options:
  <server-url>           (required) przm server URL, e.g. https://przm.sh
  --server <url>         alternative to the positional arg
                         (PYRE_API_URL env var also works)

Environment:
  PRZM_MEMORY_DATA_DIR   data directory (default ~/.claude/przm-memory;
                         legacy ENGRAM_DATA_DIR also honored)
  PRZM_MEMORY_EMBEDDING_MODEL
                         embedding model (default Xenova/bge-small-en-v1.5;
                         legacy ENGRAM_EMBEDDING_MODEL also honored)
  PYRE_API_URL           przm server server URL (login subcommand; alternative
                         to positional arg / --server flag)
  PYRE_CREDENTIALS_FILE  override ~/.pyre/credentials.json location
`;

type Format = 'json' | 'text';

const SEARCH_OPTS = {
  query:           { type: 'string' },
  project:         { type: 'string' },
  topic:           { type: 'string' },
  tag:             { type: 'string' },
  limit:           { type: 'string' },
  'min-relevance': { type: 'string' },
  format:          { type: 'string' },
  'no-embed':      { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

const LOGIN_OPTS = {
  server: { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

const QUERY_OPTS = {
  project:          { type: 'string' },
  topic:            { type: 'string' },
  tag:              { type: 'string' },
  tier:             { type: 'string' },
  layer:            { type: 'string' },
  'min-importance': { type: 'string' },
  limit:            { type: 'string' },
  format:           { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

function parseFloatOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    fail(`--${name} must be a number, got "${v}"`);
  }
  return n;
}

function parseIntOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    fail(`--${name} must be a non-negative integer, got "${v}"`);
  }
  return n;
}

function parseFormat(v: string | undefined): Format {
  if (v === undefined) return 'json';
  if (v !== 'json' && v !== 'text') fail(`--format must be json|text, got "${v}"`);
  return v;
}

function parseTier(v: string | undefined): MemoryTier | undefined {
  if (v === undefined) return undefined;
  const allowed: MemoryTier[] = ['daily', 'short-term', 'long-term', 'archive'];
  if (!allowed.includes(v as MemoryTier)) {
    fail(`--tier must be one of ${allowed.join('|')}, got "${v}"`);
  }
  return v as MemoryTier;
}

function fail(msg: string): never {
  process.stderr.write(`przm-memory-mcp: ${msg}\n`);
  process.exit(2);
}

function chunkToWire(c: StoredChunk) {
  return {
    id: c.id,
    content: c.content,
    type: c.type,
    layer: c.cognitiveLayer,
    tier: c.tier,
    domain: c.domain || undefined,
    topic: c.topic || undefined,
    tags: c.tags.length > 0 ? c.tags : undefined,
    source: c.source || undefined,
    importance: c.importance,
    createdAt: c.createdAt || undefined,
  };
}

async function runSearch(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: SEARCH_OPTS, allowPositionals: false });
  if (!values.query) fail('search: --query is required');

  const limit = parseIntOpt(values.limit, 'limit') ?? 10;
  const minRelevance = parseFloatOpt(values['min-relevance'], 'min-relevance') ?? 0;
  const format = parseFormat(values.format);

  if (values['no-embed']) {
    process.env.ENGRAM_SKIP_EMBED = '1';
  }

  const config = loadConfig();
  const storage = new Storage(config.dataDir);
  await storage.ensureReady();

  const filters: { domain?: string; topic?: string; tag?: string } = {};
  if (values.project) filters.domain = values.project;
  if (values.topic) filters.topic = values.topic;
  if (values.tag) filters.tag = values.tag;

  let results: SearchResult[] = [];
  try {
    results = await search(config, storage, values.query, limit, filters);
  } catch (err) {
    fail(`search failed: ${(err as Error).message}`);
  }

  // --min-relevance promises a 0..1 scale, which the composite score no
  // longer is under RRF (rank-fusion values top out near ~0.07). Filter
  // on the raw vector similarity when available; keyword-only results
  // (--no-embed) fall back to the composite score.
  const filtered = results
    .filter(r => (r.vectorSimilarity ?? r.score) >= minRelevance)
    .slice(0, limit);

  if (format === 'text') {
    process.stdout.write(formatRecalledMemories(filtered));
    return;
  }

  process.stdout.write(JSON.stringify({
    total: results.length,
    returned: filtered.length,
    results: filtered.map(r => ({
      ...chunkToWire(r.chunk as StoredChunk),
      score: Math.round(r.score * 1000) / 1000,
      ...(r.vectorSimilarity !== undefined
        ? { similarity: Math.round(r.vectorSimilarity * 1000) / 1000 }
        : {}),
    })),
  }, null, 2) + '\n');
}

async function runQuery(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: QUERY_OPTS, allowPositionals: false });

  const limit = parseIntOpt(values.limit, 'limit') ?? 25;
  const minImportance = parseFloatOpt(values['min-importance'], 'min-importance') ?? 0;
  const format = parseFormat(values.format);
  const tier = parseTier(values.tier);

  const config = loadConfig();
  const storage = new Storage(config.dataDir);
  await storage.ensureReady();

  const opts: Parameters<Storage['listChunks']>[0] = {};
  if (tier) opts.tier = tier;
  else opts.excludeTiers = ['archive'];
  if (values.layer) opts.cognitiveLayer = values.layer;
  if (values.project) opts.domain = values.project;
  if (values.topic) opts.topic = values.topic;
  if (values.tag) opts.tag = values.tag;

  let chunks: StoredChunk[] = [];
  try {
    chunks = await storage.listChunks(opts);
  } catch (err) {
    fail(`query failed: ${(err as Error).message}`);
  }

  const filtered = chunks
    .filter(c => c.importance >= minImportance)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit);

  if (format === 'text') {
    const fakeResults: SearchResult[] = filtered.map(c => ({ chunk: c, score: c.importance }));
    process.stdout.write(formatRecalledMemories(fakeResults));
    return;
  }

  process.stdout.write(JSON.stringify({
    total: chunks.length,
    returned: filtered.length,
    results: filtered.map(chunkToWire),
  }, null, 2) + '\n');
}

async function runReembed(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' } } as const,
    allowPositionals: false,
  });

  const config = loadConfig();
  const storage = new Storage(config.dataDir);
  await storage.ensureReady();

  const { getEmbeddingModelName } = await import('./llm.js');
  const { readEmbeddingMeta, reembedAll } = await import('./reembed.js');

  const current = getEmbeddingModelName();
  const meta = readEmbeddingMeta(config.dataDir);
  process.stderr.write(`przm-memory-mcp: active model  ${current}\n`);
  process.stderr.write(`przm-memory-mcp: corpus model  ${meta?.model ?? '(unknown — pre-marker store)'}\n`);

  const chunks = await storage.listChunks();
  const targets = chunks.filter(c => c.consolidationLevel !== -1);

  if (values['dry-run']) {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      activeModel: current,
      corpusModel: meta?.model ?? null,
      wouldReembed: targets.length,
    }, null, 2) + '\n');
    return;
  }

  // Preflight: embed a probe and make sure the produced dimension matches
  // what's already stored. A mismatched write corrupts the vector column;
  // fail with instructions instead.
  const { embed } = await import('./llm.js');
  const probe = await embed(config, 'dimension probe');
  if (probe.length === 0) {
    fail('embedding model failed to load — cannot re-embed');
  }
  const sample = targets.find(c => c.embedding && c.embedding.length > 0);
  if (sample?.embedding && sample.embedding.length !== probe.length) {
    fail(
      `dimension mismatch: stored vectors are ${sample.embedding.length}-dim but the active model ` +
      `produces ${probe.length}-dim. The vector column width is fixed at table creation. ` +
      `Either set ENGRAM_EMBEDDING_DIM=${sample.embedding.length} (Matryoshka truncation, ` +
      `valid only for MRL-trained models) or export + re-import into a fresh data dir.`
    );
  }

  process.stderr.write(`przm-memory-mcp: re-embedding ${targets.length} memories...\n`);
  const started = Date.now();
  const stats = await reembedAll(config, storage, (done, total) => {
    process.stderr.write(`przm-memory-mcp: ${done}/${total}\n`);
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  process.stdout.write(JSON.stringify({ ...stats, model: current, seconds: Number(seconds) }, null, 2) + '\n');
  if (stats.failed > 0) {
    process.stderr.write(
      `przm-memory-mcp: ${stats.failed} chunks failed — marker not updated, boot warning stays. Re-run to retry.\n`
    );
    process.exit(1);
  }
  process.stderr.write(`przm-memory-mcp: done in ${seconds}s — corpus now in ${current} space\n`);
}

async function runCompact(argv: string[]): Promise<void> {
  parseArgs({ args: argv, options: {}, allowPositionals: false });

  const config = loadConfig();
  const storage = new Storage(config.dataDir);
  await storage.ensureReady();

  // Prune every non-current version. Single-process CLI op, so
  // deleteUnverified is safe. Reclaims the fragment/version bloat that
  // per-row writes (recall stats, pre-batch reembed) accumulate over time.
  process.stderr.write('przm-memory-mcp: compacting chunk table (pruning old versions)...\n');
  const started = Date.now();
  await storage.optimizeChunks(0, true);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  process.stdout.write(JSON.stringify({ compacted: true, seconds: Number(seconds) }, null, 2) + '\n');
  process.stderr.write(`przm-memory-mcp: done in ${seconds}s — run \`du -sh <dataDir>/lance\` to see reclaimed space\n`);
}

async function runLoginCmd(argv: string[]): Promise<void> {
  // Server URL is required.  Accept three sources, in precedence:
  //   1. Positional arg: przm-memory-mcp login https://...
  //   2. --server flag:  przm-memory-mcp login --server https://...
  //   3. PYRE_API_URL env var.
  // If none supplied -- exit 1 with the spec'd message. No defaults
  // are baked in; this binary works against any przm server instance the
  // user points at.
  const { values, positionals } = parseArgs({ args: argv, options: LOGIN_OPTS, allowPositionals: true });
  const { resolveServerUrl, runLogin } = await import('./auth/login.js');
  const apiUrl = resolveServerUrl({ positional: positionals[0], flag: values.server });
  if (!apiUrl) {
    process.stderr.write('Server URL required. Pass it as an argument or set PYRE_API_URL.\n');
    process.exit(1);
  }
  const code = await runLogin({ apiUrl });
  process.exit(code);
}

async function runLogoutCmd(argv: string[]): Promise<void> {
  // Accept no flags today — but parse anyway so `--help` etc. don't
  // silently become positional args.
  parseArgs({ args: argv, options: {}, allowPositionals: false });
  const { runLogout } = await import('./auth/login.js');
  process.exit(runLogout());
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  if (!sub || sub.startsWith('-')) {
    // Back-compat: bare invocation runs the MCP stdio server.
    await import('./server.js');
    return;
  }

  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    case 'search':
      await runSearch(rest);
      return;
    case 'query':
      await runQuery(rest);
      return;
    case 'reembed':
      await runReembed(rest);
      return;
    case 'compact':
      await runCompact(rest);
      return;
    case 'login':
      await runLoginCmd(rest);
      return;
    case 'logout':
      await runLogoutCmd(rest);
      return;
    default:
      process.stderr.write(`przm-memory-mcp: unknown subcommand "${sub}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch(err => {
  process.stderr.write(`przm-memory-mcp: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
