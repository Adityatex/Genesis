import { describe, it, expect } from 'vitest';
import { settleNavigation } from '@/lib/agent/loop';

describe('settleNavigation', () => {
  it('replaces the pending entry with where the navigation ended up', () => {
    const history = ['find "settings" → 🔎 Found 1', 'click [160] → (executing...)'];
    expect(settleNavigation(history, 'Account settings', 'http://x/settings')).toEqual([
      'find "settings" → 🔎 Found 1',
      'click [160] → ✅ page changed; now on "Account settings" (http://x/settings)',
    ]);
  });

  it('leaves settled histories alone', () => {
    const history = ['click [3] → ✅ Clicked "Next"'];
    expect(settleNavigation(history, 'T', 'u')).toBe(history);
    expect(settleNavigation([], 'T', 'u')).toEqual([]);
  });
});
