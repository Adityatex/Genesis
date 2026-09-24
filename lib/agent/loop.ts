// lib/agent/loop.ts
// Shared agent-loop core — single implementation used by both fresh runs
// and resume-after-navigation. Previously duplicated in App.tsx.
// No behavior change: same 20-step budget, same delays, same message shapes.

import { createDOMSnapshot } from '@/lib/agent/domSnapshot';
import { executeAction, type AgentAction } from '@/lib/agent/actionExecutor';

export const MAX_AGENT_STEPS = 20;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function isAgentCommand(msg: string): boolean {
  const actionWords = /\b(go to|open|navigate|click|search|find|type|fill|submit|scroll|press|select|visit|browse|download|sign in|log in|sign up|play|watch|buy|add to cart|checkout|subscribe)\b/i;
  const urlPattern = /\b(https?:\/\/|www\.)/i;
  return actionWords.test(msg) || urlPattern.test(msg);
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

      if (!response?.success) {
        throw new Error(response?.error || 'Agent step failed');
      }

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

      // 6. Show progress
      cb.onProgress(
        `**Agent Progress** (step ${stepCount}/${MAX_AGENT_STEPS})\n\n${formatHistory(actionHistory)}\n\n*Thinking about next step...*`,
        true,
      );

      await sleep(800);
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
  }
}
