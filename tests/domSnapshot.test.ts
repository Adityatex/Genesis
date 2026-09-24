import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDOMSnapshot } from '@/lib/agent/domSnapshot';

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
