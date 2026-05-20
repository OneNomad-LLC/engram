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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
// In src/ → ../package.json (dev / tsx). In dist/ → ../package.json (built).
const pkgPath = resolve(here, '..', 'package.json');
let cached = null;
export function getVersion() {
    if (cached !== null)
        return cached;
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        cached = typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : '0.0.0';
    }
    catch {
        cached = '0.0.0';
    }
    return cached;
}
//# sourceMappingURL=version.js.map