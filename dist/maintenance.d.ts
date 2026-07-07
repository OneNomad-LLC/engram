import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
import { type ConsolidationStats } from './consolidator.js';
import { syncBridge } from './procedural-bridge.js';
type SyncStats = Awaited<ReturnType<typeof syncBridge>>;
/**
 * Maintenance orchestration.
 *
 * consolidate() is the entire tier lifecycle — promotion, decay, linking,
 * merging, episodic summarization — and before this module existed its
 * only trigger was a manual memory-maintain call. Deployments where no
 * agent ever invoked that tool (most of them) accumulated thousands of
 * chunks frozen in short-term with zero procedural rules. Maintenance now
 * self-schedules: the server checks the last-run stamp at boot and runs
 * when overdue, plus an interval timer for long-lived processes.
 *
 * State lives in <dataDir>/maintenance.json:
 *   lastRunAt          — ISO stamp of the last completed run
 *   rulesBackfilledAt  — one-shot marker for the preference/correction
 *                        rule backfill (see backfillRules)
 */
export interface MaintenanceState {
    lastRunAt: string | null;
    rulesBackfilledAt: string | null;
}
export interface MaintenanceResult extends ConsolidationStats {
    bridge: SyncStats;
    rulesBackfilled: number;
}
export declare function readMaintenanceState(dataDir: string): MaintenanceState;
export declare function autoMaintainEnabled(): boolean;
export declare function maintainIntervalMs(): number;
export declare function maintenanceOverdue(dataDir: string): boolean;
/**
 * Full maintenance pass: consolidation, bridge sync, and (once) the rule
 * backfill. Shared by the memory-maintain tool and the auto scheduler so
 * both paths stay identical.
 */
export declare function runMaintenance(config: SmartMemoryConfig, storage: Storage): Promise<MaintenanceResult>;
export {};
