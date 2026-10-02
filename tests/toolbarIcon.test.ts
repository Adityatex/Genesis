import { describe, it, expect } from 'vitest';
import { Attention, toolbarIconPaths } from '@/lib/utils/toolbarIcon';

describe('toolbar icon', () => {
  it('picks the ink for the toolbar, and the amber dot when a task needs you', () => {
    expect(toolbarIconPaths('light', false)).toEqual({ 16: '/icons/toolbar-light-16.png', 32: '/icons/toolbar-light-32.png' });
    expect(toolbarIconPaths('dark', true)).toEqual({ 16: '/icons/toolbar-dark-waiting-16.png', 32: '/icons/toolbar-dark-waiting-32.png' });
  });

  it('needs you while any tab waits, and says when that changes', () => {
    const a = new Attention();
    expect(a.update(1, 'running')).toBe(false);
    expect(a.update(1, 'paused')).toBe(true);
    expect(a.update(2, 'paused')).toBe(false); // still needed
    expect(a.update(1, 'running')).toBe(false);
    expect(a.needed).toBe(true);
    expect(a.update(2, undefined)).toBe(true); // tab closed
    expect(a.needed).toBe(false);
  });
});
