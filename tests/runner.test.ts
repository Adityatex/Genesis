import { describe, it, expect, vi } from 'vitest';
import { startRun, stopRun, resumeRun, getRunView, notifyTabLoading, changesSection, textChanges, PLANNER_EVERY, type RunnerDeps, type RunView, type TabInfo } from '@/lib/agent/runner';
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
  it('keeps every note but only the most recent other steps, dropping old ones 10 at a time', () => {
    // 2 + 35 = 37 steps: 12 over the 25 kept, so the oldest 10 go
    const history = ['navigate https://a.test/ → ✅', 'note "Aero costs $899" → ✅ noted',
      ...Array.from({ length: PROMPT_RECENT_STEPS + 10 }, (_, i) => `scroll down → ✅ ${i}`)];
    const lines = promptHistory(history);
    expect(lines[0]).toBe('(1 earlier step not shown)');
    expect(lines[1]).toBe('2. note "Aero costs $899" → ✅ noted');
    expect(lines[2]).toBe('(8 earlier steps not shown)');
    expect(lines[3]).toBe('11. scroll down → ✅ 8');
    expect(lines).toHaveLength(3 + 27);
  });

  it('keeps the start of the history the same for several steps, for prompt caching', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => `scroll down → ✅ ${i}`);
    const at = (n: number) => promptHistory(steps(n))[0];
    expect(at(PROMPT_RECENT_STEPS + 3)).toBe('1. scroll down → ✅ 0'); // under a block over: nothing dropped yet
    expect(at(PROMPT_RECENT_STEPS + 10)).toBe('(10 earlier steps not shown)');
    expect(at(PROMPT_RECENT_STEPS + 19)).toBe('(10 earlier steps not shown)');
    expect(at(PROMPT_RECENT_STEPS + 20)).toBe('(20 earlier steps not shown)');
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

describe('handing a task to a backup provider', () => {
  it('tells the new model it is continuing, with the plan and everything done so far', async () => {
    const plans: string[][] = [];
    const { deps, prompts } = fakeDeps([]);
    const replies = [
      { text: '{"plan":["[ ] Fill the form","[ ] Submit"],"actions":[{"action":"type","elementId":1,"text":"Ada"}]}', model: 'Groq · qwen' },
      // Groq is rate-limited; Gemini answers the next call
      { text: '{"plan":["[x] Fill the form","[ ] Submit"],"actions":[{"action":"click","elementId":2}]}', model: 'Gemini · flash-lite', unavailable: [{ label: 'Groq · qwen', reason: 'hit its rate limit' }] },
      { text: '{"action":"done","summary":"Submitted"}', model: 'Gemini · flash-lite' },
    ];
    (deps.plan as any).mockImplementation(async (_g: string, _s: string, history: string[], plan: string[]) => {
      prompts.push([...history]);
      plans.push([...plan]);
      return replies[plans.length - 1];
    });

    const result = await startRun(deps, 30, 'Sign up as Ada');
    expect(result.status).toBe('done');
    expect(result.model).toBe('Gemini · flash-lite');
    // Gemini's first call already had Groq's plan and history...
    expect(plans[1]).toEqual(['[ ] Fill the form', '[ ] Submit']);
    expect(prompts[1]).toEqual(['type [1] "Ada" → ✅ ran type']);
    // ...and the call after the switch is told what happened
    expect(prompts[2][1]).toMatch(/^\(handoff\) Groq · qwen hit its rate limit, so Gemini · flash-lite takes over from here\. This task is already under way: plan items marked \[x\] are done, \[ \] items are left/);
  });

  it('notes a switch back to the main model without a reason', async () => {
    const { deps, prompts } = fakeDeps([]);
    const replies = [
      { text: '{"action":"scroll"}', model: 'Gemini · flash-lite' },
      { text: '{"action":"note","text":"x"}', model: 'Groq · qwen' },
      { text: '{"action":"done","summary":"ok"}', model: 'Groq · qwen' },
    ];
    let i = 0;
    (deps.plan as any).mockImplementation(async (_g: string, _s: string, history: string[]) => {
      prompts.push([...history]);
      return replies[i++];
    });
    await startRun(deps, 31, 'Anything');
    expect(prompts[2][1]).toMatch(/^\(handoff\) Groq · qwen takes over from Gemini · flash-lite here\./);
  });
});

