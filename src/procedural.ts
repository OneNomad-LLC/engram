import type { SmartMemoryConfig, ProceduralRule } from './types.js';
import { Storage } from './storage.js';
import { llmComplete, isLlmAvailable } from './llm.js';

// ── LLM Extraction Prompt ───────────────────────────────────────────

const PROCEDURAL_EXTRACTION_PROMPT = `You analyze conversations between a user and their AI assistant to extract PROCEDURAL RULES about how this specific user wants things done.

Look for implicit and explicit signals:
- Code style: what the user includes, excludes, or corrects in code
- Communication: length, tone, format, words to avoid
- Workflow: when to act vs ask, when to be thorough vs brief
- Recurring corrections: if the user keeps fixing the same thing, that IS a rule
- Direct instructions: "always do X", "never do Y", "I prefer Z"

IMPORTANT: Extract rules about what the USER wants, not what the assistant did. If the assistant used em-dashes and the user didn't correct it, that's NOT a rule. If the user said "don't use em-dashes", that IS a rule.

CONVERSATION:
{{CONVERSATION}}

USER REACTION SIGNALS (these indicate user approval, frustration, corrections, etc.):
{{SIGNALS}}

EXISTING RULES (numbered -- use the number as ruleIndex when reinforcing or contradicting):
{{EXISTING_RULES}}

For each insight, output one of:
- "new" -- a rule not captured by any existing rule
- "reinforce" -- this conversation provides evidence an existing rule is correct
- "contradict" -- this conversation provides evidence an existing rule is wrong or outdated

Return a JSON array:
[{
  "rule": "Clear, specific, actionable rule",
  "domain": "code"|"communication"|"workflow"|"preference"|"general",
  "action": "new"|"reinforce"|"contradict",
  "ruleIndex": null for new rules, or the number of the existing rule,
  "evidence": "What happened in the conversation that supports this"
}]

Rules should be specific. Bad: "User likes clean code." Good: "Always add explicit return types to TypeScript functions."

If no procedural insights exist in this conversation, return [].
Return ONLY valid JSON. No markdown fences.`;

// ── Extract Rules from Conversation ─────────────────────────────────

export async function extractRules(
  config: SmartMemoryConfig,
  storage: Storage,
  messages: Array<{ role: string; content: string }>,
  signals?: Array<{ type: string; confidence: number }>
): Promise<void> {
  const existing = await storage.getRules();

  const results = isLlmAvailable()
    ? await llmExtractRules(config, messages, signals, existing)
    : heuristicExtractRules(messages, existing);

  for (const r of results) {
    if (!r.rule || !r.action) continue;

    if (r.action === 'new') {
      const rule: ProceduralRule = {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        rule: r.rule,
        domain: r.domain ?? 'general',
        confidence: 0.5,
        reinforcements: 0,
        contradictions: 0,
        evidence: [r.evidence ?? ''],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await storage.saveRule(rule);
    } else if (r.action === 'reinforce' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.reinforcements++;
        rule.confidence = Math.min(1.0, rule.confidence + 0.1);
        rule.evidence.push(r.evidence ?? '');
        rule.updatedAt = new Date().toISOString();
        await storage.saveRule(rule);
      }
    } else if (r.action === 'contradict' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.contradictions++;
        rule.confidence = Math.max(0.0, rule.confidence - 0.2);
        rule.evidence.push(`CONTRADICTED: ${r.evidence ?? ''}`);
        rule.updatedAt = new Date().toISOString();
        if (rule.confidence <= 0) {
          await storage.deleteRule(rule.id);
        } else {
          await storage.saveRule(rule);
        }
      }
    }
  }
}

// ── LLM-powered rule extraction ─────────────────────────────────────

async function llmExtractRules(
  config: SmartMemoryConfig,
  messages: Array<{ role: string; content: string }>,
  signals: Array<{ type: string; confidence: number }> | undefined,
  existing: ProceduralRule[]
): Promise<Array<Record<string, any>>> {
  const conversation = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const signalText = signals?.map(s => `${s.type} (${s.confidence.toFixed(2)})`).join(', ') || 'none';
  const existingText = existing.length > 0
    ? existing.map((r, i) => `${i}. [${r.domain}] ${r.rule} (confidence: ${r.confidence.toFixed(2)})`).join('\n')
    : 'No existing rules.';

  const prompt = PROCEDURAL_EXTRACTION_PROMPT
    .replace('{{CONVERSATION}}', conversation)
    .replace('{{SIGNALS}}', signalText)
    .replace('{{EXISTING_RULES}}', existingText);

  const text = await llmComplete(config, prompt, 'Extract procedural rules from this conversation.', {
    maxTokens: 800,
    temperature: 0,
  });

  return parseJsonArray(text);
}

// ── Heuristic rule extraction (no API key needed) ───────────────────
// Scans user messages for explicit directives and corrections.

