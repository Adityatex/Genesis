import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPageCue, cueOf, type PageCue } from '@/lib/dom/pageCue';

/** The cue's closed shadow root, caught as it's attached. */
function withCue(find: (id: number) => Element | null = () => null) {
  let shadow!: ShadowRoot;
  const attach = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const onStop = vi.fn();
  const onReview = vi.fn();
  const cue = createPageCue({ onStop, onReview, find });
  spy.mockRestore();
  const $ = (sel: string) => shadow.querySelector(sel) as HTMLElement;
  return { cue, onStop, onReview, $, host: () => document.querySelector('tabi-cue') };
}

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let cue: PageCue | undefined;
afterEach(() => cue?.destroy());

describe('the on-page cue', () => {
  it('follows the run: working, needs you, or nothing', () => {
    expect(cueOf(null)).toBeNull();
    expect(cueOf({ status: 'running' })).toEqual({ mode: 'running' });
    expect(cueOf({ status: 'running', target: 7 })).toEqual({ mode: 'running', target: 7 });
    expect(cueOf({ status: 'paused', asking: { action: 'click “Buy”', risk: 'a purchase' }, target: 3 })).toEqual({ mode: 'needs', kind: 'ask', target: 3 });
    expect(cueOf({ status: 'paused' })).toEqual({ mode: 'needs', kind: 'pause' });
    for (const status of ['done', 'stopped', 'error', 'queued'] as const) expect(cueOf({ status })).toBeNull();
  });

  it('shows on <html>, outside the page body, only while a task runs', () => {
    const c = withCue();
    cue = c.cue;
    expect(c.host()).toBeNull();
    c.cue.set({ mode: 'running' });
    expect(c.host()?.parentElement).toBe(document.documentElement);
    expect(document.body.contains(c.host())).toBe(false);
    expect(c.$('.label').textContent).toBe('Tabi is working');
    expect(c.$('button').textContent).toBe('Stop');
    c.cue.set(null);
    expect(c.host()).toBeNull();
  });

  it('says what it needs, and its button reviews instead of stopping', () => {
    const c = withCue();
    cue = c.cue;
    c.cue.set({ mode: 'running' });
    c.$('button').click();
    expect(c.onStop).toHaveBeenCalledOnce();
    // The run ends after the step under way: say so meanwhile, and only stop once
    expect(c.$('.label').textContent).toBe('Stopping…');
    c.cue.set({ mode: 'running', target: 4 });
    expect(c.$('.label').textContent).toBe('Stopping…');
    expect((c.$('button') as HTMLButtonElement).disabled).toBe(true);
    c.$('button').click();
    expect(c.onStop).toHaveBeenCalledOnce();
    c.cue.set({ mode: 'needs', kind: 'ask' });
    expect(c.$('.root').classList.contains('needs')).toBe(true);
    expect(c.$('.label').textContent).toBe('Tabi needs your OK');
    expect(c.$('button').textContent).toBe('Review');
    c.$('button').click();
    expect(c.onReview).toHaveBeenCalledOnce();
    expect(c.onStop).toHaveBeenCalledOnce();
    c.cue.set({ mode: 'needs', kind: 'pause' });
    expect(c.$('.label').textContent).toBe('Tabi is waiting for you');
  });

  it('outlines the element being acted on', () => {
    document.body.innerHTML = '<button id="b">Buy</button>';
    const button = document.getElementById('b')!;
    button.getBoundingClientRect = () => rect(100, 200, 80, 30);
    const c = withCue((id) => (id === 5 ? button : null));
    cue = c.cue;
    c.cue.set({ mode: 'running', target: 5 });
    const outline = c.$('.outline');
    expect(outline.style.display).toBe('block');
    expect([outline.style.left, outline.style.top, outline.style.width, outline.style.height]).toEqual(['96px', '196px', '88px', '38px']);
    c.cue.set({ mode: 'running' });
    expect(outline.style.display).toBe('none');
  });

  it('moves the pill off what the agent is about to click', () => {
    const c = withCue();
    cue = c.cue;
    c.cue.set({ mode: 'running' });
    const pill = c.$('.pill');
    // Bottom-left, or bottom-right with .right
    pill.getBoundingClientRect = () => (pill.classList.contains('right') ? rect(1100, 744, 160, 36) : rect(20, 744, 160, 36));
    const target = document.createElement('a');
    target.getBoundingClientRect = () => rect(40, 750, 60, 20); // under the pill
    c.cue.avoid(target);
    expect(pill.classList.contains('right')).toBe(true);
    expect(pill.classList.contains('out')).toBe(false);
    // Under both corners (a full-width footer link): out of the way
    target.getBoundingClientRect = () => rect(0, 740, 1280, 60);
    c.cue.avoid(target);
    expect(pill.classList.contains('out')).toBe(true);
    // Somewhere else: back in view
    target.getBoundingClientRect = () => rect(500, 100, 60, 20);
    c.cue.avoid(target);
    expect(pill.classList.contains('out')).toBe(false);
  });

  it('steps aside for a screenshot, then comes back', () => {
    vi.useFakeTimers();
    try {
      const c = withCue();
      cue = c.cue;
      c.cue.set({ mode: 'running' });
      c.cue.hideFor(1500);
      expect(c.host()).toBeNull();
      c.cue.set({ mode: 'running', target: 2 }); // an update meanwhile doesn't bring it back early
      expect(c.host()).toBeNull();
      vi.advanceTimersByTime(1600);
      expect(c.host()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
