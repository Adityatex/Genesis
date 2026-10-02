import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDOMSnapshot, describeElement, resolveElement, elementKey } from '@/lib/agent/domSnapshot';
import { startRun, getRunRecord, type RunnerDeps, type TabInfo } from '@/lib/agent/runner';
import { describeStep, saveWorkflow, loadWorkflows, deleteWorkflow, type Workflow } from '@/lib/workflows/workflow';
import type { KeyValueStorage } from '@/lib/skills/store';

describe('finding a recorded element again', () => {
  beforeEach(() => {
    // happy-dom has no layout engine: give every element a box so it counts as visible
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) },
    );
    document.body.innerHTML = `
      <input aria-label="Username" value="">
      <button>Add to cart</button><button>Add to cart</button><button>Add to cart</button>
      <a href="/help">Help</a>`;
  });

  it('describes elements by what they are, telling look-alikes apart', () => {
    const { elements } = createDOMSnapshot();
    const third = elements.filter((e) => e.label === 'Add to cart')[2];
    expect(describeElement(third.id)).toEqual({ key: '<button> "Add to cart"', nth: 2 });
  });

  it('finds the same element after the page is snapshotted again, even with a typed value', () => {
    const { elements } = createDOMSnapshot();
    const username = describeElement(elements.find((e) => e.label === 'Username')!.id)!;
    (document.querySelector('input') as HTMLInputElement).value = 'ada';
    document.body.insertAdjacentHTML('afterbegin', '<button>New banner button</button>'); // IDs shift
    const again = createDOMSnapshot().elements;
    const id = resolveElement(username);
    expect(again.find((e) => e.id === id)?.label).toBe('Username');
  });

  it('falls back to the same tag and label when details changed, and gives up if that is ambiguous', () => {
    createDOMSnapshot();
    expect(resolveElement({ key: '<a> "Help" href="https://old.example/help"', nth: 0 })).not.toBeNull();
    expect(resolveElement({ key: '<button> "Add to cart" [disabled]', nth: 0 })).toBeNull(); // three candidates
    expect(resolveElement({ key: '<button> "Checkout"', nth: 0 })).toBeNull();
  });

  it('leaves typed values and state out of the description', () => {
    expect(elementKey({ id: 3, tag: 'input', role: 'input', label: 'Email', value: 'a@b.c', checked: true, states: ['expanded'], selector: '#email' }))
      .toBe('<input> "Email"');
  });
});

describe('workflow storage and log lines', () => {
  function memory(): KeyValueStorage {
    const data: Record<string, unknown> = {};
    return { get: async (k) => ({ [k]: data[k] }), set: async (items) => { Object.assign(data, items); } };
  }
  const wf = (name: string): Workflow => ({ name, goal: 'Log in', steps: [] });

  it('saves, replaces by name and deletes', async () => {
    const storage = memory();
    await saveWorkflow(storage, wf('login'));
    await saveWorkflow(storage, { ...wf('login'), goal: 'Log in again' });
    await saveWorkflow(storage, wf('order'));
    expect((await loadWorkflows(storage)).map((w) => `${w.name}: ${w.goal}`)).toEqual(['login: Log in again', 'order: Log in']);
    await deleteWorkflow(storage, 'login');
    expect((await loadWorkflows(storage)).map((w) => w.name)).toEqual(['order']);
  });

  it('never shows a typed password', () => {
    expect(describeStep({ action: { action: 'type', text: 'hunter2' }, target: { key: '<input> type="password" "Password"', nth: 0 } }))
      .toBe('type <input> type="password" "Password" "••••"');
    expect(describeStep({ action: { action: 'click' }, target: { key: '<button> "Add"', nth: 1 } })).toBe('click <button> "Add" (#2)');
  });
});

