import { describe, it, expect } from 'vitest';
import { stepView, stepUnderWay, statusOf, trimSteps, type StepView } from '@/lib/agent/stepView';

describe('steps in plain words', () => {
  it('names the element by its label and says where a click led', () => {
    const step = stepView(8, { action: 'click', elementId: 3 }, '✅ Clicked "Checkout"; page changed, now on "Shipping" (https://shop.test/ship)', { label: 'Checkout' });
    expect(step).toMatchObject({ n: 8, status: 'ok', icon: 'click', action: 'Clicked “Checkout”', result: 'Opened “Shipping”' });
  });

  it('says why a step failed, without element numbers or advice for the model', () => {
    const step = stepView(7, { action: 'click', elementId: 12 }, '❌ Element [12] not found on page. Look again at the page.', { label: 'Apply code' });
    expect(step.status).toBe('fail');
    expect(step.result).toBe('“Apply code” not found on page.');
  });

  it('never shows a typed password', () => {
    const step = stepView(3, { action: 'type', elementId: 4, text: 'hunter2' }, '✅ Typed "hunter2" into element [4]', { label: 'Password', secret: true });
    expect(step.action).toBe('Typed a password into “Password”');
    expect(JSON.stringify(step)).not.toContain('hunter2');
    const failed = stepView(3, { action: 'type', elementId: 4, text: 'hunter2' }, '❌ Typing "hunter2" into element [4] had no effect', { label: 'Password', secret: true });
    expect(JSON.stringify(failed)).not.toContain('hunter2');
  });

  it('marks refused, blocked and stuck steps as not run', () => {
    expect(statusOf("⛔ not run: the user didn't allow it.")).toBe('skip');
    expect(statusOf('⏸️ not run: you chose this 3 times')).toBe('skip');
    expect(statusOf('⚠️ Clicked "Go" with a scripted click')).toBe('ok');
    const refused = stepView(5, { action: 'click', elementId: 9 }, "⛔ not run: the user didn't allow it. Don't do it.", { label: 'Place order' });
    expect(refused).toMatchObject({ status: 'skip', result: "Not run: the user didn't allow it." });
  });

  it('describes the other actions', () => {
    expect(stepView(1, { action: 'navigate', url: 'https://www.example.com/products/trail-runner' }, '✅ now on "Trail Runner" (https://www.example.com/products/trail-runner)'))
      .toMatchObject({ action: 'Went to example.com/products/trail-runner', result: 'Opened “Trail Runner”' });
    expect(stepView(2, { action: 'select', elementId: 2, value: '10' }, '✅ Selected "10" in dropdown [2]', { label: 'Size' }).action).toBe('Chose “10” in “Size”');
    expect(stepView(2, { action: 'run_code', text: 'return 1' }, '✅ The code returned: [1]').result).toBe('It returned data');
    expect(stepView(2, { action: 'click', elementId: 1 }, '✅ Clicked "Go"', { replay: true }).icon).toBe('replay');
  });

  it('shows the step under way', () => {
    expect(stepUnderWay(10, { action: 'type', elementId: 5, text: 'Springfield' }, { label: 'City' }))
      .toEqual({ n: 10, status: 'run', icon: 'type', action: 'Typing “Springfield” into “City”', result: 'Working…' });
  });

  it('keeps the last steps of a long run and counts the rest', () => {
    const steps = Array.from({ length: 10 }, (_, i): StepView => ({ n: i + 1, status: i === 1 ? 'fail' : 'ok', icon: 'click', action: 'x', result: 'y' }));
    const { steps: kept, hidden } = trimSteps(steps, 6);
    expect(kept.map((s) => s.n)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(hidden).toEqual({ count: 4, failed: 1 });
    expect(trimSteps(steps).hidden).toBeUndefined();
  });
});
