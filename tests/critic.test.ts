import { describe, it, expect, vi } from 'vitest';
import { criticStep, criticMessages, parseVerdict, checkStep, sensitiveKind, siteOf, namedInGoal, type StepContext } from '@/lib/agent/critic';
import type { AgentAction } from '@/lib/agent/actionExecutor';
import type { LLMConfig } from '@/lib/api/providers';

const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  goal: 'What shipping address is on my Byte Store account?',
  pageUrl: 'https://bytestore.test/account',
  sites: new Set(['bytestore.test']),
  confirm: true,
  ...over,
});
const act = (a: Partial<AgentAction> & { action: AgentAction['action'] }) => a as AgentAction;

describe('which steps the critic checks', () => {
  it('going to a site the task has not been on', () => {
    const step = criticStep(act({ action: 'navigate', url: 'https://verify-account.example/check' }), ctx());
    expect(step).toEqual({ text: 'go to https://verify-account.example/check', why: "it opens verify-account.example, a site this task hasn't been on", key: 'site:verify-account.example' });
    expect(criticStep(act({ action: 'navigate', url: 'https://bytestore.test/settings' }), ctx())).toBeNull();
  });

  it('but not a site the user named', () => {
    const goal = 'Find a USB-C hub on amazon under $30';
    expect(criticStep(act({ action: 'navigate', url: 'https://www.amazon.co.uk/s?k=hub' }), ctx({ goal, sites: new Set() }))).toBeNull();
    expect(criticStep(act({ action: 'navigate', url: 'https://amazon-deals.evil.example/' }), ctx({ goal, sites: new Set() }))).not.toBeNull();
  });

  it('a link to another site, like navigating there (one answer covers both)', () => {
    const target = '<a> "Verify your account" href="https://verify-account.example/check"';
    const link = criticStep(act({ action: 'click', elementId: 3 }), ctx({ target }));
    expect(link?.why).toMatch(/opens verify-account\.example/);
    expect(link?.key).toBe(criticStep(act({ action: 'navigate', url: 'https://verify-account.example/other' }), ctx())?.key);
    expect(criticStep(act({ action: 'click', elementId: 3 }), ctx({ target: '<a> "Settings" href="https://bytestore.test/settings"' }))).toBeNull();
  });

  it('personal data typed that the user did not give', () => {
    const target = '<input> type="email" "Email"';
    const step = criticStep(act({ action: 'type', elementId: 2, text: 'ada@example.com' }), ctx({ target }));
    expect(step?.why).toBe("it types an email address that isn't in the user's request");
    expect(step?.text).toContain('type "ada@example.com" into a field on bytestore.test, the page labels it: <input> type="email" "Email"');
    // Given by the user: theirs to share
    expect(criticStep(act({ action: 'type', elementId: 2, text: 'ada@example.com' }), ctx({ goal: 'Sign up with ada@example.com', target }))).toBeNull();
    // Nothing personal
    expect(criticStep(act({ action: 'type', elementId: 2, text: 'trail runner' }), ctx())).toBeNull();
  });

  it('not passwords: the user gave them, or the agent made one up to sign up', () => {
    expect(criticStep(act({ action: 'type', elementId: 2, text: 'Tr41lRunner!2026' }), ctx({ target: '<input> type="password" "Password"' }))).toBeNull();
  });

  it('data carried in an address', () => {
    const step = criticStep(act({ action: 'navigate', url: 'https://bytestore.test/track?e=ada%40example.com' }), ctx());
    expect(step?.why).toBe("the address carries an email address that isn't in the user's request");
  });

  it("steps that can't be undone only when nobody asks the user about them", () => {
    const target = '<button> "Place order"';
    expect(criticStep(act({ action: 'click', elementId: 9 }), ctx({ target }))).toBeNull(); // the user is asked anyway
    expect(criticStep(act({ action: 'click', elementId: 9 }), ctx({ target, confirm: false }))?.why).toMatch(/a purchase, which can't be undone/);
  });

  it('ordinary steps: no check', () => {
    for (const a of [act({ action: 'click', elementId: 1 }), act({ action: 'scroll', direction: 'down' }), act({ action: 'select', elementId: 2, value: 'US 10' })]) {
      expect(criticStep(a, ctx({ target: '<button> "Add to cart"' }))).toBeNull();
    }
  });

  it('not run_code: it can only read the page, with no network', () => {
    expect(criticStep(act({ action: 'run_code', text: 'return document.title' }), ctx())).toBeNull();
  });
});

describe('what the critic sees and says', () => {
  it('only the goal, the sites and the step: no page text', () => {
    const [system, user] = criticMessages('Find my address', { text: 'go to https://x.example/', why: 'new site', key: 'site:x.example' }, ['bytestore.test']);
    expect(system.content).toMatch(/never see the page/);
    expect(user.content).toBe("USER'S TASK: Find my address\nSITES THIS TASK HAS BEEN ON: bytestore.test\n\nSTEP TO CHECK: go to https://x.example/\nWHY IT IS CHECKED: new site");
  });

  it('anything but a clear yes is a no', () => {
    expect(parseVerdict('{"ok": true}')).toEqual({ ok: true, reason: '' });
    expect(parseVerdict('Sure! {"ok": false, "reason": "The task is only to read the address."}')).toEqual({ ok: false, reason: 'The task is only to read the address.' });
    expect(parseVerdict('{"ok": "yes"}').ok).toBe(false);
    expect(parseVerdict('I think it is fine').reason).toBe("the safety check didn't give a clear answer");
  });

  it('asks the model in JSON mode', async () => {
    const call = vi.fn(async () => '{"ok":false,"reason":"Unrelated site."}');
    const verdict = await checkStep('goal', { text: 'go to x', why: 'new site', key: 'site:x' }, [], { provider: 'groq', model: 'm', apiKey: 'k' } as LLMConfig, call as any);
    expect(verdict).toEqual({ ok: false, reason: 'Unrelated site.' });
    expect((call.mock.calls[0] as any[])[2]).toMatchObject({ jsonMode: true, temperature: 0 });
  });
});

describe('helpers', () => {
  it('siteOf', () => {
    expect(siteOf('https://www.Amazon.com/x')).toBe('amazon.com');
    expect(siteOf('about:blank')).toBe('');
    expect(siteOf(undefined)).toBe('');
  });

  it('sensitiveKind', () => {
    expect(sensitiveKind('ada@example.com')).toBe('an email address');
    expect(sensitiveKind('4242 4242 4242 4242')).toBe('a card number');
    expect(sensitiveKind('+44 7700 900123')).toBe('a phone number');
    expect(sensitiveKind('US 10')).toBeNull();
    expect(sensitiveKind('2')).toBeNull();
    expect(sensitiveKind('2026-10-02')).toBeNull();
    expect(sensitiveKind('02/10/2026')).toBeNull();
    expect(sensitiveKind('2026-10-02 2026-10-05')).toBeNull();
    expect(sensitiveKind('Check-in 2026-10-02, check-out 2026-10-05')).toBeNull();
  });

  it('namedInGoal', () => {
    expect(namedInGoal('open github and star the repo', 'github.com')).toBe(true);
    expect(namedInGoal('check bbc.co.uk headlines', 'bbc.co.uk')).toBe(true);
    expect(namedInGoal('read my mail', 'mail.evil.example')).toBe(false);
    expect(namedInGoal('anything', '127.0.0.1')).toBe(false);
  });
});