/** A fake tab whose elements are looked up by description, and a planner that may not be needed. */
function fakeDeps(opts: { resolve?: (target: any) => number | null; answers?: string[]; execute?: (action: any) => string } = {}) {
  const tab: TabInfo = { status: 'complete', url: 'https://shop.test/login', title: 'Log in' };
  const executed: any[] = [];
  const answers = opts.answers ?? ['{"action":"done","summary":"ok"}'];
  let i = 0;
  const histories: string[][] = [];
  const deps: RunnerDeps = {
    plan: vi.fn(async (_g: string, _s: string, history: string[]) => {
      histories.push([...history]);
      return answers[Math.min(i++, answers.length - 1)];
    }),
    send: vi.fn(async (_t: number, m: any) => {
      if (m.action === 'AGENT_SNAPSHOT') return { text: 'PAGE' };
      if (m.action === 'AGENT_DESCRIBE') return { key: `<el> "${m.id}"`, nth: 0 };
      if (m.action === 'AGENT_RESOLVE') return { id: opts.resolve ? opts.resolve(m.target) : 7 };
      if (m.action === 'AGENT_EXECUTE') {
        executed.push(m.payload);
        return opts.execute ? opts.execute(m.payload) : `✅ ran ${m.payload.action}`;
      }
      return { ok: true };
    }),
    getTab: vi.fn(async () => ({ ...tab })),
    navigate: vi.fn(async (_id: number, url: string) => { tab.url = url; }),
    onRunEnded: vi.fn(),
    sleep: vi.fn(async () => {}),
  };
  return { deps, tab, executed, histories };
}

describe('recording a run', () => {
  it('keeps the steps that acted and worked, with their elements described', async () => {
    const { deps } = fakeDeps({
      answers: [
        '{"actions":[{"action":"type","elementId":1,"text":"demo"},{"action":"note","text":"x"},{"action":"find","text":"Sign"},{"action":"click","elementId":3}]}',
        '{"action":"done","summary":"Signed in"}',
      ],
      execute: (a) => (a.action === 'find' ? '🔎 found' : `✅ ran ${a.action}`),
    });
    await startRun(deps, 300, 'Sign in');
    const record = getRunRecord(300)!;
    expect(record.startUrl).toBe('https://shop.test/login');
    expect(record.trace).toEqual([
      { action: { action: 'type', text: 'demo' }, target: { key: '<el> "1"', nth: 0 }, url: 'https://shop.test/login' },
      { action: { action: 'click' }, target: { key: '<el> "3"', nth: 0 }, url: 'https://shop.test/login' },
    ]);
    expect(record.unrecordable).toBeUndefined();
  });

  it('marks a run unrecordable when an element could not be described', async () => {
    const { deps } = fakeDeps({ answers: ['{"action":"click","elementId":5}', '{"action":"done","summary":"ok"}'] });
    (deps.send as any).mockImplementation(async (_t: number, m: any) =>
      (m.action === 'AGENT_DESCRIBE' ? null : m.action === 'AGENT_SNAPSHOT' ? { text: 'PAGE' } : m.action === 'AGENT_EXECUTE' ? '✅ ok' : { ok: true }));
    await startRun(deps, 301, 'Click');
    expect(getRunRecord(301)!.unrecordable).toContain('element [5]');
  });
});

