// lib/agent/prefs.ts
// Agent preferences, stored in chrome.storage.local and edited in the popup.

export interface AgentPrefs {
  /**
   * Use the Chrome DevTools Protocol for real (isTrusted) clicks and keystrokes.
   * Chrome shows a "started debugging this browser" banner while an agent run
   * uses it. Off = scripted DOM events only, which some sites ignore.
   */
  trustedInput: boolean;
}

export const PREFS_KEY = 'genesis_prefs';

export const DEFAULT_PREFS: AgentPrefs = {
  trustedInput: true,
};
