import { describe, it, expect } from 'vitest';
import { redact } from '../eval/redact.mts';

describe('redact', () => {
  it('masks provider keys wherever they appear', () => {
    expect(redact('key gsk_AbC123xyz789 leaked')).toBe('key gsk_*** leaked');
    expect(redact('sk-proj-AbCdEfGhIjKlMnOpQr1234')).toBe('sk-***');
    expect(redact('sk-or-v1-0123456789abcdef0123')).toBe('sk-***');
  });

  it('masks Authorization headers as Playwright prints them', () => {
    expect(redact('    - authorization: Bearer some.opaque-token_value')).toBe('    - authorization: Bearer ***');
  });

  it('masks organization ids from provider error messages', () => {
    expect(redact('in organization `org_01m3bpzwe5ex` service tier')).toBe('in organization `org_***` service tier');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('Rate limit reached on tokens per day')).toBe('Rate limit reached on tokens per day');
  });
});