describe('replaying a workflow', () => {
  const workflow: Workflow = {
    name: 'sign-in',
    goal: 'Sign in as demo',
    startUrl: 'https://shop.test/login',
    steps: [
      { action: { action: 'type', text: 'demo' }, target: { key: '<input> "Username"', nth: 0 } },
      { action: { action: 'click' }, target: { key: '<button> "Sign in"', nth: 0 } },
    ],
    finalUrl: 'https://shop.test/login',
  };

  it('replays every step with no model calls, starting where the recording started', async () => {
    const { deps, tab, executed } = fakeDeps();
    tab.url = 'https://shop.test/';
    const view = await startRun(deps, 310, workflow.goal, { workflow });
    expect(deps.navigate).toHaveBeenCalledWith(310, 'https://shop.test/login');
    expect(executed).toEqual([{ action: 'type', text: 'demo', elementId: 7 }, { action: 'click', elementId: 7 }]);
    expect(deps.plan).not.toHaveBeenCalled();
    expect(view).toMatchObject({ status: 'done', replay: 'replayed', workflowName: 'sign-in' });
    expect(view.message).toMatch(/^## ✅ Task Complete\n\nReplayed the workflow "sign-in": 2 steps, no model calls\. Now on "Log in"/);
  });

  it('lets the agent take over when a step no longer fits, and says what happened', async () => {
    const { deps, histories } = fakeDeps({ resolve: (t) => (t.key.includes('Sign in') ? null : 7), answers: ['{"action":"done","summary":"Signed in via the new button"}'] });
    const view = await startRun(deps, 311, workflow.goal, { workflow });
    expect(deps.plan).toHaveBeenCalledTimes(1);
    expect(histories[0]).toEqual([
      '↻ type <input> "Username" "demo" → ✅ ran type',
      '(note from Tabi) Replaying the saved workflow "sign-in": steps 1-1 worked, but step 2 (click <button> "Sign in") didn\'t: its element (<button> "Sign in") isn\'t on the page any more. The page may have changed. Carry on with the task from here yourself.',
    ]);
    expect(view).toMatchObject({ status: 'done', replay: 'healed' });
  });

  it('shows the panel the steps to come while it replays, and what went as recorded', async () => {
    const seen: any[] = [];
    const { deps } = fakeDeps();
    const send = deps.send as any;
    const inner = send.getMockImplementation();
    send.mockImplementation(async (t: number, m: any) => {
      if (m.action === 'AGENT_UPDATE' && m.payload.replaySteps) seen.push(m.payload.replaySteps);
      return inner(t, m);
    });
    const view = await startRun(deps, 313, workflow.goal, { workflow: { ...workflow, createdAt: 1000 } });
    expect(seen[0]).toEqual({ total: 2, savedAt: 1000, upcoming: ['Type “demo” into “Username”', 'Click “Sign in”'] });
    expect(seen.some((r) => JSON.stringify(r.upcoming) === '["Click “Sign in”"]')).toBe(true); // while the first step runs
    expect(view.steps.map((s) => [s.action, s.result])).toEqual([['Typed “demo” into “Username”', 'Same as last time'], ['Clicked “Sign in”', 'Same as last time']]);
    expect(view.replaySteps).toBeUndefined(); // finished
  });

  it('shows the step that no longer fits as failed, then the agent\'s own steps', async () => {
    const { deps } = fakeDeps({
      resolve: (t) => (t.key.includes('Sign in') ? null : 7),
      answers: ['{"plan":["[ ] Sign in"],"action":"click","elementId":4}', '{"action":"done","summary":"Signed in via the new button"}'],
    });
    const view = await startRun(deps, 314, workflow.goal, { workflow });
    expect(view.steps.map((s) => [s.status, s.action, s.result])).toEqual([
      ['ok', 'Typed “demo” into “Username”', 'Same as last time'],
      ['fail', 'Click “Sign in”', 'Not found: the site changed'],
      ['ok', 'Clicked “4”', 'Done'],
    ]);
    expect(view.steps[2].planItem).toBe('Sign in');
  });

  it('warns when the replay ended somewhere the recording did not', async () => {
    const { deps } = fakeDeps();
    const view = await startRun(deps, 312, workflow.goal, { workflow: { ...workflow, finalUrl: 'https://shop.test/account' } });
    expect(view.message).toContain('⚠️ The recorded run ended on https://shop.test/account, so check this worked.');
  });
});

describe('workflow names', () => {
  it('are short, clean, and never contain a typed password', async () => {
    const { workflowName } = await import('@/lib/workflows/workflow');
    const login = [{ action: { action: 'type' as const, text: 'hunter2' }, target: { key: '<input> type="password" "Password"', nth: 0 } }];
    expect(workflowName('Log in with username demo and password hunter2', login)).toBe('log-in-with-username-demo-and');
    expect(workflowName('Buy the cheapest laptop that has at least 16 GB of RAM', [])).toBe('buy-the-cheapest-laptop-that-has');
    expect(workflowName('!!!', [])).toBe('workflow');
    expect(workflowName('Check my order status on the shop, please', [])).not.toMatch(/-$/);
  });
});
