/**
 * Single source of truth for the running version string.
 *
 * Reads `package.json` once at startup so the MCP server's
 * self-identification (`name + version`) stays in sync with the npm
 * package version automatically. Previously the version was hardcoded
 * in `server.ts` and drifted every time `package.json` was bumped
 * without a matching string edit.
 *
 * Cached after the first call. On read failure (unlikely — package.json
 * ships in the published tarball) falls back to '0.0.0' rather than
 * crashing the server.
 */
export declare function getVersion(): string;
