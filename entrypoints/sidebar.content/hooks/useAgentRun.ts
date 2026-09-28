// entrypoints/sidebar.content/hooks/useAgentRun.ts
// The agent runs in the background service worker (lib/agent/runner.ts) and
// survives page loads. The sidebar only starts/stops it and shows the state the
// background pushes (AGENT_UPDATE). A freshly loaded page asks for the current
// state, so an ongoing run keeps showing after navigation.
import { useEffect, useRef } from 'react';
import type { RunView } from '@/lib/agent/runner';

/** On page load, show a finished run's result only if it just ended. */
const RECENT_MS = 2 * 60_000;

export function useAgentRun(onUpdate: (view: RunView) => void) {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;

  useEffect(() => {
    const listener = (message: any) => {
      if (message?.action === 'AGENT_UPDATE') callback.current(message.payload as RunView);
    };
    browser.runtime.onMessage.addListener(listener);

    browser.runtime.sendMessage({ action: 'GET_AGENT_STATE' })
      .then((res: any) => {
        const view: RunView | null = res?.data ?? null;
        if (view && (view.status === 'running' || Date.now() - view.updatedAt < RECENT_MS)) callback.current(view);
      })
      .catch(() => {});

    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const start = async (goal: string): Promise<void> => {
    const res: any = await browser.runtime.sendMessage({ action: 'START_AGENT', payload: { goal } });
    if (!res?.success) throw new Error(res?.error || 'Could not start the agent');
  };

  /** Continue a paused run. */
  const resume = (): void => {
    browser.runtime.sendMessage({ action: 'RESUME_AGENT' }).catch(() => {});
  };

  /** Stop after the current step; `forget` also clears it (e.g. "Clear all"). */
  const stop = (forget = false): void => {
    browser.runtime.sendMessage({ action: 'STOP_AGENT', payload: { forget } }).catch(() => {});
  };

  return { start, stop, resume };
}
