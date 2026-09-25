// entrypoints/sidebar.content/hooks/useAgentLoop.ts
import { useRef } from 'react';
import { executeAgentLoop, formatHistory, sleep } from '@/lib/agent/loop';

interface ResumeDeps {
  onResumeFound: (goal: string, historyLog: string) => string; // creates resume msg, returns id
  onProgress: (msgId: string, text: string, isLoading: boolean) => void;
  onOpened: () => void;
  onWorking: (working: boolean) => void;
}

export function useAgentLoop() {
  const isAgentRunningRef = useRef(false);

  const runFreshLoop = async (
    goal: string,
    msgId: string,
    update: (text: string, loading: boolean) => void,
    startHistory: string[] = [],
    startStep = 0,
  ) => {
    isAgentRunningRef.current = true;
    try {
      await executeAgentLoop(goal, [...startHistory], startStep, {
        onProgress: update,
        shouldStop: () => !isAgentRunningRef.current,
      });
    } finally {
      isAgentRunningRef.current = false;
    }
  };

  const stop = () => {
    isAgentRunningRef.current = false;
  };

  // Resume-after-navigation: same delays + message shapes as before.
  const checkAndResume = async (deps: ResumeDeps, alreadyChecked: { current: boolean }) => {
    if (alreadyChecked.current) return;
    alreadyChecked.current = true;

    await sleep(1500);
    // A task started on this page within the delay has already written the
    // session we'd find — resuming it would run a second loop in parallel.
    if (isAgentRunningRef.current) return;
    console.log('[Genesis] Checking for saved agent session...');
    try {
      const response = await browser.runtime.sendMessage({ action: 'GET_AGENT_SESSION', payload: {} });
      console.log('[Genesis] Session response:', response);
      if (response?.success && response.data) {
        const { goal, actionHistory, stepCount } = response.data;
        if (!goal) {
          console.log('[Genesis] No saved agent session found.');
          return;
        }
        if (isAgentRunningRef.current) return;
        console.log('[Genesis] Resuming agent session for goal:', goal);
        deps.onOpened();
        deps.onWorking(true);

        const historyLog = (actionHistory || []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n');
        // Mark running now so Stop/Clear during the delay below is honored
        isAgentRunningRef.current = true;
        const id = deps.onResumeFound(goal, historyLog);

        await sleep(2000);
        if (!isAgentRunningRef.current) {
          deps.onWorking(false); // stopped/cleared during the delay
          return;
        }

        const actionHistoryCopy = [...(actionHistory || [])];
        const loopStepCount = stepCount || 0;

        try {
          await executeAgentLoop(goal, actionHistoryCopy, loopStepCount, {
            onProgress: (text, loading) => deps.onProgress(id, text, loading),
            shouldStop: () => !isAgentRunningRef.current,
          });
        } finally {
          isAgentRunningRef.current = false;
        }
        deps.onWorking(false);
      } else {
        console.log('[Genesis] No saved agent session found.');
      }
    } catch (err) {
      console.error('[Genesis] Error checking session:', err);
    }
  };

  return { isAgentRunningRef, runFreshLoop, stop, checkAndResume, formatHistory };
}
