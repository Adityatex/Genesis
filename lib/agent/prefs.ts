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
  /**
   * Send the model screenshots with the page's elements numbered: never,
   * on planning steps only, or every step. Images cost tokens; off by default.
   */
  screenshots: ScreenshotMode;
  /**
   * Ask for the agent's reply as a native tool call (function calling) instead
   * of JSON text. Models or providers that refuse tools fall back to JSON on
   * their own. Experimental, so off by default until the benchmark shows a win.
   */
  nativeTools: boolean;
  /**
   * Let the agent run its own JavaScript to read a page (run_code), in an
   * isolated context with the network functions removed. Off by default:
   * page content could try to steer the code.
   */
  customCode: boolean;
}

export type ScreenshotMode = 'off' | 'planning' | 'always';

export const PREFS_KEY = 'genesis_prefs';

export const CHECKPOINT_CHOICES = [25, 50, 100, 0] as const;

export const DEFAULT_PREFS: AgentPrefs = {
  trustedInput: true,
  stepCheckpoint: 50,
  screenshots: 'off',
  nativeTools: false,
  customCode: false,
};
