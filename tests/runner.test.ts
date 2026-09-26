import { describe, it, expect, vi } from 'vitest';
import { startRun, stopRun, getRunView, notifyTabLoading, type RunnerDeps, type TabInfo } from '@/lib/agent/runner';
import { MAX_AGENT_STEPS } from '@/lib/agent/history';

/** A fake tab + planner. `actions` are the model's answers, in order. */
function fakeDeps(actions: string[], opts: { onExecute?: (tab: TabInfo, action: any) => unknown } = {}) {
  const tab: TabInfo = { status: 'complete', url: 'https://shop.test/', title: 'Shop' };
  const prompts: string[][] = [];
  let i = 0;
  const deps: RunnerDeps = {
    plan: vi.fn(async (_goal, _snap, history) => {
      prompts.push([...history]);
      return actions[Math.min(i++, actions.length - 1)];
    }),
    send: vi.fn(async (_tabId, message: any) => {
      if (message.action === 'AGENT_SNAPSHOT') return { text: `PAGE: ${tab.title}` };
      if (message.action === 'AGENT_EXECUTE') return opts.onExecute ? opts.onExecute(tab, message.payload) : `✅ ran ${message.payload.action}`;
      return { ok: true }; // AGENT_PING, AGENT_UPDATE
    }),
    getTab: vi.fn(async () => ({ ...tab })),
    navigate: vi.fn(async (_tabId, url) => { tab.url = url; tab.title = 'Somewhere else'; }),
    onRunEnded: vi.fn(),
    sleep: vi.fn(async () => {}),
  };
  return { deps, tab, prompts };
}

describe('agent runner (background loop)', () => {
  it('runs actions until the model says done, then reports and cleans up', async () => {
    const { deps } = fakeDeps(['{"action":"click","elementId":1}', '{"action":"done","summary":"Bought it"}']);
    const result = await startRun(deps, 1, 'Buy it');
    expect(result.status).toBe('done');
    expect(result.message).toMatch(/Task Complete\n\nBought it/);
    expect(result.message).toContain('1. click [1] → ✅ ran click');
    expect(deps.onRunEnded).toHaveBeenCalledTimes(1);
    expect(getRunView(1)?.status).toBe('done'); // kept so a newly loaded page can show it
  });

  it('keeps going when a click navigates away before the page can answer', async () => {
    const { deps, prompts } = fakeDeps(['{"action":"click","elementId":3}', '{"action":"done","summary":"ok"}'], {
      onExecute: (tab) => {
        tab.url = 'https://shop.test/cart';
        tab.title = 'Your cart';
        notifyTabLoading(2);
        throw new Error('The message port closed before a response was received');
      },
    });
    const result = await startRun(deps, 2, 'Open the cart');
    expect(result.status).toBe('done');
    expect(prompts[1]).toEqual([
      'click [3] → ✅ Done (the page changed before it could report back); page changed, now on "Your cart" (https://shop.test/cart)',
    ]);
  });

  it('navigates itself and records where it landed', async () => {
    const { deps, prompts } = fakeDeps(['{"action":"navigate","url":"https://other.test/"}', '{"action":"done","summary":"ok"}']);
    await startRun(deps, 3, 'Go to other');
    expect(deps.navigate).toHaveBeenCalledWith(3, 'https://other.test/');
    expect(prompts[1][0]).toBe('navigate https://other.test/ → ✅ now on "Somewhere else" (https://other.test/)');
  });

  it('feeds invalid output back, and gives up after three in a row', async () => {
    const { deps, prompts } = fakeDeps(['not json']);
    const result = await startRun(deps, 4, 'Anything');
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Agent Error\n\nModel returned 3 invalid actions in a row/);
    expect(prompts[1][0]).toMatch(/^\(invalid response\) → ❌ No JSON object/);
  });

  it('stops at the step limit', async () => {
    const { deps } = fakeDeps(['{"action":"scroll","direction":"down"}']);
    const result = await startRun(deps, 5, 'Scroll forever');
    expect(result.status).toBe('max-steps');
    expect(result.message).toMatch(/Max Steps Reached/);
    expect(deps.plan).toHaveBeenCalledTimes(MAX_AGENT_STEPS);
  });

  it('stops when asked, after the current step', async () => {
    const { deps } = fakeDeps(['{"action":"scroll","direction":"down"}']);
    (deps.plan as any).mockImplementation(async () => {
      stopRun(6);
      return '{"action":"scroll","direction":"down"}';
    });
    const result = await startRun(deps, 6, 'Scroll');
    expect(result.status).toBe('stopped');
    expect(deps.plan).toHaveBeenCalledTimes(1);
  });
});
