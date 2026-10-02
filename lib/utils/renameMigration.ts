// lib/utils/renameMigration.ts
// Genesis was renamed Tabi. Data saved under the old genesis_* keys moves to
// the tabi_* keys once, when the new version's worker first starts, so nobody
// loses their keys, workflows or history. Alarms set under the old names are
// cleared; the scheduler and the MCP bridge set them again under the new ones.
// Chrome specifics are injected so this can be tested.

/** Old storage key → new one. */
export const RENAMED_KEYS: Record<string, string> = {
  genesis_llm: 'tabi_llm',
  genesis_prefs: 'tabi_prefs',
  genesis_sites: 'tabi_sites',
  genesis_runs: 'tabi_runs',
  genesis_profile: 'tabi_profile',
  genesis_schedules: 'tabi_schedules',
  genesis_shortcuts: 'tabi_shortcuts',
  genesis_skills: 'tabi_skills',
  genesis_workflows: 'tabi_workflows',
  genesis_mcp: 'tabi_mcp',
};

/** Alarms the old version set: genesis-mcp and genesis-schedule:<id>. */
export const isLegacyAlarm = (name: string) => name.startsWith('genesis-');

export interface MigrationDeps {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  alarmNames(): Promise<string[]>;
  clearAlarm(name: string): void;
}

/**
 * Copy each old key to its new name (unless something is already saved there),
 * then delete the old keys. Safe to run on every start: once the old keys are
 * gone it does nothing.
 */
export async function migrateFromGenesis(deps: MigrationDeps): Promise<void> {
  const oldKeys = Object.keys(RENAMED_KEYS);
  const stored = await deps.get([...oldKeys, ...Object.values(RENAMED_KEYS)]);
  const found = oldKeys.filter((key) => stored[key] !== undefined);
  if (found.length) {
    const copies = Object.fromEntries(
      found.filter((key) => stored[RENAMED_KEYS[key]] === undefined).map((key) => [RENAMED_KEYS[key], stored[key]]),
    );
    // Copy before deleting, so a crash in between loses nothing
    if (Object.keys(copies).length) await deps.set(copies);
    await deps.remove(found);
  }
  for (const name of await deps.alarmNames()) if (isLegacyAlarm(name)) deps.clearAlarm(name);
}
