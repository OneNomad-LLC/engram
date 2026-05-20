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
import { FileStorageAdapter } from './storage-file.js';
import { readCredentials, credentialsExist } from './auth/credentials.js';
/**
 * Best-effort startup log to stderr. Stdout is reserved for the MCP
 * stdio protocol — writing routing decisions there would corrupt the
 * frame. Failures swallowed silently because the process should always
 * boot even if stderr is closed (e.g. some hosted environments).
 */
function logRouting(message) {
    try {
        process.stderr.write(`przm-memory: ${message}\n`);
    }
    catch {
        // ignore
    }
}
function isTruthyEnv(value) {
    if (!value)
        return false;
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
export function resolveBackend(explicit) {
    if (explicit)
        return explicit;
    const v = (process.env.STORAGE_BACKEND ?? '').trim().toLowerCase();
    if (v === 'postgres')
        return 'postgres';
    if (v === 'cloud')
        return 'cloud';
    if (v === 'file')
        return 'file';
    if (v !== '') {
        throw new Error(`Unknown STORAGE_BACKEND='${v}'. Expected 'file', 'postgres', or 'cloud'.`);
    }
    // No explicit setting — probe for a credentials file unless the user
    // has opted out. Mirrors the createStorageAdapter logic so both
    // entrypoints agree on the resolved backend.
    if (isTruthyEnv(process.env.ENGRAM_NO_AUTO_CLOUD))
        return 'file';
    if (credentialsExist())
        return 'cloud';
    return 'file';
}
/**
 * Create a StorageAdapter for the resolved backend.
 *
 * Async because the postgres and cloud backends dynamic-import their
 * driver modules (file-mode users shouldn't pay that cost). File mode
 * resolves immediately — no I/O until ensureReady().
 */
export async function createStorageAdapter(opts = {}) {
    // Explicit backend: respect it, log it, fail fast if required env vars
    // are missing. Order matters — explicit always wins over auto-routing.
    const explicit = opts.backend ?? normalizeBackend(process.env.STORAGE_BACKEND);
    if (explicit === 'file') {
        return createFile(opts, 'STORAGE_BACKEND=file');
    }
    if (explicit === 'postgres') {
        return createPostgres(opts);
    }
    if (explicit === 'cloud') {
        return createCloud(opts, 'STORAGE_BACKEND=cloud');
    }
    // No explicit backend. Try the credentials-file probe unless opted out.
    if (!isTruthyEnv(process.env.ENGRAM_NO_AUTO_CLOUD)) {
        const creds = readCredentials();
        if (creds) {
            // Auto-route to cloud. Env vars override per-field.
            return createCloud(opts, 'auto-routed via ~/.pyre/credentials.json', creds);
        }
        // Credentials file existed but was invalid — readCredentials already
        // logged the validation failure. Note the fallback explicitly so the
        // operator sees the routing decision.
        if (credentialsExist()) {
            logRouting('storage=file (credentials file present but invalid — see warning above; ' +
                'fix or delete ~/.pyre/credentials.json, or set ENGRAM_NO_AUTO_CLOUD=1 to suppress the probe)');
        }
    }
    else if (credentialsExist()) {
        // User has creds on disk but explicitly opted out of auto-routing.
        // Worth surfacing so the operator knows the file is being ignored.
        logRouting('storage=file (credentials file present but ENGRAM_NO_AUTO_CLOUD=1 — auto-cloud routing suppressed)');
    }
    return createFile(opts, 'default');
}
/** Parse + validate STORAGE_BACKEND env var. Throws on unknown values. */
function normalizeBackend(raw) {
    const v = (raw ?? '').trim().toLowerCase();
    if (v === '')
        return undefined;
    if (v === 'file' || v === 'postgres' || v === 'cloud')
        return v;
    throw new Error(`Unknown STORAGE_BACKEND='${v}'. Expected 'file', 'postgres', or 'cloud'.`);
}
function createFile(opts, reason) {
    const dataDir = opts.dataDir;
    if (!dataDir) {
        throw new Error('createStorageAdapter: dataDir is required for file backend');
    }
    logRouting(`storage=file (${reason}) · dataDir=${dataDir}`);
    return new FileStorageAdapter(dataDir);
}
async function createPostgres(opts) {
    const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
    const tenantId = opts.tenantId ?? process.env.TENANT_ID;
    if (!databaseUrl || !tenantId) {
        throw new Error('STORAGE_BACKEND=postgres requires DATABASE_URL and TENANT_ID environment variables.');
    }
    const { PostgresStorageAdapter } = await import('./storage-postgres.js');
    const dimEnv = opts.embeddingDim ?? (process.env.ENGRAM_EMBEDDING_DIM
        ? Number(process.env.ENGRAM_EMBEDDING_DIM)
        : undefined);
    logRouting(`storage=postgres (STORAGE_BACKEND=postgres) · tenantId=${tenantId}` +
        (dimEnv ? ` · embeddingDim=${dimEnv}` : ''));
    return new PostgresStorageAdapter({
        databaseUrl,
        tenantId,
        embeddingDim: dimEnv,
    });
}
async function createCloud(opts, reason, preReadCreds) {
    const creds = preReadCreds ?? readCredentials();
    const apiUrl = opts.apiUrl ?? process.env.PYRE_API_URL ?? creds?.api_url;
    const apiKey = opts.apiKey ?? process.env.PYRE_API_KEY ?? creds?.api_key;
    if (!apiUrl || !apiKey) {
        throw new Error('STORAGE_BACKEND=cloud requires PYRE_API_URL and PYRE_API_KEY (or a valid ~/.pyre/credentials.json — ' +
            'run `przm-memory-mcp login`).');
    }
    const { CloudStorageAdapter } = await import('./storage-cloud.js');
    const opted = reason.includes('auto-routed')
        ? ` · set ENGRAM_NO_AUTO_CLOUD=1 to disable`
        : '';
    logRouting(`storage=cloud (${reason}) · apiUrl=${apiUrl}${opted}`);
    return new CloudStorageAdapter({
        apiUrl,
        apiKey,
        label: creds?.label,
        scopes: creds?.scopes,
    });
}
//# sourceMappingURL=storage-factory.js.map