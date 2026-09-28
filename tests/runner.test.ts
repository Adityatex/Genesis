import { describe, it, expect, vi } from 'vitest';
import { startRun, stopRun, resumeRun, getRunView, notifyTabLoading, type RunnerDeps, type RunView, type TabInfo } from '@/lib/agent/runner';
import { promptHistory, PROMPT_RECENT_STEPS } from '@/lib/agent/history';

/**
 * A fake tab + planner. `actions` are the model's answers, in order. Short
 * sleeps are instant; the 10-minute pause timeout never fires.
 */
function fakeDeps(actions: string[], opts: {
  onExecute?: (tab: TabInfo, action: any) => unknown;
  onPause?: (view: RunView) => void;
} = {}) {
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
      if (message.action === 'AGENT_UPDATE' && message.payload.status === 'paused') opts.onPause?.(message.payload);
      return { ok: true }; // AGENT_PING, AGENT_UPDATE
    }),
    getTab: vi.fn(async () => ({ ...tab })),
    navigate: vi.fn(async (_tabId, url) => { tab.url = url; tab.title = 'Somewhere else'; }),
    onRunEnded: vi.fn(),
    sleep: vi.fn(async (ms: number) => { if (ms >= 60_000) await new Promise(() => {}); }),
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
    expect(result.message).toMatch(/Agent Error\n\nModel returned 3 invalid responses in a row/);
    expect(prompts[1][0]).toMatch(/^\(invalid response\) → ❌ No JSON object/);
  });

  it('has no step limit', async () => {
    const actions = Array.from({ length: 60 }, (_, i) => `{"action":"type","elementId":1,"text":"line ${i}"}`);
    const { deps } = fakeDeps([...actions, '{"action":"done","summary":"Wrote 60 lines"}']);
    const result = await startRun(deps, 5, 'Write 60 lines');
    expect(result.status).toBe('done');
    expect(result.step).toBe(61);
    expect(deps.plan).toHaveBeenCalledTimes(61);
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

describe('checkpoints and stuck detection', () => {
  const typing = Array.from({ length: 30 }, (_, i) => `{"action":"type","elementId":1,"text":"line ${i}"}`);

  it('pauses every N steps and carries on when the user continues', async () => {
    const pauses: RunView[] = [];
    const { deps } = fakeDeps([...typing, '{"action":"done","summary":"ok"}'], {
      onPause: (view) => { pauses.push(view); resumeRun(10); },
    });
    const result = await startRun(deps, 10, 'Type', { checkpoint: 10 });
    expect(result.status).toBe('done');
    expect(pauses.map((v) => v.step)).toEqual([10, 20, 30]);
    expect(pauses[0].message).toMatch(/^## ⏸️ Paused\n\nThe agent has taken 10 steps without finishing\. Keep going\?/);
  });

  it('stops right away when the user stops a paused run', async () => {
    const { deps } = fakeDeps(typing, { onPause: () => stopRun(11) });
    const result = await startRun(deps, 11, 'Type', { checkpoint: 5 });
    expect(result.status).toBe('stopped');
    expect(deps.plan).toHaveBeenCalledTimes(5);
  });

  it('stops a pause nobody answers', async () => {
    const { deps } = fakeDeps(typing);
    (deps.sleep as any).mockImplementation(async () => {}); // the 10-minute timeout fires at once
    const result = await startRun(deps, 12, 'Type', { checkpoint: 3 });
    expect(result.status).toBe('stopped');
    expect(result.message).toContain('Paused for 10 minutes without an answer');
  });

  it('warns on a repeated action, then pauses instead of running it a third time', async () => {
    const { deps, prompts } = fakeDeps(['{"action":"click","elementId":4}'], { onPause: () => stopRun(13) });
    const result = await startRun(deps, 13, 'Click it');
    expect(result.status).toBe('stopped');
    expect(prompts[1]).toEqual(['click [4] → ✅ ran click']);
    expect(prompts[2][1]).toMatch(/^click \[4\] → ✅ ran click ⚠️ You already did exactly this on this same page/);
    const executed = (deps.send as any).mock.calls.filter(([, m]: any) => m.action === 'AGENT_EXECUTE');
    expect(executed).toHaveLength(2);
  });

  it('after the user continues a stuck run, tells the model to change course', async () => {
    let paused = 0;
    const { deps, prompts } = fakeDeps([
      '{"action":"click","elementId":4}', '{"action":"click","elementId":4}', '{"action":"click","elementId":4}',
      '{"action":"done","summary":"gave up on the button"}',
    ], { onPause: () => { paused++; resumeRun(14); } });
    const result = await startRun(deps, 14, 'Click it');
    expect(result.status).toBe('done');
    expect(paused).toBe(1);
    expect(prompts[3][2]).toBe('click [4] → ⏸️ not run: you chose this 3 times on this unchanged page. Do something different.');
  });

  it('does not count the same action as a repeat when the page changed', async () => {
    let n = 0;
    const { deps } = fakeDeps(['{"action":"scroll","direction":"down"}']);
    (deps.send as any).mockImplementation(async (_id: number, m: any) =>
      m.action === 'AGENT_SNAPSHOT' ? { text: `rows 1-${++n * 10}` } : { ok: true });
    (deps.plan as any).mockImplementation(async () => (n >= 8 ? '{"action":"done","summary":"loaded all"}' : '{"action":"scroll","direction":"down"}'));
    const result = await startRun(deps, 15, 'Load everything');
    expect(result.status).toBe('done');
  });
});

describe('history sent to the model', () => {
  it('keeps every note but only the most recent other steps', () => {
    const history = ['navigate https://a.test/ → ✅', 'note "Aero costs $899" → ✅ noted',
      ...Array.from({ length: PROMPT_RECENT_STEPS + 5 }, (_, i) => `scroll down → ✅ ${i}`)];
    const lines = promptHistory(history);
    expect(lines[0]).toBe('(1 earlier step not shown)');
    expect(lines[1]).toBe('2. note "Aero costs $899" → ✅ noted');
    expect(lines[2]).toBe('(5 earlier steps not shown)');
    expect(lines[3]).toBe('8. scroll down → ✅ 5');
    expect(lines).toHaveLength(3 + PROMPT_RECENT_STEPS);
  });

  it('sends a short history unchanged', () => {
    expect(promptHistory(['a', 'b'])).toEqual(['1. a', '2. b']);
  });
});

describe('automatic memory of visited pages', () => {
  it('shows earlier pages\' text to the model, but not the current page', async () => {
    const pages: Record<string, string> = {
      'https://shop.test/a': 'PAGE: A\n--- VISIBLE TEXT (excerpt) ---\nAero 13 Price $899 Memory (RAM) 8 GB',
      'https://shop.test/b': 'PAGE: B\n--- VISIBLE TEXT (excerpt) ---\nKite 14 Price $1,049 Memory (RAM) 16 GB',
    };
    const { deps, tab } = fakeDeps([
      '{"action":"navigate","url":"https://shop.test/b"}',
      '{"action":"done","summary":"Kite 14"}',
    ]);
    tab.url = 'https://shop.test/a';
    const snapshots: string[] = [];
    (deps.send as any).mockImplementation(async (_id: number, m: any) =>
      m.action === 'AGENT_SNAPSHOT' ? { text: pages[tab.url!] } : { ok: true });
    (deps.plan as any).mockImplementation(async (_g: string, snap: string) => {
      snapshots.push(snap);
      return snapshots.length === 1 ? '{"action":"navigate","url":"https://shop.test/b"}' : '{"action":"done","summary":"Kite 14"}';
    });

    await startRun(deps, 7, 'Buy the cheapest laptop with 16 GB');

    expect(snapshots[0]).not.toContain('PAGES YOU VISITED EARLIER'); // nothing earlier yet
    expect(snapshots[1]).toContain('--- PAGES YOU VISITED EARLIER');
    expect(snapshots[1]).toContain('- https://shop.test/a: Aero 13 Price $899 Memory (RAM) 8 GB');
    expect(snapshots[1].split('PAGES YOU VISITED EARLIER')[1]).not.toContain('Kite 14'); // current page isn't repeated
  });
});

describe('several actions per response', () => {
  it('runs them all from one model call, then shows each in the history', async () => {
    const { deps, prompts } = fakeDeps([
      '{"plan":["[ ] Fill the form","[ ] Submit"],"actions":[{"action":"type","elementId":1,"text":"demo"},{"action":"type","elementId":2,"text":"pw"},{"action":"click","elementId":3}]}',
      '{"action":"done","summary":"Signed in"}',
    ]);
    const result = await startRun(deps, 20, 'Sign in');
    expect(result.status).toBe('done');
    expect(deps.plan).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toEqual(['type [1] "demo" → ✅ ran type', 'type [2] "pw" → ✅ ran type', 'click [3] → ✅ ran click']);
  });

  it('skips the rest when an action changes the page', async () => {
    const { deps, prompts } = fakeDeps([
      '{"actions":[{"action":"click","elementId":1},{"action":"type","elementId":2,"text":"x"},{"action":"click","elementId":3}]}',
      '{"action":"done","summary":"ok"}',
    ], {
      onExecute: (tab, action) => {
        if (action.elementId === 1) { tab.url = 'https://shop.test/next'; tab.title = 'Next'; notifyTabLoading(21); }
        return `✅ ran ${action.action}`;
      },
    });
    await startRun(deps, 21, 'Go on');
    expect(prompts[1]).toEqual([
      'click [1] → ✅ ran click; page changed, now on "Next" (https://shop.test/next)',
      '(note from Genesis) 2 more actions not run: the page changed, so they may not fit it any more',
    ]);
  });

  it('skips the rest when an action fails', async () => {
    const { deps, prompts } = fakeDeps([
      '{"actions":[{"action":"click","elementId":9},{"action":"click","elementId":3}]}',
      '{"action":"done","summary":"ok"}',
    ], { onExecute: (_tab, action) => (action.elementId === 9 ? '❌ Element [9] not found' : '✅ ok') });
    await startRun(deps, 22, 'Click');
    expect(prompts[1]).toEqual(['click [9] → ❌ Element [9] not found', '(note from Genesis) 1 more action not run: the action above failed']);
  });

  it('keeps the latest plan, sends it back to the model and shows it', async () => {
    const plans: string[][] = [];
    const updates: RunView[] = [];
    const { deps } = fakeDeps([]);
    const answers = [
      '{"plan":["[ ] Find the order","[ ] Read its status"],"actions":[{"action":"click","elementId":1}]}',
      '{"actions":[{"action":"scroll","direction":"down"}]}',
      '{"plan":["[x] Find the order","[ ] Read its status"],"actions":[{"action":"note","text":"Shipped"},{"action":"done","summary":"Shipped"}]}',
    ];
    (deps.plan as any).mockImplementation(async (_g: string, _s: string, _h: string[], plan: string[]) => {
      plans.push([...plan]);
      return answers[plans.length - 1];
    });
    const send = deps.send as any;
    const original = send.getMockImplementation();
    send.mockImplementation(async (id: number, m: any, t: number) => {
      if (m.action === 'AGENT_UPDATE') updates.push(m.payload);
      return original(id, m, t);
    });

    const result = await startRun(deps, 23, 'Check my order');
    expect(result.status).toBe('done');
    expect(result.message).toMatch(/Task Complete\n\nShipped/);
    expect(plans).toEqual([[], ['[ ] Find the order', '[ ] Read its status'], ['[ ] Find the order', '[ ] Read its status']]);
    expect(result.plan).toEqual(['[x] Find the order', '[ ] Read its status']);
    expect(updates.some((u) => u.message.includes('**Plan**\n- ☐ Find the order\n- ☐ Read its status'))).toBe(true);
  });
});
