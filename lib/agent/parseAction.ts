// lib/agent/parseAction.ts
// Parses + validates the planner LLM's raw output into an AgentAction.
// Invalid output is reported as an error instead of being treated as "done".

import type { AgentAction } from '@/lib/agent/actionExecutor';

export type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

const ACTIONS: ReadonlySet<AgentAction['action']> = new Set([
  'click', 'type', 'clear_and_type', 'select', 'navigate',
  'scroll', 'read', 'wait', 'done', 'press_key', 'find',
]);

/**
 * Return the first balanced top-level JSON object in `text`, skipping braces
 * inside string literals. Handles code fences and prose around the JSON.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function toElementId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  // Models often quote numbers: "12" or "[12]"
  if (typeof value === 'string') {
    const m = value.trim().match(/^\[?(\d+)\]?$/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

export function parseAgentAction(raw: string): ParseResult {
  const json = extractFirstJsonObject(raw);
  if (!json) return { ok: false, error: `No JSON object in model response: ${raw.slice(0, 200)}` };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: `Malformed JSON in model response: ${json.slice(0, 200)}` };
  }

  const name = obj.action as AgentAction['action'];
  if (typeof name !== 'string' || !ACTIONS.has(name)) {
    return { ok: false, error: `Unknown action "${String(obj.action)}"` };
  }

  const action: AgentAction = { action: name };
  const elementId = toElementId(obj.elementId);
  if (elementId !== undefined) action.elementId = elementId;
  // Models sometimes call find's search text "query"
  const text = optionalString(obj.text ?? (name === 'find' ? obj.query : undefined));
  if (text !== undefined) action.text = text;
  const value = optionalString(obj.value);
  if (value !== undefined) action.value = value;
  const key = optionalString(obj.key);
  if (key !== undefined) action.key = key;
  const summary = optionalString(obj.summary);
  if (summary !== undefined) action.summary = summary;

  switch (name) {
    case 'click':
      if (action.elementId === undefined) return { ok: false, error: 'click requires a numeric elementId' };
      break;
    case 'type':
    case 'clear_and_type':
      if (action.elementId === undefined) return { ok: false, error: `${name} requires a numeric elementId` };
      if (action.text === undefined) return { ok: false, error: `${name} requires text` };
      break;
    case 'select':
      if (action.elementId === undefined) return { ok: false, error: 'select requires a numeric elementId' };
      if (action.value === undefined) return { ok: false, error: 'select requires a value' };
      break;
    case 'navigate': {
      const url = optionalString(obj.url);
      let parsed: URL;
      try {
        parsed = new URL(url ?? '');
      } catch {
        return { ok: false, error: `navigate requires a full URL, got "${url}"` };
      }
      // Never let the model navigate to javascript:, data:, chrome:, file:, etc.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: `navigate only allows http(s) URLs, got "${parsed.protocol}"` };
      }
      action.url = parsed.href;
      break;
    }
    case 'find':
      if (!action.text?.trim()) return { ok: false, error: 'find requires text to search for' };
      break;
    case 'scroll':
      action.direction = obj.direction === 'up' ? 'up' : 'down';
      break;
  }

  return { ok: true, action };
}
