import { describe, it, expect } from 'vitest';
import { findText } from '@/lib/dom/highlightText';

describe('finding a source on the page', () => {
  it('finds words across elements, ignoring case and spacing', () => {
    document.body.innerHTML = '<h2>Reviews</h2><p>Runs   <b>small</b>, order a\nhalf size up.</p><script>var runs = "small"</script>';
    const range = findText('runs small, order a half size up');
    expect(range?.toString().replace(/\s+/g, ' ')).toBe('Runs small, order a half size up');
  });

  it('falls back to the first words, and says when it is not there', () => {
    document.body.innerHTML = '<p>US 10 = 27.9 cm heel to toe</p>';
    expect(findText('US 10 = 27.9 cm heel to toe, roughly speaking')?.toString()).toBe('US 10 = 27.9 cm heel'); // its first six words
    expect(findText('not on this page')).toBeNull();
  });
});
