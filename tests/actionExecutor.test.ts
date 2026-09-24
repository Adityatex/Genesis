import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeAction } from '@/lib/agent/actionExecutor';

// happy-dom has no layout; the executor only needs these to not throw.
beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
});

describe('click', () => {
  it('fires exactly one click event', async () => {
    document.body.innerHTML = '<button data-genesis-id="0">Go</button>';
    const onClick = vi.fn();
    document.querySelector('button')!.addEventListener('click', onClick);

    await executeAction({ action: 'click', elementId: 0 });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('toggles a checkbox exactly once', async () => {
    document.body.innerHTML = '<input type="checkbox" data-genesis-id="0">';
    await executeAction({ action: 'click', elementId: 0 });
    expect(document.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });

  it('fires mousedown before click for custom widgets', async () => {
    document.body.innerHTML = '<div role="button" data-genesis-id="0">Menu</div>';
    const events: string[] = [];
    const el = document.querySelector('div')!;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.addEventListener(type, () => events.push(type));
    }
    await executeAction({ action: 'click', elementId: 0 });
    expect(events).toEqual(['pointerdown', 'mousedown', 'mouseup', 'click']);
  });
});

describe('press_key Enter', () => {
  it('submits the enclosing form via requestSubmit', async () => {
    document.body.innerHTML = '<form><input name="q" data-genesis-id="0"></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);

    const result = await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/submitted the form/);
  });

  it('does not submit when the page handled the keydown itself', async () => {
    document.body.innerHTML = '<form><input name="q" data-genesis-id="0"></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);
    document.querySelector('input')!.addEventListener('keydown', e => e.preventDefault());

    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit from a textarea', async () => {
    document.body.innerHTML = '<form><textarea data-genesis-id="0"></textarea></form>';
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector('form')!.addEventListener('submit', onSubmit);

    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sets legacy keyCode for sites that check e.keyCode === 13', async () => {
    document.body.innerHTML = '<input data-genesis-id="0">';
    let keyCode = -1;
    document.querySelector('input')!.addEventListener('keydown', e => { keyCode = e.keyCode; });
    await executeAction({ action: 'press_key', key: 'Enter', elementId: 0 });
    expect(keyCode).toBe(13);
  });
});

describe('select', () => {
  const html = `
    <select data-genesis-id="0">
      <option value="">Choose…</option>
      <option value="IN">India</option>
      <option value="US">United States</option>
    </select>`;

  it('matches by visible label', async () => {
    document.body.innerHTML = html;
    const onChange = vi.fn();
    document.querySelector('select')!.addEventListener('change', onChange);

    const result = await executeAction({ action: 'select', elementId: 0, value: 'united states' });

    expect(document.querySelector('select')!.value).toBe('US');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/Selected "United States"/);
  });

  it('matches by option value', async () => {
    document.body.innerHTML = html;
    await executeAction({ action: 'select', elementId: 0, value: 'IN' });
    expect(document.querySelector('select')!.value).toBe('IN');
  });

  it('reports the available options instead of clearing the field', async () => {
    document.body.innerHTML = html;
    document.querySelector('select')!.value = 'IN';

    const result = await executeAction({ action: 'select', elementId: 0, value: 'Canada' });

    expect(result).toMatch(/No option matching "Canada"/);
    expect(result).toMatch(/"India"/);
    expect(document.querySelector('select')!.value).toBe('IN');
  });
});
