import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  collectLocalElements, addRemoteElements, renderSnapshot, getElementById, getRemoteRef, findElements,
  type FrameSnapshot,
} from '@/lib/agent/domSnapshot';
import { executeAction } from '@/lib/agent/actionExecutor';

const rect = (top: number, left = 0) => ({ x: left, y: top, width: 300, height: 150, top, left, right: left + 300, bottom: top + 150, toJSON: () => ({}) });

// What a cross-origin frame's content script would report
const frameSnap: FrameSnapshot = {
  elements: [
    { id: 0, tag: 'input', role: 'input', label: 'Cardholder name', selector: '' },
    { id: 1, tag: 'button', role: 'button', label: 'Pay $42.00', type: 'submit', selector: '' },
  ],
  tops: [10, 60],
  text: 'Pay $42.00',
};

describe('cross-origin frame elements', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 20));
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = '<h1>Checkout</h1><button>Back</button><iframe title="Secure payment form"></iframe>';
  });
  afterEach(() => vi.restoreAllMocks());

  function snapshotWithFrame() {
    const parts = collectLocalElements();
    const iframe = document.querySelector('iframe')!;
    addRemoteElements(parts, { iframe, label: 'Secure payment form' }, 7, frameSnap);
    return renderSnapshot(parts);
  }

  it('lists the frame\'s elements after the page\'s own, labeled with the frame', () => {
    const { text, elements } = snapshotWithFrame();
    const lines = text.split('\n').filter(l => /^\[\d+\]/.test(l));
    expect(lines).toEqual([
      '[0] <button> "Back"',
      '[1] <input> "Cardholder name" (in frame "Secure payment form")',
      '[2] <button> type="submit" "Pay $42.00" (in frame "Secure payment form")',
    ]);
    expect(elements).toHaveLength(3);
    expect(text).toContain('[in frame "Secure payment form"] Pay $42.00');
  });

  it('maps global IDs back to the frame and its local IDs', () => {
    snapshotWithFrame();
    expect(getElementById(1)).toBeNull(); // not an element on this page
    expect(getRemoteRef(1)).toMatchObject({ frameId: 7, localId: 0 });
    expect(getRemoteRef(2)).toMatchObject({ frameId: 7, localId: 1 });
    expect(getRemoteRef(0)).toBeNull(); // a local element
    expect(findElements('pay $42').map(e => e.id)).toEqual([2]); // "pay" alone also matches "Secure payment form"
  });

  it('forwards actions on frame elements with the local ID and the frame\'s screen offset', async () => {
    snapshotWithFrame();
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ success: true, data: '✅ Clicked "Pay $42.00"' } as any);

    const result = await executeAction({ action: 'click', elementId: 2 });

    expect(result).toBe('✅ Clicked "Pay $42.00"');
    expect(send).toHaveBeenCalledWith({
      action: 'FRAME_EXECUTE',
      payload: { frameId: 7, action: { action: 'click', elementId: 1 }, offset: { x: 20, y: 100 } },
    });
  });

  it('reports a frame that does not answer instead of claiming success', async () => {
    snapshotWithFrame();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ success: false, error: 'The frame did not respond' } as any);
    expect(await executeAction({ action: 'type', elementId: 1, text: 'Ada' })).toBe('❌ Could not act inside the frame: The frame did not respond');
  });
});
