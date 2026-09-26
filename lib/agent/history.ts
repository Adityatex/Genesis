// lib/agent/history.ts
// Small helpers shared by the sidebar (content script) and the agent runner
// (background). No DOM access, so both bundles can import it.

import type { AgentAction } from '@/lib/agent/actionExecutor';

export const MAX_AGENT_STEPS = 20;
/** Consecutive unparseable/invalid model responses tolerated before aborting. */
export const MAX_INVALID_RESPONSES = 3;

export function isAgentCommand(msg: string): boolean {
  const actionWords = /\b(go to|open|navigate|click|search|find|type|fill|submit|scroll|press|select|visit|browse|download|sign in|log in|sign up|play|watch|buy|add to cart|checkout|subscribe)\b/i;
  const urlPattern = /\b(https?:\/\/|www\.)/i;
  return actionWords.test(msg) || urlPattern.test(msg);
}

export function formatHistory(actionHistory: string[]): string {
  return actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n');
}

/** One-line description of an action for the history, e.g. `type [3] "Ada"`. */
export function describeAction(action: AgentAction): string {
  let desc = action.action;
  if (action.elementId !== undefined) desc += ` [${action.elementId}]`;
  if (action.text) desc += ` "${action.text}"`;
  if (action.value) desc += ` "${action.value}"`;
  if (action.key) desc += ` key=${action.key}`;
  if (action.url) desc += ` ${action.url}`;
  return desc;
}