const DIRECTIVE_PATTERNS: Array<{
  test: RegExp;
  domain: ProceduralRule['domain'];
  extract: (match: RegExpMatchArray, sentence: string) => string | null;
}> = [
  // "always X" / "never X"
  {
    test: /\b(always|never)\s+(.{10,80})/i,
    domain: 'general',
    extract: (_m, sentence) => sentence.trim(),
  },
  // "don't/do not X"
  {
    test: /\b(?:don't|do not|stop)\s+(?:use|add|include|put|make|write|create)\s+(.{5,80})/i,
    domain: 'code',
    extract: (_m, sentence) => sentence.trim(),
  },
  // "use X instead of Y"
  {
    test: /\buse\s+(.{3,40})\s+instead\s+of\s+(.{3,40})/i,
    domain: 'code',
    extract: (m) => `Use ${m[1].trim()} instead of ${m[2].trim()}`,
  },
  // "I prefer X over Y"
  {
    test: /\bprefer\s+(.{3,40})\s+(?:over|to|instead of)\s+(.{3,40})/i,
    domain: 'preference',
    extract: (m) => `Prefer ${m[1].trim()} over ${m[2].trim()}`,
  },
  // "rule: X" / "rule set by Matt: X" — how explicit directives commonly
  // arrive via memory-ingest (type=preference/correction) rather than as
  // raw conversation
  {
    test: /\brule(?:\s+set)?(?:\s+by\s+\w+)?\s*:\s*(.{10,150})/i,
    domain: 'general',
    extract: (m) => m[1].trim(),
  },
  // "prefers X" / "I prefer X" without an explicit alternative — the
  // dominant phrasing of stored preference memories ("Matt prefers
  // TypeScript for new projects")
  {
    test: /\bprefers?\s+((?!.{0,40}\b(?:over|instead of)\b).{5,80})/i,
    domain: 'preference',
    extract: (_m, sentence) => sentence.trim(),
  },
  // "from now on" / "going forward"
  {
    test: /\b(?:from now on|going forward|in the future)\b[,.]?\s*(.{10,120})/i,
    domain: 'general',
    extract: (_m, sentence) => sentence.trim(),
  },
  // "make sure to X" / "remember to X"
  {
    test: /\b(?:make sure|remember|be sure)\s+(?:to\s+)?(.{10,100})/i,
    domain: 'workflow',
    extract: (_m, sentence) => sentence.trim(),
  },
  // "keep it X" / "keep things X"
  {
    test: /\bkeep\s+(?:it|things|the code|responses?)\s+(.{5,60})/i,
    domain: 'communication',
    extract: (_m, sentence) => sentence.trim(),
  },
];

function heuristicExtractRules(
  messages: Array<{ role: string; content: string }>,
  existing: ProceduralRule[]
): Array<Record<string, any>> {
  const results: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    const sentences = msg.content
      .split(/(?<=[.!?])\s+|(?<=\n)/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 300);

    for (const sentence of sentences) {
      for (const pattern of DIRECTIVE_PATTERNS) {
        const match = sentence.match(pattern.test);
        if (!match) continue;

        const rule = pattern.extract(match, sentence);
        if (!rule || rule.length < 10) continue;

        // Dedup
        const key = rule.toLowerCase().replace(/[^a-z0-9\s]/g, '');
        if (seen.has(key)) continue;
        seen.add(key);

        // Check if this reinforces an existing rule
        const reinforceIdx = findMatchingRule(rule, existing);

        if (reinforceIdx >= 0) {
          results.push({
            rule: existing[reinforceIdx].rule,
            domain: existing[reinforceIdx].domain,
            action: 'reinforce',
            ruleIndex: reinforceIdx,
            evidence: sentence.slice(0, 200),
          });
        } else {
          results.push({
            rule,
            domain: pattern.domain,
            action: 'new',
            ruleIndex: null,
            evidence: sentence.slice(0, 200),
          });
        }

        break;
      }
    }
  }

  return results;
}

// Simple word-overlap check to find if a new rule matches an existing one
function findMatchingRule(newRule: string, existing: ProceduralRule[]): number {
  const newWords = new Set(newRule.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (newWords.size < 2) return -1;

  for (let i = 0; i < existing.length; i++) {
    const existingWords = new Set(existing[i].rule.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let overlap = 0;
    for (const w of newWords) {
      if (existingWords.has(w)) overlap++;
    }
    // If 50%+ words overlap, it's probably the same rule
    if (newWords.size > 0 && overlap / newWords.size > 0.5) return i;
  }

  return -1;
}

// ── Format Rules for System Prompt ──────────────────────────────────

export async function formatRulesForPrompt(storage: Storage): Promise<string> {
  const rules = (await storage.getRules()).filter(r => r.confidence > 0.3);
  if (rules.length === 0) return '';

  return `\n--- PROCEDURAL RULES ---\n${rules.map(r => `- [${r.domain}] ${r.rule}`).join('\n')}\n`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseJsonArray(text: string): Array<Record<string, any>> {
  const match = text.match(/\[[\s\S]*?\]/) ?? text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    const greedy = text.match(/\[[\s\S]*\]/);
    if (greedy) {
      try { return JSON.parse(greedy[0]); } catch { /* noop */ }
    }
    return [];
  }
}
