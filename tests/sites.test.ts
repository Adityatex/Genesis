import { describe, it, expect } from 'vitest';
import { normalizeSite, matchesRule, siteStatus, urlStatus, cleanRules } from '@/lib/agent/sites';

describe('site rules', () => {
  it('takes a site however the user writes it', () => {
    expect(normalizeSite('mybank.com')).toBe('mybank.com');
    expect(normalizeSite('  https://www.MyBank.com/login?x=1 ')).toBe('mybank.com');
    expect(normalizeSite('*.mybank.com')).toBe('mybank.com');
    expect(normalizeSite('mail.google.com')).toBe('mail.google.com');
    expect(normalizeSite('localhost')).toBe('localhost');
    expect(normalizeSite('127.0.0.1')).toBe('127.0.0.1');
    for (const bad of ['', 'bank', 'not a site', 'https://', 'javascript:alert(1)']) expect(normalizeSite(bad), bad).toBeNull();
  });

  it('a rule covers its subdomains, not look-alikes', () => {
    expect(matchesRule('login.mybank.com', 'mybank.com')).toBe(true);
    expect(matchesRule('mybank.com', 'mybank.com')).toBe(true);
    expect(matchesRule('notmybank.com', 'mybank.com')).toBe(false);
    expect(matchesRule('mybank.com.evil.example', 'mybank.com')).toBe(false);
    expect(matchesRule('mybank.com', 'login.mybank.com')).toBe(false);
  });

  it('blocked wins; with an allow list, everything else is unlisted', () => {
    const rules = { blocked: ['mybank.com'], allowed: ['shop.test', 'mybank.com'] };
    expect(siteStatus('login.mybank.com', rules)).toBe('blocked');
    expect(siteStatus('shop.test', rules)).toBe('allowed');
    expect(siteStatus('other.test', rules)).toBe('unlisted');
    expect(siteStatus('other.test', { blocked: ['mybank.com'], allowed: [] })).toBe('open');
    expect(siteStatus('', rules)).toBe('open'); // about:blank, chrome:// pages
    expect(urlStatus('https://www.shop.test/cart', rules)).toEqual({ site: 'shop.test', status: 'allowed' });
  });

  it('cleans what is stored', () => {
    expect(cleanRules({ blocked: ['https://www.mybank.com', 'mybank.com', 'nope'], allowed: ['mybank.com', 'shop.test'] }))
      .toEqual({ blocked: ['mybank.com'], allowed: ['shop.test'] });
    expect(cleanRules(undefined)).toEqual({ blocked: [], allowed: [] });
  });
});
