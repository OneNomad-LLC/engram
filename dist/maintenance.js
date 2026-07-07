import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { consolidate } from './consolidator.js';
import { syncBridge } from './procedural-bridge.js';
import { extractRules } from './procedural.js';
const STATE_FILE = 'maintenance.json';
export function readMaintenanceState(dataDir) {
    const path = join(dataDir, STATE_FILE);
    if (existsSync(path)) {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf-8'));
            return {
                lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : null,
                rulesBackfilledAt: typeof parsed?.rulesBackfilledAt === 'string' ? parsed.rulesBackfilledAt : null,
            };
        }
        catch { /* corrupt state treated as never-run */ }
    }
    return { lastRunAt: null, rulesBackfilledAt: null };
}
function writeMaintenanceState(dataDir, state) {
    writeFileSync(join(dataDir, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
}
export function autoMaintainEnabled() {
    const v = process.env.PRZM_MEMORY_AUTO_MAINTAIN ?? process.env.ENGRAM_AUTO_MAINTAIN;
    return v !== '0' && v !== 'false';
}
export function maintainIntervalMs() {
    const raw = process.env.PRZM_MEMORY_MAINTAIN_INTERVAL_HOURS ?? process.env.ENGRAM_MAINTAIN_INTERVAL_HOURS;
    const hours = raw ? parseFloat(raw) : 24;
    return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}
export function maintenanceOverdue(dataDir) {
    const state = readMaintenanceState(dataDir);
    if (!state.lastRunAt)
        return true;
    return Date.now() - new Date(state.lastRunAt).getTime() >= maintainIntervalMs();
}
/**
 * One-shot backfill: preference/correction chunks ingested before rule
 * extraction was wired into memory-ingest never produced procedural
 * rules. Replay their content through the extractor in batches (the LLM
 * path reads 20 messages per call, so batching keeps cost bounded when a
 * key is configured; the heuristic path is free either way).
 *
 * Runs once per store. Re-running extraction over the same content on
 * every maintenance pass would re-reinforce matched rules and inflate
 * confidence, so the completion stamp is a hard gate.
 */
async function backfillRules(config, storage) {
    const chunks = await storage.listChunks();
    const sources = chunks
        .filter(c => (c.type === 'preference' || c.type === 'correction') && c.consolidationLevel !== -1)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, 500);
    if (sources.length === 0)
        return 0;
    const BATCH = 20;
    for (let i = 0; i < sources.length; i += BATCH) {
        const batch = sources.slice(i, i + BATCH);
        try {
            await extractRules(config, storage, batch.map(c => ({ role: 'user', content: c.content })));
        }
        catch { /* best-effort per batch */ }
    }
    return sources.length;
}
/**
 * Full maintenance pass: consolidation, bridge sync, and (once) the rule
 * backfill. Shared by the memory-maintain tool and the auto scheduler so
 * both paths stay identical.
 */
export async function runMaintenance(config, storage) {
    const stats = await consolidate(storage, config);
    let bridge = { exported: 0, imported: 0, reinforced: 0, conflicts: 0 };
    try {
        bridge = await syncBridge(storage);
    }
    catch { /* bridge sync is best-effort */ }
    const state = readMaintenanceState(config.dataDir);
    let rulesBackfilled = 0;
    if (!state.rulesBackfilledAt) {
        rulesBackfilled = await backfillRules(config, storage);
        state.rulesBackfilledAt = new Date().toISOString();
    }
    state.lastRunAt = new Date().toISOString();
    writeMaintenanceState(config.dataDir, state);
    return { ...stats, bridge, rulesBackfilled };
}
//# sourceMappingURL=maintenance.js.map