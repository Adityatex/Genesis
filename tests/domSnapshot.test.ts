import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDOMSnapshot, findElements, SNAPSHOT_BUDGET } from '@/lib/agent/domSnapshot';

// happy-dom has no layout engine, so give every element a non-zero box.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) },
  );
});

describe('createDOMSnapshot', () => {
  it('lists dropdown options so the model can choose a valid one', () => {
    document.body.innerHTML = `
      <label>Country
        <select name="country">
          <option value="IN">India</option>
          <option value="US">United States</option>
        </select>
      </label>`;

    const { text, elements } = createDOMSnapshot();

    expect(elements[0].options).toEqual(['India', 'United States']);
    expect(text).toContain('options=["India", "United States"]');
  });

  it('caps long option lists', () => {
    const opts = Array.from({ length: 40 }, (_, i) => `<option>Item ${i}</option>`).join('');
    document.body.innerHTML = `<select>${opts}</select>`;

    const { elements } = createDOMSnapshot();

    expect(elements[0].options).toHaveLength(16);
    expect(elements[0].options!.at(-1)).toBe('…+25 more');
  });

  it('tags elements with data-genesis-id matching their snapshot id', () => {
    document.body.innerHTML = '<button>A</button><a href="/x">B</a>';

    const { elements } = createDOMSnapshot();

    for (const el of elements) {
      expect(document.querySelector(`[data-genesis-id="${el.id}"]`)).not.toBeNull();
    }
    expect(elements).toHaveLength(2);
  });
});

describe('shadow DOM', () => {
  it('finds elements inside open shadow roots and the executor can click them', async () => {
    document.body.innerHTML = '<div id="host"></div><button>Outside</button>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>Subscribe</button>';
    const onClick = vi.fn();
    root.querySelector('button')!.addEventListener('click', onClick);

    const { text, elements } = createDOMSnapshot();
    const sub = elements.find(e => e.label === 'Subscribe');
    expect(sub).toBeDefined();
    expect(text).toContain('"Subscribe"');

    Element.prototype.scrollIntoView = vi.fn();
    const { executeAction } = await import('@/lib/agent/actionExecutor');
    await executeAction({ action: 'click', elementId: sub!.id });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('lists elements in document order, shadow content where its host is', () => {
    document.body.innerHTML = '<button>First</button><div id="host"></div><button>Last</button>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Middle</button>';
    expect(createDOMSnapshot().elements.map(e => e.label)).toEqual(['First', 'Middle', 'Last']);
  });

  it("never includes Genesis's own sidebar", () => {
    document.body.innerHTML = '<button>Page button</button><genesis-sidebar></genesis-sidebar>';
    document.querySelector('genesis-sidebar')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Send</button>';
    expect(createDOMSnapshot().elements.map(e => e.label)).toEqual(['Page button']);
  });
});

describe('ARIA widgets', () => {
  it('lists custom widgets with their role and state', () => {
    document.body.innerHTML = `
      <div tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-label="Plan">Select a plan</div>
      <div role="switch" aria-checked="true" aria-label="Dark mode"></div>
      <ul role="listbox"><li role="option" aria-selected="true">Pro</li></ul>`;
    const lines = createDOMSnapshot().text.split('\n').filter(l => l.startsWith('['));
    expect(lines).toEqual([
      '[0] <div> "Plan" [collapsed, popup=listbox]',
      '[1] <div> role="switch" "Dark mode" [checked]',
      '[2] <li> role="option" "Pro" [selected]',
    ]);
  });
});

describe('long pages: snapshot budget + find', () => {
  const rect = (top: number) => ({ x: 0, y: top, width: 100, height: 20, top, left: 0, right: 100, bottom: top + 20, toJSON: () => ({}) });

  beforeEach(() => {
    // Buttons labelled "far ..." sit far below the viewport; the rest are on screen
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this.textContent?.startsWith('far') ? 50_000 : 10);
    });
  });

  function mountLongPage() {
    const near = Array.from({ length: 150 }, (_, i) => `<button>near button number ${i}</button>`).join('');
    const far = Array.from({ length: 150 }, (_, i) => `<button>far button number ${i}</button>`).join('');
    document.body.innerHTML = near + far;
    document.body.insertAdjacentHTML('afterbegin', '<button>far Account settings</button>');
  }

  it('stays within the budget and says how many elements it left out', () => {
    mountLongPage();
    const { text, elements } = createDOMSnapshot();
    expect(elements).toHaveLength(301); // every element still gets an ID
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_BUDGET);
    expect(text).toMatch(/… \d+ more elements are off-screen and not listed\. Use \{"action": "find"/);
  });

  it('lists on-screen elements before off-screen ones', () => {
    mountLongPage();
    const listed = createDOMSnapshot().text.split('\n').filter(l => /^\[\d+\]/.test(l));
    expect(listed.some(l => l.includes('"near button number 0"'))).toBe(true);
    // The off-screen button comes first in page order but must not crowd out on-screen ones
    expect(listed.some(l => l.includes('far Account settings'))).toBe(false);
  });

  it('find reaches unlisted elements, and their IDs are clickable', async () => {
    mountLongPage();
    createDOMSnapshot();
    const [hit] = findElements('account settings');
    expect(hit.label).toBe('far Account settings');

    const onClick = vi.fn();
    document.querySelector('button')!.addEventListener('click', onClick);
    Element.prototype.scrollIntoView = vi.fn();
    const { executeAction } = await import('@/lib/agent/actionExecutor');
    expect(await executeAction({ action: 'find', text: 'account settings' })).toContain(`[${hit.id}] <button> "far Account settings"`);
    await executeAction({ action: 'click', elementId: hit.id });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('find matches all words, in any order', () => {
    mountLongPage();
    createDOMSnapshot();
    expect(findElements('settings ACCOUNT').map(e => e.label)).toEqual(['far Account settings']);
    expect(findElements('nonexistent thing')).toEqual([]);
  });
});
