#!/usr/bin/env bash
# Engram stop hook — runs after every assistant turn.
#
# Behavior (autonomous):
#  - Writes a lightweight mechanical "session checkpoint" handoff to disk
#    so there is ALWAYS a fresh lifeline if the context window fills before
#    /compact can run. Cheap: single transcript read, no LLM.
#  - Never blocks. The old every-10-messages block was a nag that could
#    interrupt flow; Claude's MCP instructions already push proactive
#    memory-ingest / memory-kg-add / persona_signal calls.
#
# The checkpoint file lives alongside real handoffs but uses reason=
# "context-pressure" so it won't confuse the PreCompact freshness check
# (which only matches reason="compact").

DATA_DIR="${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-$HOME/.claude/engram}}"

# Capture the Claude Code payload: { session_id, transcript_path, stop_hook_active }.
PAYLOAD=$(cat 2>/dev/null || true)

ENGRAM_DATA_DIR="$DATA_DIR" \
CC_PAYLOAD="$PAYLOAD" \
node -e "
  (() => {
    const fs = require('fs');
    const path = require('path');

    let payload = {};
    try { payload = JSON.parse(process.env.CC_PAYLOAD || '{}'); } catch {}
    const transcriptPath = payload.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const handoffDir = path.join(process.env.ENGRAM_DATA_DIR, 'handoffs');
    const checkpointPath = path.join(handoffDir, 'session-checkpoint.json');

    let lines;
    try {
      lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    } catch { return; }

    const userMsgs = [];
    const fileSet = new Set();
    const writeSet = new Set();
    const commits = [];
    let lastAssistantText = '';

    for (const l of lines) {
      let obj;
      try { obj = JSON.parse(l); } catch { continue; }
      if (obj.type === 'user') {
        const c = obj.message && obj.message.content;
        if (Array.isArray(c) && c.some(p => p && p.type === 'tool_result')) continue;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter(p => p && p.type === 'text').map(p => p.text).join('\n')
            : '';
        if (text.trim()) userMsgs.push(text.trim());
      } else if (obj.type === 'assistant') {
        const c = obj.message && obj.message.content;
        if (!Array.isArray(c)) continue;
        for (const p of c) {
          if (p && p.type === 'text' && p.text) lastAssistantText = p.text;
          if (p && p.type === 'tool_use') {
            const name = p.name || '';
            const input = p.input || {};
            if (name === 'Read' && input.file_path) fileSet.add(input.file_path);
            else if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && input.file_path) {
              fileSet.add(input.file_path);
              writeSet.add(input.file_path);
            } else if (name === 'Bash' && typeof input.command === 'string') {
              const m = input.command.match(/git\s+commit[^\"]*-m\s+[\"']([^\"']+)[\"']/);
              if (m) commits.push(m[1].split(/\\n|\n/)[0].slice(0, 120));
            }
          }
        }
      }
    }

    const checkpoint = {
      timestamp: new Date().toISOString(),
      sessionId: payload.session_id || null,
      reason: 'context-pressure',
      currentTask: userMsgs.length ? userMsgs[userMsgs.length - 1].split('\n')[0].slice(0, 200) : '',
      completed: [...writeSet].slice(-20).map(f => 'edited ' + f),
      nextSteps: [],
      openQuestions: [],
      fileRefs: [...fileSet].slice(-30),
      decisions: commits.slice(-10).map(m => 'commit: ' + m),
      notes:
        'Rolling session checkpoint from engram_stop_hook.sh. Mechanical ' +
        'extraction — overwritten on every assistant turn. If /compact ' +
        'never ran, this is the freshest lifeline. Tool-distilled handoffs ' +
        '(via memory-handoff-write) live alongside this file as timestamped entries.' +
        (lastAssistantText ? '\n\nLast assistant note: ' +
          lastAssistantText.trim().split('\n').slice(-3).join(' ').slice(0, 300) : ''),
    };

    try {
      if (!fs.existsSync(handoffDir)) fs.mkdirSync(handoffDir, { recursive: true });
      // Overwrite a single rolling checkpoint (not a new timestamped file)
      // so the handoff dir doesn't grow per-turn.
      fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
    } catch { /* non-fatal — approve regardless */ }
  })();
" 2>/dev/null

# Always approve — never interrupt the user's flow with a block.
echo '{"decision":"approve"}'
