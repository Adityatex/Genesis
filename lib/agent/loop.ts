// lib/agent/loop.ts
// Shared agent-loop core — single implementation used by both fresh runs
// and resume-after-navigation. Previously duplicated in App.tsx.
// No behavior change: same 20-step budget, same delays, same message shapes.

import { createDOMSnapshot } from '@/lib/agent/domSnapshot';
import { executeAction, type AgentAction } from '@/lib/agent/actionExecutor';

export const MAX_AGENT_STEPS = 20;
/** Consecutive unparseable/invalid model responses tolerated before aborting. */
export const MAX_INVALID_RESPONSES = 3;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isAgentCommand(msg: string): boolean {
  const actionWords = /\b(go to|open|navigate|click|search|find|type|fill|submit|scroll|press|select|visit|browse|download|sign in|log in|sign up|play|watch|buy|add to cart|checkout|subscribe)\b/i;
  const urlPattern = /\b(https?:\/\/|www\.)/i;
  return actionWords.test(msg) || urlPattern.test(msg);
}

const PENDING = '→ (executing...)';

/**
 * Called on the page a session resumes on. The page that started the
 * navigation unloaded before it could record the result, so the last entry
 * still reads "(executing...)". Replace that with where the agent ended up;
 * without it the model can't tell a click worked and starts guessing URLs.
 */
export function settleNavigation(actionHistory: string[], title: string, url: string): string[] {
  const last = actionHistory.at(-1);
  if (!last?.endsWith(PENDING)) return actionHistory;
  const where = `now on "${title || 'untitled page'}" (${url})`;
  return [...actionHistory.slice(0, -1), `${last.slice(0, -PENDING.length)}→ ✅ page changed; ${where}`];
}

export function formatHistory(actionHistory: string[]): string {
  return actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n');
}

export interface AgentLoopCallbacks {
  onProgress: (text: string, isLoading: boolean) => void;
  shouldStop: () => boolean;
}

export type AgentLoopOutcome =
  | { status: 'done' }
  | { status: 'navigating' }
  | { status: 'max-steps' }
  | { status: 'aborted' };

/**
 * Run the perceive → plan → act loop until done / navigate / max-steps / abort.
 * Mutates the passed actionHistory array (same as previous App.tsx behavior).
 */
export async function executeAgentLoop(
  goal: string,
  actionHistory: string[],
  startStep: number,
  cb: AgentLoopCallbacks,
): Promise<AgentLoopOutcome> {
  let stepCount = startStep;
  let invalidStreak = 0;

  // Set once this page starts unloading; this content script is about to die.
  let unloading = false;
  const onBeforeUnload = () => { unloading = true; };
  window.addEventListener('beforeunload', onBeforeUnload);

  try {
    while (stepCount < MAX_AGENT_STEPS && !cb.shouldStop()) {
      stepCount++;

      // 1. Snapshot the DOM
      cb.onProgress(`🔍 **Step ${stepCount}** — Scanning page...`, true);
      await sleep(300);
      if (cb.shouldStop()) break;
      const snapshot = createDOMSnapshot();

      // 2. Ask LLM for next action
      cb.onProgress(`🧠 **Step ${stepCount}** — Planning next action...`, true);
      const response = await browser.runtime.sendMessage({
        action: 'AGENT_STEP',
        payload: { goal, domSnapshot: snapshot.text, actionHistory, stepCount },
      });

      if (cb.shouldStop()) {
        await browser.runtime.sendMessage({ action: 'CLEAR_AGENT_SESSION', payload: {} }).catch(() => {});
        break;
      }

      if (!response?.success && response?.code === 'INVALID_ACTION') {
        // Feed the error back through history so the model can correct itself
        invalidStreak++;
        actionHistory.push(`(invalid response) → ❌ ${response.error}. Respond with ONE valid JSON action.`);
        if (invalidStreak >= MAX_INVALID_RESPONSES) {
          throw new Error(`Model returned ${invalidStreak} invalid actions in a row. Last error: ${response.error}`);
        }
        continue;
      }

      if (!response?.success) {
        throw new Error(response?.error || 'Agent step failed');
      }
      invalidStreak = 0;

      const agentAction: AgentAction = response.data.action;
      console.log('[Genesis] Agent action received:', JSON.stringify(agentAction));

      // 3. Check if done
      if (agentAction.action === 'done') {
        await browser.runtime.sendMessage({ action: 'CLEAR_AGENT_SESSION', payload: {} }).catch(() => {});
        cb.onProgress(
          `## ✅ Task Complete\n\n${agentAction.summary || 'Done'}\n\n---\n**Steps taken:**\n${formatHistory(actionHistory)}`,
          false,
        );
        return { status: 'done' };
      }

      // 4. If navigating — background already saved session + is navigating the tab
      if (response.data.navigating || agentAction.action === 'navigate') {
        cb.onProgress(`🔄 **Navigating to** ${agentAction.url}\n\nWill resume on the new page...`, true);
        return { status: 'navigating' }; // Stop loop — page reloads, resumes via hook
      }

      // 5. Execute other actions
      const actionDesc = `${agentAction.action}${agentAction.elementId !== undefined ? ` [${agentAction.elementId}]` : ''}${agentAction.text ? ` "${agentAction.text}"` : ''}${agentAction.key ? ` key=${agentAction.key}` : ''}`;
      cb.onProgress(`⚡ **Step ${stepCount}** — ${actionDesc}`, true);

      const result = await executeAction(agentAction);
      actionHistory.push(`${actionDesc} → ${result}`);

      // 6. The action may have started a navigation (link click, form submit).
      // Beforeunload can fire a moment after the action returns, so wait first.
      await sleep(800);
      if (unloading) {
        // Replace the background's "(executing...)" entry with the real result,
        // then stop: planning from this dying page would race the new page's resume.
        browser.runtime.sendMessage({
          action: 'SAVE_AGENT_SESSION',
          payload: { goal, actionHistory, stepCount },
        }).catch(() => {});
        cb.onProgress(`🔄 **Page is changing** after ${actionDesc}\n\nWill resume on the new page...`, true);
        return { status: 'navigating' };
      }

      // 7. Show progress
      cb.onProgress(
        `**Agent Progress** (step ${stepCount}/${MAX_AGENT_STEPS})\n\n${formatHistory(actionHistory)}\n\n*Thinking about next step...*`,
        true,
      );
    }

    if (cb.shouldStop()) {
      return { status: 'aborted' };
    }

    // Max steps reached
    await browser.runtime.sendMessage({ action: 'CLEAR_AGENT_SESSION', payload: {} });
    cb.onProgress(
      `## ⚠️ Max Steps Reached\n\nCompleted ${MAX_AGENT_STEPS} steps without finishing.\n\n**Steps taken:**\n${formatHistory(actionHistory)}`,
      false,
    );
    return { status: 'max-steps' };
  } catch (err: any) {
    if (cb.shouldStop()) return { status: 'aborted' };
    await browser.runtime.sendMessage({ action: 'CLEAR_AGENT_SESSION', payload: {} }).catch(() => {});
    cb.onProgress(
      `## ❌ Agent Error\n\n${err.message}\n\n**Steps completed:**\n${formatHistory(actionHistory) || 'None'}`,
      false,
    );
    return { status: 'done' };
  } finally {
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
}
