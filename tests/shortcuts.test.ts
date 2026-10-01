import { describe, it, expect } from 'vitest';
import {
  shortcutName, blanks, fillPrompt, matchItems, saveShortcut, loadShortcuts, deleteShortcut, type PickerItem,
} from '@/lib/shortcuts/shortcut';
import type { KeyValueStorage } from '@/lib/skills/store';

describe('shortcut names and blanks', () => {
  it('names a prompt by its first words, without blanks', () => {
    expect(shortcutName('Find the price of {product} on this site')).toBe('find-the-price-of-on');
    expect(shortcutName('Check my order status')).toBe('check-my-order-status');
    expect(shortcutName('{x}')).toBe('shortcut');
  });

  it('finds each blank once', () => {
    expect(blanks('Send {name} a note about {topic}; thank {name}')).toEqual(['name', 'topic']);
    expect(blanks('No blanks here')).toEqual([]);
  });
});

describe('filling a prompt from /name words', () => {
  it('puts all the words in a single blank', () => {
    expect(fillPrompt('Find the price of {product}', 'running shoes')).toEqual({ text: 'Find the price of running shoes', complete: true });
  });

  it('splits on commas for several blanks, and fills a blank used twice', () => {
    expect(fillPrompt('Email {name} about {topic}. Sign as {name}', 'Ada, the invoice'))
      .toEqual({ text: 'Email Ada about the invoice. Sign as Ada', complete: true });
  });

  it('leaves the prompt to finish by hand when a blank is empty', () => {
    expect(fillPrompt('Find the price of {product}', '')).toEqual({ text: 'Find the price of {product}', complete: false });
    expect(fillPrompt('Email {name} about {topic}', 'Ada')).toEqual({ text: 'Email Ada about {topic}', complete: false });
  });

  it('adds words after a prompt without blanks', () => {
    expect(fillPrompt('Summarise this page', '')).toEqual({ text: 'Summarise this page', complete: true });
    expect(fillPrompt('Search the shop for', 'red mugs')).toEqual({ text: 'Search the shop for red mugs', complete: true });
  });
});

describe('the / picker', () => {
  const items: PickerItem[] = [
    { kind: 'shortcut', name: 'price-check', detail: 'Find the price of {product}' },
    { kind: 'workflow', name: 'weekly-report', detail: 'Download the weekly sales report' },
    { kind: 'shortcut', name: 'order-status', detail: 'Check my order status' },
    { kind: 'workflow', name: 'order-refill', detail: 'Reorder printer paper' },
  ];

  it('lists everything for a bare /, workflows first', () => {
    expect(matchItems('', items).map((i) => i.name)).toEqual(['order-refill', 'weekly-report', 'order-status', 'price-check']);
  });

  it('ranks names that start with the query, then contain it, then descriptions', () => {
    expect(matchItems('order', items).map((i) => i.name)).toEqual(['order-refill', 'order-status']);
    expect(matchItems('report', items).map((i) => i.name)).toEqual(['weekly-report']);
    expect(matchItems('paper', items).map((i) => i.name)).toEqual(['order-refill']);
    expect(matchItems('zzz', items)).toEqual([]);
  });
});

describe('shortcut storage', () => {
  function memory(): KeyValueStorage {
    const data: Record<string, unknown> = {};
    return { get: async (k) => ({ [k]: data[k] }), set: async (items) => { Object.assign(data, items); } };
  }

  it('names unnamed ones, replaces by name, deletes, and refuses empty prompts', async () => {
    const storage = memory();
    await saveShortcut(storage, { name: '', prompt: 'Check my order status' });
    await saveShortcut(storage, { name: 'Price Check', prompt: 'Find the price of {product}' });
    await saveShortcut(storage, { name: 'price-check', prompt: 'Find the best price of {product}' });
    expect((await loadShortcuts(storage)).map((s) => `${s.name}: ${s.prompt}`)).toEqual([
      'check-my-order-status: Check my order status',
      'price-check: Find the best price of {product}',
    ]);
    await deleteShortcut(storage, 'check-my-order-status');
    expect((await loadShortcuts(storage)).map((s) => s.name)).toEqual(['price-check']);
    await expect(saveShortcut(storage, { name: 'x', prompt: '   ' })).rejects.toThrow('needs a prompt');
  });
});
