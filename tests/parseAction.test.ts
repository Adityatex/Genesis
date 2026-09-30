import { describe, it, expect } from 'vitest';
import { parseAgentAction, parseAgentResponse, extractFirstJsonObject, MAX_BATCH } from '@/lib/agent/parseAction';

function ok(raw: string) {
  const r = parseAgentAction(raw);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.action;
}

function err(raw: string) {
  const r = parseAgentAction(raw);
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.action)}`);
  return r.error;
}

describe('extractFirstJsonObject', () => {
  it('returns the first balanced object when the model emits several', () => {
    expect(extractFirstJsonObject('{"action":"click","elementId":1}\n{"action":"done"}'))
      .toBe('{"action":"click","elementId":1}');
  });

  it('ignores braces inside strings', () => {
    expect(extractFirstJsonObject('{"action":"type","elementId":2,"text":"a } b { c"}'))
      .toBe('{"action":"type","elementId":2,"text":"a } b { c"}');
  });

  it('returns null when there is no object', () => {
    expect(extractFirstJsonObject('I think we are done here.')).toBeNull();
  });
});

describe('parseAgentAction', () => {
  it('parses plain JSON', () => {
    expect(ok('{"action":"click","elementId":3}')).toEqual({ action: 'click', elementId: 3 });
  });

  it('parses JSON wrapped in a code fence and prose', () => {
    const raw = 'Sure! Here is the next step:\n```json\n{"action": "scroll", "direction": "up"}\n```';
    expect(ok(raw)).toEqual({ action: 'scroll', direction: 'up' });
  });

  it('coerces quoted element ids', () => {
    expect(ok('{"action":"click","elementId":"[12]"}').elementId).toBe(12);
    expect(ok('{"action":"click","elementId":"7"}').elementId).toBe(7);
  });

  it('reports prose instead of silently finishing the task', () => {
    expect(err('I clicked the button for you.')).toMatch(/No JSON object/);
  });

  it('rejects unknown actions', () => {
    expect(err('{"action":"hover","elementId":1}')).toMatch(/Unknown action "hover"/);
  });

  it('rejects actions missing required fields', () => {
    expect(err('{"action":"click"}')).toMatch(/requires a numeric elementId/);
    expect(err('{"action":"type","elementId":1}')).toMatch(/requires text/);
    expect(err('{"action":"select","elementId":1}')).toMatch(/requires a value/);
  });

  it('only allows http(s) navigation', () => {
    expect(ok('{"action":"navigate","url":"https://example.com/a"}').url).toBe('https://example.com/a');
    expect(err('{"action":"navigate","url":"javascript:alert(1)"}')).toMatch(/only allows http/);
    expect(err('{"action":"navigate","url":"example.com"}')).toMatch(/full URL/);
  });

  it('parses find, accepting "query" as an alias for text', () => {
    expect(ok('{"action":"find","text":"settings"}')).toEqual({ action: 'find', text: 'settings' });
    expect(ok('{"action":"find","query":"settings"}').text).toBe('settings');
    expect(err('{"action":"find"}')).toMatch(/find requires text/);
  });

  it('defaults scroll direction to down', () => {
    expect(ok('{"action":"scroll"}').direction).toBe('down');
  });

  it('keeps done summaries', () => {
    expect(ok('{"action":"done","summary":"Found 3 results"}')).toEqual({ action: 'done', summary: 'Found 3 results' });
  });
});

describe('note action', () => {
  it('parses notes and requires text', () => {
    expect(parseAgentAction('{"action":"note","text":"Aero 13: 8 GB, $899"}')).toEqual({ ok: true, action: { action: 'note', text: 'Aero 13: 8 GB, $899' } });
    expect(parseAgentAction('{"action":"note"}')).toEqual({ ok: false, error: 'note requires text to remember' });
  });
});

describe('parseAgentResponse (plan + several actions)', () => {
  it('reads a plan and a list of actions', () => {
    const r = parseAgentResponse('{"plan":["[x] Open login","[ ] Sign in"],"actions":[{"action":"type","elementId":1,"text":"demo"},{"action":"click","elementId":"[2]"}]}');
    expect(r).toEqual({
      ok: true,
      plan: ['[x] Open login', '[ ] Sign in'],
      actions: [{ action: 'type', elementId: 1, text: 'demo' }, { action: 'click', elementId: 2 }],
      notes: [],
    });
  });

  it('still accepts a single action object', () => {
    expect(parseAgentResponse('{"action":"scroll","direction":"up"}')).toEqual({
      ok: true, plan: undefined, actions: [{ action: 'scroll', direction: 'up' }], notes: [],
    });
  });

  it('rejects the whole response when one action is invalid, saying which', () => {
    expect(parseAgentResponse('{"actions":[{"action":"click","elementId":1},{"action":"click"}]}'))
      .toEqual({ ok: false, error: 'Action 2: click requires a numeric elementId (you sent {"action":"click"})' });
    expect(parseAgentResponse('{"actions":[]}')).toMatchObject({ ok: false });
    expect(parseAgentResponse('{"plan":["[ ] a"]}')).toEqual({ ok: false, error: 'Response has no "actions" list' });
  });

  it(`runs at most ${MAX_BATCH} actions`, () => {
    const many = Array.from({ length: MAX_BATCH + 2 }, () => ({ action: 'scroll' }));
    const r = parseAgentResponse(JSON.stringify({ actions: many }));
    expect(r.ok && r.actions).toHaveLength(MAX_BATCH);
    expect(r.ok && r.notes[0]).toBe(`only the first ${MAX_BATCH} actions were run`);
  });

  it('lets "done" follow notes, but not actions whose result is unseen', () => {
    const notesThenDone = parseAgentResponse('{"actions":[{"action":"note","text":"total $42"},{"action":"done","summary":"$42"}]}');
    expect(notesThenDone.ok && notesThenDone.actions.map((a) => a.action)).toEqual(['note', 'done']);

    const clickThenDone = parseAgentResponse('{"actions":[{"action":"click","elementId":3},{"action":"done","summary":"ok"}]}');
    expect(clickThenDone.ok && clickThenDone.actions.map((a) => a.action)).toEqual(['click']);
    expect(clickThenDone.ok && clickThenDone.notes[0]).toMatch(/"done" was not run/);
  });

  it('drops empty plan items and caps the plan length', () => {
    const plan = ['', '  ', ...Array.from({ length: 20 }, (_, i) => `[ ] step ${i}`)];
    const r = parseAgentResponse(JSON.stringify({ plan, actions: [{ action: 'scroll' }] }));
    expect(r.ok && r.plan).toHaveLength(12);
    expect(r.ok && r.plan?.[0]).toBe('[ ] step 0');
  });
});
