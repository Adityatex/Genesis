import { describe, it, expect } from 'vitest';
import { migrateFromGenesis, type MigrationDeps } from '@/lib/utils/renameMigration';

function fakeChrome(initial: Record<string, unknown>, alarms: string[] = []) {
  const store: Record<string, unknown> = { ...initial };
  const cleared: string[] = [];
  const deps: MigrationDeps = {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    set: async (items) => { Object.assign(store, items); },
    remove: async (keys) => { for (const k of keys) delete store[k]; },
    alarmNames: async () => alarms,
    clearAlarm: (name) => { cleared.push(name); },
  };
  return { store, cleared, deps };
}

describe('moving data saved by Genesis', () => {
  it('moves each old key to its new name and deletes the old one', async () => {
    const { store, deps } = fakeChrome({ genesis_llm: { provider: 'groq' }, genesis_workflows: [{ name: 'w' }], other: 1 });
    await migrateFromGenesis(deps);
    expect(store).toEqual({ tabi_llm: { provider: 'groq' }, tabi_workflows: [{ name: 'w' }], other: 1 });
  });

  it('never overwrites something already saved under the new name', async () => {
    const { store, deps } = fakeChrome({ genesis_prefs: { old: true }, tabi_prefs: { new: true } });
    await migrateFromGenesis(deps);
    expect(store).toEqual({ tabi_prefs: { new: true } });
  });

  it('does nothing the second time', async () => {
    const { store, deps } = fakeChrome({ genesis_sites: { blocked: ['a.com'] } });
    await migrateFromGenesis(deps);
    await migrateFromGenesis(deps);
    expect(store).toEqual({ tabi_sites: { blocked: ['a.com'] } });
  });

  it('clears alarms set under the old names, and only those', async () => {
    const { cleared, deps } = fakeChrome({}, ['genesis-mcp', 'genesis-schedule:abc', 'tabi-schedule:abc']);
    await migrateFromGenesis(deps);
    expect(cleared).toEqual(['genesis-mcp', 'genesis-schedule:abc']);
  });
});
