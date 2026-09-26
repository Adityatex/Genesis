import { describe, it, expect } from 'vitest';
import { registerError, TAKEN_USERNAMES } from '../eval/server.mts';

// The username-taken task is only fair if these rules match what its page tells the agent
describe('eval fixture: sign-up rules', () => {
  it('rejects taken usernames, whatever the case', () => {
    expect(TAKEN_USERNAMES).toContain('ada');
    expect(registerError({ username: 'Ada', password: 'Analytical1815' })).toMatch(/already taken/);
  });

  it('requires 10+ characters and a number in the password', () => {
    expect(registerError({ username: 'ada1815', password: 'short1' })).toMatch(/at least 10 characters/);
    expect(registerError({ username: 'ada1815', password: 'nodigitsatall' })).toMatch(/include a number/);
  });

  it('accepts a free username with a strong password', () => {
    expect(registerError({ username: 'ada1815', password: 'Analytical1815' })).toBeNull();
  });
});
