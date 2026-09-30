import { describe, it, expect, vi } from 'vitest';
import { checkCode, wrapCode, formatCodeResult, MAX_RESULT_CHARS } from '@/lib/agent/customCode';
import { startRun, type RunnerDeps, type TabInfo } from '@/lib/agent/runner';
import { describeAction } from '@/lib/agent/history';

describe('what run_code may do', () => {
  it('allows code that reads the page and returns data', () => {
    expect(checkCode("return [...document.querySelectorAll('tr')].map((r) => r.innerText)")).toBeNull();
    expect(checkCode("const rows = document.querySelectorAll('.price');\nreturn rows.length;")).toBeNull();
    expect(checkCode("return document.querySelector('a').href === location.href")).toBeNull(); // reading location is fine
  });

  it('refuses network access, stored data, acting, navigating and loading resources', () => {
    const refused: [string, string][] = [
      ["fetch('/api/orders')", 'network access'],
      ['new XMLHttpRequest()', 'network access'],
      ["navigator.sendBeacon('/x', 'y')", 'network access'],
      ['return document.cookie', 'cookies or stored data'],
      ["localStorage.getItem('token')", 'cookies or stored data'],
      ["eval('1+1')", 'running code built from strings'],
      ["new Function('return 1')()", 'running code built from strings'],
      ["document.querySelector('#buy').click()", 'acting on or changing the page'],
      ["document.forms[0].submit()", 'acting on or changing the page'],
      ["document.body.innerHTML = ''", 'acting on or changing the page'],
      ["location.href = '/logout'", 'navigating'],
      ["window.open('/x')", 'navigating'],
      ["new Image().src = '/x?' + data", 'loading resources'],
      ["document.createElement('script')", 'loading resources'],
      ["return 'https://evil.example/' + data", 'addresses in the code'],
    ];
    for (const [code, why] of refused) expect(checkCode(code), code).toContain(why);
  });

  it('refuses empty and oversized code', () => {
    expect(checkCode('  ')).toBe('there is no code');
    expect(checkCode(`return 1; ${'x'.repeat(4001)}`)).toContain('too long');
  });
});

describe('the wrapped code', () => {
  it('runs as an async function body, turns elements into text, and has no network functions', async () => {
    document.body.innerHTML = '<ul><li class="p">Aero $899</li><li class="p">Kite $1,049</li></ul>';
    // What the isolated world runs; here in the test page's own world instead
    const json = await (0, eval)(wrapCode(`
      const items = [...document.querySelectorAll('.p')];
      return { first: items[0], count: items.length, fetchType: typeof fetch, xhrType: typeof XMLHttpRequest };
    `));
    expect(JSON.parse(json)).toEqual({ first: 'Aero $899', count: 2, fetchType: 'undefined', xhrType: 'undefined' });
  });

  it('describes results for the model', () => {
    expect(formatCodeResult('[1,2]')).toBe('✅ The code returned: [1,2]');
    expect(formatCodeResult(undefined)).toContain('returned nothing');
    expect(formatCodeResult(JSON.stringify('x'.repeat(MAX_RESULT_CHARS + 50)))).toContain('(cut:');
  });
});

describe('run_code in a run', () => {
  function deps(answers: string[], runCode?: RunnerDeps['runCode']) {
    const tab: TabInfo = { status: 'complete', url: 'https://shop.test/', title: 'Shop' };
    const histories: string[][] = [];
    let i = 0;
    const d: RunnerDeps = {
      plan: vi.fn(async (_g: string, _s: string, history: string[]) => {
        histories.push([...history]);
        return answers[Math.min(i++, answers.length - 1)];
      }),
      send: vi.fn(async (_t: number, m: any) => (m.action === 'AGENT_SNAPSHOT' ? { text: 'PAGE' } : { ok: true })),
      getTab: vi.fn(async () => ({ ...tab })),
      navigate: vi.fn(async () => {}),
      onRunEnded: vi.fn(),
      sleep: vi.fn(async () => {}),
      runCode,
    };
    return { d, histories };
  }
  const readRows = '{"actions":[{"action":"run_code","text":"return [...document.querySelectorAll(\'tr\')].length"}]}';

  it('is refused when the user has not turned it on', async () => {
    const runCode = vi.fn(async () => '4');
    const { d, histories } = deps([readRows, '{"action":"done","summary":"ok"}'], runCode);
    await startRun(d, 200, 'Count rows');
    expect(runCode).not.toHaveBeenCalled();
    expect(histories[1][0]).toMatch(/→ ❌ Running your own code is turned off/);
  });

  it('runs allowed code through the debugger, wrapped, and returns the result', async () => {
    const runCode = vi.fn(async () => '4');
    const { d, histories } = deps([readRows, '{"action":"done","summary":"ok"}'], runCode);
    await startRun(d, 201, 'Count rows', { customCode: true });
    expect(runCode).toHaveBeenCalledTimes(1);
    expect((runCode.mock.calls[0] as any)[1]).toContain("Object.defineProperty(globalThis, name, { value: undefined");
    expect(histories[1][0]).toBe('run_code "return [...document.querySelectorAll(\'tr\')].length" (1 line) → ✅ The code returned: 4');
    // The code never goes to the page's content script
    expect((d.send as any).mock.calls.some(([, m]: any) => m.action === 'AGENT_EXECUTE')).toBe(false);
  });

  it('refuses code that breaks the rules without running it, and reports errors', async () => {
    const runCode = vi.fn(async () => { throw new Error('TypeError: x is not iterable'); });
    const { d, histories } = deps([
      '{"actions":[{"action":"run_code","text":"return document.cookie"}]}',
      '{"actions":[{"action":"run_code","text":"return [...x]"}]}',
      '{"action":"done","summary":"ok"}',
    ], runCode);
    await startRun(d, 202, 'Read', { customCode: true });
    expect(histories[1][0]).toMatch(/→ ❌ Not run: it uses cookies or stored data\. The code may only read this page/);
    expect(histories[2][1]).toMatch(/→ ❌ The code failed: TypeError: x is not iterable/);
    expect(runCode).toHaveBeenCalledTimes(1);
  });

  it('logs long code by its first line', () => {
    expect(describeAction({ action: 'run_code', text: "const rows = document.querySelectorAll('tr');\nreturn rows.length;" }))
      .toBe("run_code \"const rows = document.querySelectorAll('tr');…\" (2 lines)");
  });
});
