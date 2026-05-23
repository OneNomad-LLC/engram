/**
 * CONTEXT PRESSURE — self-nudge helper.
 *
 * przm Memory can't actually read the agent's token budget, but it can return a
 * structured checklist that reminds the agent *what* to do when context is
 * getting heavy. The agent calls this periodically (or after big tool outputs)
 * and gets back a deterministic prompt-injection telling it to write a
 * handoff note and invoke /compact.
 *
 * This exists because self-pacing compaction is a discipline problem — the
 * agent knows it should do it, but needs a loud, structured reminder.
 */

export interface PressureSignal {
  level: 'ok' | 'warm' | 'hot' | 'critical';
  /** Whether this check was triggered by a natural phase boundary (task done, pivoting focus) */
  phaseBoundary: boolean;
  /** Heuristic reason the caller gave (e.g., "long tool outputs", "many file reads") */
  reason: string;
  /** Ordered steps the agent should take before anything else */
  actionPlan: string[];
  /** Terse reminder suitable for prompt-injection */
  reminder: string;
}

const PLAN_OK = [
  'No action required. Continue working.',
  'Save any new facts, preferences, or decisions to memory-ingest as they emerge.',
];

const PLAN_WARM = [
  'Save any unsaved facts/preferences/decisions to memory-ingest now — do not batch.',
  'Update session state with current task/decisions via memory-session.',
  'Continue working but keep tool outputs lean.',
];

const PLAN_HOT = [
  'IMMEDIATELY call memory-handoff-write with a full "where we left off" snapshot.',
  'Save unsaved facts to memory-ingest.',
  'After the handoff is written, invoke /compact yourself — do not wait for the system.',
];

const PLAN_CRITICAL = [
  'STOP all other work.',
  'Call memory-handoff-write RIGHT NOW — reason: "context-pressure". Include currentTask, nextSteps, fileRefs, openQuestions.',
  'Save any unsaved facts to memory-ingest.',
  'Tell the user the context is near-full and ask permission to /compact or end the session. If no response, compact anyway — losing the handoff is worse than a surprise compact.',
];

// When the agent reports a natural phase boundary (task done, pivoting focus,
// finishing a subsystem), eat the cache miss now. The pivot will thrash the
// cache anyway — better to compact with fresh memories and a handoff in hand
// than ride a bloated window into the next phase.
const PLAN_PHASE_BOUNDARY = [
  'Natural phase boundary detected. This is the right moment to compact — pivots thrash the cache anyway.',
  'Call memory-handoff-write with reason="compact". Include currentTask (the phase just finished), completed, nextSteps (the phase about to start), fileRefs, decisions.',
  'Save any unsaved facts from the completed phase via memory-ingest.',
  'Invoke /compact yourself before starting the next phase. Do not carry verbose tool outputs from the finished work into the new one.',
];

export function assessPressure(
  level: PressureSignal['level'],
  reason = '',
  phaseBoundary = false,
): PressureSignal {
  // Phase boundary overrides ok/warm — compact proactively regardless of level.
  // At hot/critical the phase boundary adds urgency but the existing plan is already strict.
  if (phaseBoundary && (level === 'ok' || level === 'warm')) {
    return {
      level,
      phaseBoundary: true,
      reason,
      actionPlan: PLAN_PHASE_BOUNDARY,
      reminder: 'Phase boundary. Write handoff, save memories, /compact before pivoting.',
    };
  }

  switch (level) {
    case 'ok':
      return {
        level,
        phaseBoundary,
        reason,
        actionPlan: PLAN_OK,
        reminder: 'Context healthy. Keep persisting memories as they emerge.',
      };
    case 'warm':
      return {
        level,
        phaseBoundary,
        reason,
        actionPlan: PLAN_WARM,
        reminder: 'Context warming. Persist memories now; keep outputs lean.',
      };
    case 'hot':
      return {
        level,
        phaseBoundary,
        reason,
        actionPlan: phaseBoundary
          ? [...PLAN_PHASE_BOUNDARY, ...PLAN_HOT]
          : PLAN_HOT,
        reminder: 'Context HOT. Write handoff note, then /compact. Do not wait.',
      };
    case 'critical':
      return {
        level,
        phaseBoundary,
        reason,
        actionPlan: PLAN_CRITICAL,
        reminder: 'CRITICAL: window near full. Write handoff NOW or lose state.',
      };
  }
}
