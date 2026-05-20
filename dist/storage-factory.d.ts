/**
 * Storage backend factory.
 *
 * Resolution waterfall (top wins):
 *
 *   1. Explicit `STORAGE_BACKEND` env var (or `backend` opt).
 *      - `file`     → LanceDB + filesystem under dataDir.
 *      - `postgres` → pgvector + jsonb. Requires DATABASE_URL and TENANT_ID.
 *      - `cloud`    → przm Cloud HTTP. Requires PYRE_API_URL + PYRE_API_KEY
 *                     (or a valid `~/.pyre/credentials.json`).
 *      Missing accompanying env vars fail fast with a clear error.
 *
 *   2. `~/.pyre/credentials.json` present, parses cleanly, AND
 *      `ENGRAM_NO_AUTO_CLOUD` is not truthy → cloud backend using its
 *      `api_url` / `api_key`. Individual env vars override per-field:
 *      `PYRE_API_URL` beats the file's `api_url`, `PYRE_API_KEY` beats
 *      the file's `api_key`. The startup log line names this routing
 *      decision so it is never silent — previously this was the source
 *      of "why is my benchmark hitting the wire" surprises.
 *
 *   3. Fallback → `file` mode. Unchanged for any user with no
 *      credentials file and no env vars.
 *
 * Opt-out: set `ENGRAM_NO_AUTO_CLOUD=1` to skip step 2 entirely. Useful
 * for benchmarks, CI, local development against a real credentials file
 * you don't want consulted, and anywhere "explicit > implicit" matters.
 *
 * Corrupt credentials file: if the file exists but fails validation
 * (malformed JSON, missing fields), we fall through to file mode rather
 * than crashing the server. The validator logs a warning to stderr from
 * `readCredentials`; the routing log on this path notes the fallback.
 */
import type { StorageAdapter } from './storage-adapter.js';
export type StorageBackend = 'file' | 'postgres' | 'cloud';
export interface CreateStorageOptions {
    /** Data directory (used only in file mode). Required for file backend. */
    dataDir?: string;
    /** Explicit backend override. Defaults to STORAGE_BACKEND env, then the credentials-file probe, then 'file'. */
    backend?: StorageBackend;
    /** Override DATABASE_URL (postgres mode). */
    databaseUrl?: string;
    /** Override TENANT_ID (postgres mode). */
    tenantId?: string;
    /** Override embedding dimension. Defaults to ENGRAM_EMBEDDING_DIM or 384. */
    embeddingDim?: number;
    /** Override the przm Cloud API base URL (cloud mode). */
    apiUrl?: string;
    /** Override the przm Cloud API key (cloud mode). */
    apiKey?: string;
}
/**
 * Resolve which backend to use based on env vars and the presence of
 * a credentials file. See the module-level JSDoc for the full
 * three-tier waterfall.
 *
 * Pure-ish: reads env + filesystem (credentialsExist), no construction.
 * Used by callers that just want to know the resolved string. The full
 * cred-file validation happens in createStorageAdapter() so this stays
 * cheap.
 */
export declare function resolveBackend(explicit?: StorageBackend): StorageBackend;
/**
 * Create a StorageAdapter for the resolved backend.
 *
 * Async because the postgres and cloud backends dynamic-import their
 * driver modules (file-mode users shouldn't pay that cost). File mode
 * resolves immediately — no I/O until ensureReady().
 */
export declare function createStorageAdapter(opts?: CreateStorageOptions): Promise<StorageAdapter>;
