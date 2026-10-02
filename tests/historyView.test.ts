import { describe, it, expect } from 'vitest';
import {
  callsLabel, compactNumber, dayLabel, foldTimeline, groupByDay, matchesRun, runMark, runSite, runStats, runTags, seenChanges,
  stepFromText, timelineNodes, type RunHeader, type TimelineNode,
} from '@/lib/history/view';
import type { RunLog, TimelineEntry } from '@/lib/agent/timeline';

const header = (over: Partial<RunHeader>): RunHeader => ({
  id: 'r', goal: 'Order coffee', started: 0, ended: 1, status: 'done', calls: 2, checks: 0, tokens: 0, entryCount: 0, ...over,
});

let clock = 1_000;
const entry = (kind: TimelineEntry['kind'], text: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({ at: clock += 1000, kind, text, ...over });
const ok = (n: number, action = `Clicked “Button ${n}”`): TimelineEntry =>
  entry('step', `click [${n}] → ✅ Clicked`, { step: { n, status: 'ok', action, result: 'Done' } });
const kinds = (nodes: TimelineNode[]) => nodes.map((n) => n.kind);

describe('the list of runs', () => {
  it('filters by chip and search', () => {
    const done = header({ goal: 'Order coffee', source: 'panel' });
    const failed = header({ goal: 'Check grades', status: 'error', source: 'schedule', workflow: 'check-grades' });
    const mcp = header({ goal: 'Fill the signup', source: 'mcp', status: 'stopped' });
    const running = header({ goal: 'Still going', ended: undefined, status: 'running' });
    const all = [done, failed, mcp, running];
    expect(all.filter((r) => matchesRun(r, 'all', ''))).toHaveLength(4);
    expect(all.filter((r) => matchesRun(r, 'done', ''))).toEqual([done]);
    expect(all.filter((r) => matchesRun(r, 'failed', ''))).toEqual([failed]);
    expect(all.filter((r) => matchesRun(r, 'scheduled', ''))).toEqual([failed]);
    expect(all.filter((r) => matchesRun(r, 'mcp', ''))).toEqual([mcp]);
    expect(all.filter((r) => matchesRun(r, 'all', 'COFFEE'))).toEqual([done]);
    expect(all.filter((r) => matchesRun(r, 'all', 'check-gr'))).toEqual([failed]);
  });

  it('groups runs under their day', () => {
    const now = new Date(2026, 9, 3, 15, 0).getTime();
    const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
    expect(dayLabel(at(3, 9), now)).toBe('Today');
    expect(dayLabel(at(2, 23), now)).toBe('Yesterday');
    expect(dayLabel(at(28, 10), new Date(2026, 9, 3).getTime())).not.toBe('Today');
    expect(dayLabel(new Date(2025, 8, 28).getTime(), now)).toMatch(/2025/);
    const groups = groupByDay([{ started: at(3, 14) }, { started: at(3, 9) }, { started: at(2, 8) }], now);
    expect(groups.map((g) => [g.day, g.runs.length])).toEqual([['Today', 2], ['Yesterday', 1]]);
  });

  it('marks each run by how it went', () => {
    expect(runMark(header({}))).toBe('done');
    expect(runMark(header({ workflow: 'order-coffee', calls: 0 }))).toBe('replay');
    expect(runMark(header({ workflow: 'order-coffee', calls: 3 }))).toBe('done'); // the agent took over
    expect(runMark(header({ status: 'error' }))).toBe('failed');
    expect(runMark(header({ status: 'stopped' }))).toBe('stopped');
    expect(runMark(header({ ended: undefined, status: 'running' }))).toBe('running');
    expect(runMark(header({ ended: undefined, status: 'paused' }))).toBe('waiting');
  });

  it('says where a run came from, and counts in words', () => {
    expect(runTags(header({ source: 'schedule', workflow: 'price-check' }))).toEqual(['/price-check', 'scheduled']);
    expect(runTags(header({ source: 'panel' }))).toEqual([]);
    expect(runTags(header({ source: 'mcp' }))).toEqual(['from an AI app']);
    expect(callsLabel(0)).toBe('no AI calls');
    expect(callsLabel(1)).toBe('1 AI call');
    expect(compactNumber(980)).toBe('980');
    expect(compactNumber(2300)).toBe('2.3k');
    expect(compactNumber(41_234)).toBe('41k');
    expect(compactNumber(1_300_000)).toBe('1.3M');
  });
});

describe('a run’s timeline', () => {
  it('reads old runs’ steps from the model’s terse lines', () => {
    expect(stepFromText('click [3] → ✅ Clicked "Sign in"', 1)).toEqual({ n: 1, status: 'ok', action: 'click [3]', result: 'Clicked "Sign in"' });
    expect(stepFromText('click [9] → ❌ Element 9 not found', 2).status).toBe('fail');
    expect(stepFromText('↻ click "Buy" → ⛔ not run: the user refused it', 3)).toMatchObject({ status: 'skip', action: 'click "Buy"' });
  });

  it('turns entries into rows', () => {
    const nodes = timelineNodes([
      entry('model', 'Model chose the next actions (planning)', { model: 'Groq · qwen3' }),
      ok(1),
      entry('note', '(handoff) Groq · qwen3 hit its rate limit, so Gemini takes over from here. This task is already under way: plan items marked [x] are done.'),
      entry('note', '(note from Tabi) The user says: "use the blue one"'),
      entry('note', '(note from Tabi) 2 more actions not run: the page changed'),
      entry('check', 'Fits the task: type your address into “Street”', { detail: 'Checked because it sends data' }),
      entry('check', "Doesn't fit the task: open evil.example", { detail: 'the task is about shoes (checked because it leaves the site)' }),
      entry('ask', 'Asked to allow: Click “Place order”', { detail: "it looks like a purchase, which can't be undone. Answer: you allowed it", ms: 6000 }),
      entry('pause', 'Keep going?', { detail: 'Answer: you said keep going' }),
      entry('end', 'Finished', { detail: 'Ordered.' }),
    ]);
    expect(kinds(nodes)).toEqual(['model', 'step', 'handoff', 'said', 'note', 'check', 'check', 'ask', 'pause', 'end']);
    expect(nodes[0]).toMatchObject({ first: true });
    expect(nodes[2]).toMatchObject({ text: 'Groq · qwen3 hit its rate limit, so Gemini takes over from here.' });
    expect(nodes[3]).toMatchObject({ text: 'use the blue one' });
    expect(nodes[4]).toMatchObject({ text: '2 more actions not run: the page changed' });
    expect(nodes[5]).toMatchObject({ ok: true, step: 'type your address into “Street”' });
    expect(nodes[6]).toMatchObject({ ok: false, reason: 'the task is about shoes' });
    expect(nodes[7]).toMatchObject({ question: 'Allow Tabi to click “Place order”?', why: "It looks like a purchase, which can't be undone.", answer: 'you allowed it', allowed: true });
    expect(nodes[8]).toMatchObject({ answer: 'you said keep going' });
    expect(nodes[9]).toMatchObject({ status: 'done' });
  });

  it('folds routine stretches and keeps what matters in view', () => {
    const nodes = foldTimeline(timelineNodes([
      entry('model', 'Model chose the next actions'), // the plan: in view
      ok(1), ok(2), entry('model', 'Model chose the next actions'), ok(3),
      entry('step', 'click [7] → ❌ covered', { step: { n: 4, status: 'fail', action: 'Clicked “Apply code”', result: 'A banner was covering it' } }),
      entry('model', 'Model chose the next actions'), // decided what to do about it: in view
      ok(5),
      entry('model', 'Model chose the next actions'),
      entry('ask', 'Asked to allow: Click “Place order”', { detail: 'Answer: you allowed it' }),
      ok(6), // what was allowed: in view
      entry('end', 'Finished'),
    ]));
    expect(kinds(nodes)).toEqual(['model', 'fold', 'step', 'model', 'step', 'model', 'ask', 'step', 'end']);
    expect(nodes[1]).toMatchObject({ from: 1, to: 3, worked: 3, calls: 1 });
  });

  it('numbers steps in order, whatever was saved', () => {
    const nodes = timelineNodes([ok(4), entry('step', 'scroll → ✅ Scrolled'), ok(9)]);
    expect(nodes.map((n) => n.kind === 'step' && n.step.n)).toEqual([1, 2, 3]);
  });

  it('shows what the model saw change', () => {
    const seen = seenChanges('On "Checkout"\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNew text: "We use cookies" | "Accept all"\nNew elements:\n[42] <button> "Accept all"\nGone: [7] <button> "Apply code"');
    expect(seen.page).toBe('Checkout');
    expect(seen.lines).toEqual([
      { sign: '+', text: '"We use cookies"' }, { sign: '+', text: '"Accept all"' },
      { sign: '+', text: '[42] <button> "Accept all"' }, { sign: '−', text: '[7] <button> "Apply code"' },
    ]);
    expect(seenChanges('On "Home"\n\n--- WHAT CHANGED ---\nNothing visible changed on the page. That is not always a failure').lines).toEqual([{ sign: '', text: 'Nothing visible changed' }]);
    expect(seenChanges(undefined).lines).toEqual([]);
  });

  it('counts steps and finds the site', () => {
    const log: RunLog = {
      ...header({}),
      entries: [
        entry('model', 'Model chose the next actions', { url: 'about:blank' }),
        { ...ok(1), url: 'https://www.trailhead.shop/p/1' },
        entry('step', 'click [2] → ❌ nope'),
      ],
    };
    expect(runStats(log)).toEqual({ steps: 2, failed: 1 });
    expect(runSite(log)).toBe('trailhead.shop');
  });
});
