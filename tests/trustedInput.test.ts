import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keyParams, normalizeKey } from '@/lib/agent/keys';

describe('keys', () => {
  it('normalizes the key names models write', () => {
    expect(normalizeKey('enter')).toBe('Enter');
    expect(normalizeKey('ESC')).toBe('Escape');
    expect(normalizeKey('space')).toBe(' ');
    expect(normalizeKey('a')).toBe('a');
  });

  it("gives Enter the '\\r' text that triggers implicit form submission", () => {
    expect(keyParams('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
  });

  it('describes characters', () => {
    expect(keyParams('h')).toEqual({ key: 'h', code: 'KeyH', keyCode: 72, text: 'h' });
    expect(keyParams('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' });
    expect(keyParams('!')).toMatchObject({ key: '!', text: '!' });
  });
});

describe('trustedInput (fake chrome.debugger)', () => {
  let chromeFake: any;
  let onDetach: (source: { tabId?: number }, reason: string) => void;

  beforeEach(() => {
    vi.resetModules(); // fresh attached/declined state per test
    chromeFake = {
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn().mockResolvedValue({}),
        onDetach: { addListener: vi.fn((fn) => { onDetach = fn; }) },
      },
      tabs: { onRemoved: { addListener: vi.fn() } },
    };
    vi.stubGlobal('chrome', chromeFake);
  });
  afterEach(() => vi.unstubAllGlobals());

  const load = () => import('@/lib/agent/trustedInput');
  const commands = () => chromeFake.debugger.sendCommand.mock.calls.map((c: any[]) => [c[1], c[2].type]);

  it('attaches once per run, clicks with a real press/release, and detaches at the end', async () => {
    const t = await load();
    await t.trustedClick(7, 100, 50);
    await t.trustedClick(7, 10, 10);
    expect(chromeFake.debugger.attach).toHaveBeenCalledTimes(1);
    expect(commands().slice(0, 3)).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved'],
      ['Input.dispatchMouseEvent', 'mousePressed'],
      ['Input.dispatchMouseEvent', 'mouseReleased'],
    ]);

    await t.releaseTab(7);
    expect(chromeFake.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
    await t.trustedKey(7, 'Enter');
    expect(chromeFake.debugger.attach).toHaveBeenCalledTimes(2); // next run re-attaches
  });

  it('types short text as keystrokes and long text with insertText', async () => {
    const t = await load();
    await t.trustedType(1, 'hi');
    expect(commands()).toEqual([
      ['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp'],
      ['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp'],
    ]);
    chromeFake.debugger.sendCommand.mockClear();
    await t.trustedType(1, 'x'.repeat(500));
    expect(commands()).toEqual([['Input.insertText', undefined]]);
  });

  it('respects the user cancelling the debugging banner for the rest of the run', async () => {
    const t = await load();
    t.watchDetach();
    await t.trustedClick(3, 1, 1);
    onDetach({ tabId: 3 }, 'canceled_by_user');
    await expect(t.trustedClick(3, 1, 1)).rejects.toThrow(/cancelled/);
    await t.releaseTab(3); // run ends
    await expect(t.trustedClick(3, 1, 1)).resolves.toBeUndefined();
  });
});
