import { describe, it, expect } from 'vitest';
import { markState, statusPill, planItems, formatElapsed, failureKind, siteOf, pathOf, when } from '@/lib/panel/view';
import type { RunView } from '@/lib/agent/runner';

const run = (over: Partial<RunView>): RunView => ({ goal: 'g', status: 'running', message: '', loading: true, step: 1, plan: [], updatedAt: 0, steps: [], ...over });

describe('the side panel view of a run', () => {
  it('moves the mark with what the agent is doing', () => {
    expect(markState(null)).toBe('idle');
    expect(markState(run({ phase: 'reading' }))).toBe('reading');
    expect(markState(run({ phase: 'thinking' }))).toBe('thinking');
    expect(markState(run({ phase: 'acting' }))).toBe('acting');
    expect(markState(run({ status: 'paused' }))).toBe('waiting');
    expect(markState(run({ status: 'done' }))).toBe('done');
    expect(markState(run({ status: 'error' }))).toBe('failed');
    expect(markState(run({ status: 'stopped' }))).toBe('stopped');
    expect(markState(run({ status: 'stopped', outcome: 'The agent is on mybank.com, which is on your block list, so it stopped.' }))).toBe('failed');
  });

  it('labels the status pill', () => {
    expect(statusPill(run({}))).toEqual({ tone: 'running', label: 'Running' });
    expect(statusPill(run({ replay: 'replaying' })).label).toBe('Replaying · no AI calls');
    expect(statusPill(run({ status: 'paused', asking: { action: 'click "Buy"', risk: 'a purchase' } })).label).toBe('Needs your OK');
    expect(statusPill(run({ status: 'paused' })).label).toBe('Paused');
    expect(statusPill(run({ status: 'stopped' })).label).toBe('Stopped by you');
    expect(statusPill(run({ status: 'queued' })).tone).toBe('neutral');
  });

  it('reads the plan: done items, the current one, and the ones that ask first', () => {
    expect(planItems(['[x] Open the product', '[ ] Fill in your address', '[ ] Place the order'])).toEqual([
      { text: 'Open the product', state: 'done', irreversible: false },
      { text: 'Fill in your address', state: 'current', irreversible: false },
      { text: 'Place the order', state: 'todo', irreversible: true },
    ]);
    expect(planItems(['Untagged step']).map((p) => p.state)).toEqual(['current']);
    expect(planItems(['[x] Open it', '[ ] Buy it'], true).map((p) => p.state)).toEqual(['done', 'done']);
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(102_000)).toBe('1:42');
    expect(formatElapsed(3_729_000)).toBe('1:02:09');
  });

  it('tells failures apart', () => {
    expect(failureKind('Groq rejected the API key (401): Invalid API Key')).toBe('bad_key');
    expect(failureKind('Rate limit exceeded on Groq: try again in 42s')).toBe('rate_limit');
    expect(failureKind('Page timed out after 20s')).toBe('page_load');
    expect(failureKind('No API key for Groq. Add one in Settings.')).toBe('setup');
    expect(failureKind('something else')).toBe('other');
  });

  it('splits a URL for the site row', () => {
    expect(siteOf('https://www.trailhead.shop/checkout?cart=8f')).toBe('trailhead.shop');
    expect(siteOf('chrome://extensions')).toBe('');
    expect(pathOf('https://trailhead.shop/checkout?cart=8f#x')).toBe('/checkout?cart=8f#x');
  });

  it('says when, briefly', () => {
    const now = new Date(2026, 9, 2, 12).getTime();
    expect(when(now - 30_000, now)).toBe('just now');
    expect(when(now - 5 * 60_000, now)).toBe('5m ago');
    expect(when(now - 86_400_000, now)).toBe('Yesterday');
  });
});