describe('planner and fast executor models', () => {
  /** Runs a scripted task and records which role each call went to. */
  async function roles(answers: string[], opts: { split?: boolean; onExecute?: (tab: TabInfo, action: any) => unknown } = {}) {
    const calls: { role: string; history: string[] }[] = [];
    const { deps } = fakeDeps([], { onExecute: opts.onExecute });
    (deps.plan as any).mockImplementation(async (_g: string, _s: string, history: string[], _p: string[], role: string) => {
      calls.push({ role, history: [...history] });
      const text = answers[Math.min(calls.length - 1, answers.length - 1)];
      return { text, model: role === 'executor' ? 'Groq · fast' : 'Groq · smart' };
    });
    const result = await startRun(deps, 40 + Math.floor(Math.random() * 1000), 'Task', { split: opts.split ?? true });
    return { result, calls, order: calls.map((c) => c.role) };
  }
  const typing = (n: number) => Array.from({ length: n }, (_, i) => `{"action":"type","elementId":1,"text":"t${i}"}`);

  it('sends everything to the main model when no fast model is set up', async () => {
    const { order } = await roles([...typing(3), '{"action":"done","summary":"ok"}'], { split: false });
    expect(order).toEqual(['planner', 'planner', 'planner', 'planner']);
  });

  it('plans with the main model, then hands routine steps to the fast one, re-checking regularly', async () => {
    const { order } = await roles([...typing(PLANNER_EVERY + 3), '{"action":"done","summary":"ok"}']);
    expect(order.slice(0, PLANNER_EVERY + 3)).toEqual([
      'planner', ...Array(PLANNER_EVERY).fill('executor'), 'planner', 'executor',
    ]);
  });

  it('brings the main model back after an action fails', async () => {
    const { order } = await roles(
      ['{"action":"click","elementId":1}', '{"action":"click","elementId":9}', '{"action":"click","elementId":2}', '{"action":"done","summary":"ok"}'],
      { onExecute: (_t, a) => (a.elementId === 9 ? '❌ Element [9] not found' : '✅ ok') },
    );
    expect(order).toEqual(['planner', 'executor', 'planner', 'executor', 'planner']); // the last one confirms "done"
  });

  it('has the main model confirm when the fast model says it is done', async () => {
    const { result, calls, order } = await roles(['{"action":"click","elementId":1}', '{"action":"done","summary":"Ordered"}']);
    // planner clicks; executor says done; planner is asked and confirms
    expect(order).toEqual(['planner', 'executor', 'planner']);
    expect(calls[2].history.at(-1)).toBe('(note from Genesis) The fast model says the goal is complete: "Ordered". Check the page: if it really is, send "done"; if not, carry on.');
    expect(result.status).toBe('done');
  });

  it('writes no handoff note for the routine switch between the two models', async () => {
    const { calls } = await roles([...typing(3), '{"action":"done","summary":"ok"}']);
    expect(calls.flatMap((c) => c.history).some((h) => h.startsWith('(handoff)'))).toBe(false);
  });
});

