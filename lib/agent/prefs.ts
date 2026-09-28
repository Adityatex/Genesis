// lib/agent/prefs.ts
// Agent preferences, stored in chrome.storage.local and edited in the popup.

export interface AgentPrefs {
  /**
   * Use the Chrome DevTools Protocol for real (isTrusted) clicks and keystrokes.
   * Chrome shows a "started debugging this browser" banner while an agent run
   * uses it. Off = scripted DOM events only, which some sites ignore.
   */
  trustedInput: boolean;
  /**
   * Pause and ask "keep going?" every this many steps (0 = never). Runs have
   * no step limit; this only guards against quietly spending a lot of tokens.
   */
  stepCheckpoint: number;
}

export const PREFS_KEY = 'genesis_prefs';

export const CHECKPOINT_CHOICES = [25, 50, 100, 0] as const;

export const DEFAULT_PREFS: AgentPrefs = {
  trustedInput: true,
  stepCheckpoint: 50,
};