describe('screenshots', () => {
  async function shots(mode: 'off' | 'planning' | 'always', answers: string[], opts: { onExecute?: (tab: TabInfo, a: any) => unknown; dropped?: boolean } = {}) {
    const { deps, prompts } = fakeDeps([], { onExecute: opts.onExecute });
    const images: (string | undefined)[] = [];
    const visualAsked: boolean[] = [];
    const send = deps.send as any;
    const original = send.getMockImplementation();
    send.mockImplementation(async (id: number, m: any, t: number) => {
      if (m.action === 'AGENT_SNAPSHOT') {
        visualAsked.push(!!m.visual);
        return { text: `PAGE ${visualAsked.length}`, ...(m.visual ? { visual: { marks: [] } } : {}) };
      }
      return original(id, m, t);
    });
    deps.screenshot = vi.fn(async () => 'data:image/jpeg;base64,SHOT');
    (deps.plan as any).mockImplementation(async (_g: string, _s: string, history: string[], _p: string[], _r: string, image?: string) => {
      prompts.push([...history]);
      images.push(image);
      return { text: answers[Math.min(images.length - 1, answers.length - 1)], model: 'Gemini · flash', imageDropped: opts.dropped && !!image };
    });
    const result = await startRun(deps, 60 + Math.floor(Math.random() * 1000), 'Task', { screenshots: mode });
    return { result, images, visualAsked, deps, prompts };
  }
  const typing = (n: number) => Array.from({ length: n }, (_, i) => `{"action":"type","elementId":1,"text":"t${i}"}`);

  it('takes none when off', async () => {
    const { images, visualAsked, deps } = await shots('off', [...typing(2), '{"action":"done","summary":"ok"}']);
    expect(images.every((i) => i === undefined)).toBe(true);
    expect(visualAsked.every((v) => !v)).toBe(true);
    expect(deps.screenshot).not.toHaveBeenCalled();
  });

  it('sends one with every step when set to always', async () => {
    const { images } = await shots('always', [...typing(2), '{"action":"done","summary":"ok"}']);
    expect(images).toEqual(['data:image/jpeg;base64,SHOT', 'data:image/jpeg;base64,SHOT', 'data:image/jpeg;base64,SHOT']);
  });

  it('on planning steps only: the first, after a failure, and every 5th', async () => {
    const answers = ['{"action":"click","elementId":9}', ...typing(PLANNER_EVERY + 1), '{"action":"done","summary":"ok"}'];
    const { images } = await shots('planning', answers, { onExecute: (_t, a) => (a.elementId === 9 ? '❌ Element [9] not found' : '✅ ok') });
    const sent = images.map((i) => (i ? 'shot' : '-'));
    // step 1 plans; its click fails, so step 2 re-plans; then 5 routine steps; step 8 re-checks
    expect(sent.slice(0, 8)).toEqual(['shot', 'shot', '-', '-', '-', '-', '-', 'shot']);
  });

  it('carries on with text only when no screenshot can be taken', async () => {
    const { deps } = fakeDeps(['{"action":"done","summary":"ok"}']);
    const send = deps.send as any;
    const original = send.getMockImplementation();
    send.mockImplementation(async (id: number, m: any, t: number) =>
      (m.action === 'AGENT_SNAPSHOT' ? { text: 'PAGE', visual: { marks: [] } } : original(id, m, t)));
    deps.screenshot = vi.fn(async () => { throw new Error('tab hidden'); });
    const result = await startRun(deps, 70, 'Task', { screenshots: 'always' });
    expect(result.status).toBe('done');
    expect(deps.screenshot).toHaveBeenCalledTimes(1);
    expect((deps.plan as any).mock.calls[0][5]).toBeUndefined();
  });

  it('says once when a model can\'t read the screenshots', async () => {
    const { prompts } = await shots('always', [...typing(2), '{"action":"done","summary":"ok"}'], { dropped: true });
    const notes = prompts.at(-1)!.filter((h) => h.includes("doesn't accept images"));
    expect(notes).toEqual(["(note from Genesis) Screenshots are on, but Gemini · flash doesn't accept images, so it gets the page as text only."]);
  });
});

describe('what changed after the last actions', () => {
  const page = (elements: string[], text: string[]) =>
    `PAGE: Sign up\n--- INTERACTIVE ELEMENTS (${elements.length}) ---\n${elements.join('\n')}\n\n--- VISIBLE TEXT (excerpt) ---\n${text.join('\n')}`;

  it('reports new text, elements that appeared (with their new IDs) and ones that went away', () => {
    const before = page(['[0] <input> "Username"', '[1] <button> "Create account"'], ['Sign up', 'Pick a username']);
    const after = page(['[0] <input> "Username" value="ada"', '[1] <a> "Try ada_l instead"', '[2] <button> "Create account"'],
      ['Sign up', 'Pick a username', 'That username is taken']);
    expect(changesSection(before, after)).toBe(
      '\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\n'
      + 'New text: "That username is taken"\n'
      + 'New elements:\n[1] <a> "Try ada_l instead"',
    );
  });

  it('says so when nothing changed, and ignores values that were just typed', () => {
    const before = page(['[0] <input> "Email"'], ['Newsletter']);
    const after = page(['[0] <input> "Email" value="a@b.c"'], ['Newsletter']);
    expect(changesSection(before, after)).toBe('\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNothing visible changed on the page. That is not always a failure (some actions give no feedback): if the history says your action worked, do not repeat it.');
  });

  it('lists elements that are gone, e.g. a closed popup', () => {
    const before = page(['[0] <button> "No thanks"', '[1] <button> "Download"'], ['Subscribe?', 'Report']);
    const after = page(['[0] <button> "Download"'], ['Report']);
    expect(changesSection(before, after)).toBe('\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nText gone: "Subscribe?"\nGone: <button> "No thanks"');
  });

  it('finds a sentence added to page text that is all one line (the compare-and-buy bug)', () => {
    // The whole page reported as new text, cut off before the one sentence that was new
    const specs = 'All laptops Kite 14 Price $1,049 Memory (RAM) 16 GB Storage 512 GB SSD Screen 14" Add to cart';
    const before = page(['[0] <button> "Add to cart"'], [specs]);
    const after = page(['[0] <button> "Add to cart"'], [`${specs} Kite 14 added to your cart.`]);
    expect(changesSection(before, after)).toBe('\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNew text: "Kite 14 added to your cart."');
  });

  it('reports separate changes separately, and ignores a ticking number', () => {
    const w = (s: string) => s.split(' ');
    expect(textChanges(w('Cart 1 items Welcome back Total due'), w('Cart 2 items Welcome back Payment failed: card declined Total due')))
      .toEqual({ added: ['2', 'Payment failed: card declined'], removed: ['1'] });
    const before = page([], ['Session 1:59 left Please sign in']);
    const after = page([], ['Session 1:58 left Please sign in Wrong password']);
    // "1:59" → "1:58" is too short to mention; the error is not
    expect(changesSection(before, after)).toBe('\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNew text: "Wrong password"');
  });

  it('is added on the same page after actions, but not on the first step or a new page', async () => {
    const snaps: string[] = [];
    const { deps, tab } = fakeDeps([
      '{"action":"click","elementId":1}',
      '{"action":"navigate","url":"https://shop.test/next"}',
      '{"action":"done","summary":"ok"}',
    ]);
    const plan = deps.plan as any;
    const original = plan.getMockImplementation();
    plan.mockImplementation(async (...args: any[]) => { snaps.push(args[1]); return original(...args); });
    tab.url = 'https://shop.test/';
    await startRun(deps, 80, 'Go');
    expect(snaps[0]).not.toContain('WHAT CHANGED'); // first look at the page
    expect(snaps[1]).toContain('WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNothing visible changed'); // same page after the click
    expect(snaps[2]).not.toContain('WHAT CHANGED'); // a different page
  });
});

describe('missing pages', () => {
  it('recognises error page titles', async () => {
    const { isNotFound } = await import('@/lib/agent/runner');
    for (const t of ['404 Not Found', 'Page not found', 'Not Found - Shop', 'This page does not exist']) expect(isNotFound(t)).toBe(true);
    for (const t of ['Found it! Best deals', 'Lost and Found Office', 'Kite 14 - Byte Store', undefined]) expect(isNotFound(t)).toBe(false);
  });

  it('reports landing on one as a failure, which also stops the batch', async () => {
    const { deps, prompts, tab } = fakeDeps(['{"actions":[{"action":"navigate","url":"https://shop.test/cart"},{"action":"click","elementId":1}]}', '{"action":"done","summary":"ok"}']);
    (deps.navigate as any).mockImplementation(async (_id: number, url: string) => { tab.url = url; tab.title = 'Page not found'; });
    await startRun(deps, 95, 'Check out');
    expect(prompts[1]).toEqual([
      'navigate https://shop.test/cart → ❌ landed on "Page not found" (https://shop.test/cart): that page doesn\'t exist. Don\'t guess URLs; use links you have seen.',
      '(note from Genesis) 1 more action not run: the page changed, so they may not fit it any more',
    ]);
  });
});
