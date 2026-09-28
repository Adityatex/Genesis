// entrypoints/background.ts
// Background service worker — message router, LLM API proxy, storage management

import { summarizePage, explainText, chatWithPage, planAgentStep, listModels } from '@/lib/api/llmClient';
import {
  startRun, stopRun, resumeRun, forgetRun, getRunView, isRunning, notifyTabLoading, type RunnerDeps,
} from '@/lib/agent/runner';
import {
  PROVIDERS, PROVIDER_IDS, SETTINGS_KEY, LEGACY_KEYS, readSettings, resolveConfig, resolveChain, configProblem,
  validateBaseUrl, maskKey, type LLMConfig, type ProviderId, type StoredLLMSettings,
} from '@/lib/api/providers';
import { formatError, withTimeout } from '@/lib/utils/errorHandler';
import { providerPool, modelLabel, type FallbackResult } from '@/lib/api/fallback';
import { trustedClick, trustedKey, trustedType, releaseTab, watchDetach } from '@/lib/agent/trustedInput';
import { PREFS_KEY, DEFAULT_PREFS, type AgentPrefs } from '@/lib/agent/prefs';

declare var chrome: any;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep the service worker alive while an agent runs: Chrome may stop an idle
 * worker after ~30s, and one reasoning-model call can take longer than that.
 * Any extension API call resets the idle timer.
 */
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
let activeRuns = 0;
function holdKeepAlive(): void {
  if (activeRuns++ === 0) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
}
function releaseKeepAlive(): void {
  if (--activeRuns === 0 && keepAliveTimer) clearInterval(keepAliveTimer);
}

export default defineBackground(() => {
  console.log('[Genesis] Background service worker started');
  watchDetach();

  /** Agent preferences. Trusted input is on unless the user turns it off. */
  async function loadPrefs(): Promise<AgentPrefs> {
    const stored: any = await browser.storage.local.get(PREFS_KEY);
    return { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] ?? {}) };
  }

  // ---- Agent runner: the loop lives here, not in the page (lib/agent/runner.ts)
  const runnerDeps: RunnerDeps = {
    plan: async (goal, snapshot, history, currentPlan) => {
      // Any provider in the chain can answer: the prompt carries the whole task state
      const { value, config, skipped } = await ask((c) => planAgentStep(goal, snapshot, history, currentPlan, c));
      return { text: value, model: modelLabel(config), unavailable: skipped };
    },
    // frameId 0: only the top frame's content script (the sidebar) handles agent messages
    send: (tabId, message, timeoutMs) => withTimeout(chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), timeoutMs, 'Page'),
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return { status: tab.status, url: tab.url, title: tab.title };
    },
    navigate: async (tabId, url) => { await chrome.tabs.update(tabId, { url }); },
    onRunEnded: (tabId) => releaseTab(tabId), // drop the debugger (and its banner)
    sleep: wait,
  };

  function runAgent(tabId: number, goal: string, checkpoint: number): void {
    holdKeepAlive();
    startRun(runnerDeps, tabId, goal, { checkpoint })
      .catch((err) => console.error('[Genesis] Agent run failed:', err))
      .finally(releaseKeepAlive);
  }

  // The runner needs to know when a page starts loading (clicks and form submits navigate)
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === 'loading' && isRunning(tabId)) notifyTabLoading(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => forgetRun(tabId));

  // Store the default API key on install
  browser.runtime.onInstalled.addListener(async () => {
    console.log('[Genesis] Installed — BYOK mode, no default key stored');
  });

  // Provider settings (BYOK: keys are never hardcoded, and only this worker reads them)
  async function loadSettings(): Promise<StoredLLMSettings> {
    return readSettings(await browser.storage.local.get([SETTINGS_KEY, ...LEGACY_KEYS]));
  }

  /** Config for the active provider, or throws a message saying what's missing. */
  async function requireConfig(): Promise<LLMConfig> {
    const config = resolveConfig(await loadSettings());
    const problem = configProblem(config);
    if (problem) throw new Error(problem);
    return config;
  }

  /**
   * Call the active provider, or a backup when it's rate-limited or failing
   * (lib/api/fallback.ts). Throws if the active provider isn't set up.
   */
  async function ask<T>(call: (config: LLMConfig) => Promise<T>): Promise<FallbackResult<T>> {
    const chain = resolveChain(await loadSettings());
    const problem = configProblem(chain[0]);
    if (problem) throw new Error(problem);
    return providerPool.run(chain, call);
  }

  function isProvider(id: unknown): id is ProviderId {
    return typeof id === 'string' && (PROVIDER_IDS as string[]).includes(id);
  }

  // Central message handler
  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    const { action, payload } = message;

    // Handle async operations
    (async () => {
      try {
        switch (action) {
          case 'GET_LLM_SETTINGS': {
            // The popup only ever sees masked keys
            const settings = await loadSettings();
            const maskedKeys = Object.fromEntries(PROVIDER_IDS.map(id => [id, maskKey(settings.keys[id] ?? '')]));
            // Providers with a key and model saved, which can serve as backups
            const ready = PROVIDER_IDS.filter(id => configProblem(resolveConfig(settings, id)) === null);
            sendResponse({
              success: true,
              data: {
                provider: settings.provider, models: settings.models, customBaseUrl: settings.customBaseUrl ?? '', maskedKeys,
                fallbacks: settings.fallbacks ?? [], ready,
              },
            });
            break;
          }

          case 'SAVE_LLM_SETTINGS': {
            // asBackup: save this provider's key and model and add it to the
            // backups, without making it the active provider
            const { provider, model, apiKey, customBaseUrl, asBackup } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            if (provider === 'custom') {
              const urlError = validateBaseUrl(customBaseUrl ?? '');
              if (urlError) throw new Error(urlError);
            }
            const settings = await loadSettings();
            if (typeof model === 'string') settings.models[provider] = model.trim();
            // An empty key field means "keep the saved key"
            if (typeof apiKey === 'string' && apiKey.trim()) settings.keys[provider] = apiKey.trim();
            if (provider === 'custom') settings.customBaseUrl = customBaseUrl.trim();
            if (asBackup && provider !== settings.provider) {
              const problem = configProblem(resolveConfig(settings, provider));
              if (problem) throw new Error(problem);
              settings.fallbacks = [...(settings.fallbacks ?? []).filter(id => id !== provider), provider];
            } else {
              settings.provider = provider;
              settings.fallbacks = (settings.fallbacks ?? []).filter(id => id !== provider);
            }
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            await browser.storage.local.remove([...LEGACY_KEYS]); // migrated
            sendResponse({
              success: true,
              data: { maskedKey: maskKey(settings.keys[provider] ?? ''), provider: settings.provider, fallbacks: settings.fallbacks },
            });
            break;
          }

          case 'SAVE_FALLBACKS': {
            // Backup providers, in order; each uses its own saved key and model
            const list: unknown[] = Array.isArray(payload?.fallbacks) ? payload.fallbacks : [];
            const settings = await loadSettings();
            settings.fallbacks = [...new Set(list.filter(isProvider))].filter(id => id !== settings.provider);
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            sendResponse({ success: true, data: { fallbacks: settings.fallbacks } });
            break;
          }

          case 'LIST_MODELS': {
            // Uses a key typed into the popup (not saved yet) or the saved one
            const { provider, apiKey, customBaseUrl } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            const settings = await loadSettings();
            if (typeof apiKey === 'string' && apiKey.trim()) settings.keys[provider] = apiKey.trim();
            if (provider === 'custom') settings.customBaseUrl = customBaseUrl ?? '';
            const config = resolveConfig(settings, provider);
            const urlError = config.baseUrl ? validateBaseUrl(config.baseUrl) : 'Enter the server URL first';
            if (urlError) throw new Error(urlError);
            if (PROVIDERS[provider].needsKey && !config.apiKey) throw new Error(`Enter your ${config.label} API key first`);
            sendResponse({ success: true, data: { models: await listModels(config) } });
            break;
          }

          case 'SUMMARIZE': {
            const { value: summary } = await ask((c) => summarizePage(payload.text, c));
            sendResponse({ success: true, data: { result: summary } });
            break;
          }

          case 'EXPLAIN': {
            const { value: explanation } = await ask((c) => explainText(payload.text, c));
            sendResponse({ success: true, data: { result: explanation } });
            break;
          }

          case 'CHAT': {
            const { value: reply } = await ask((c) => chatWithPage(payload.message, payload.pageContext || '', c));
            sendResponse({ success: true, data: { result: reply } });
            break;
          }

          case 'START_AGENT': {
            // The sidebar asks; the background runs the whole task, surviving page loads
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const goal = String(payload?.goal ?? '').trim();
            if (!goal) throw new Error('No goal');
            await requireConfig(); // fail fast on missing key/model, before the run starts
            runAgent(tabId, goal, (await loadPrefs()).stepCheckpoint);
            sendResponse({ success: true });
            break;
          }

          case 'STOP_AGENT': {
            const tabId = _sender.tab?.id;
            if (tabId !== undefined) {
              if (payload?.forget) forgetRun(tabId);
              else stopRun(tabId);
            }
            sendResponse({ success: true });
            break;
          }

          case 'RESUME_AGENT': {
            // Continue a run paused at a checkpoint or because it looked stuck
            const tabId = _sender.tab?.id;
            if (tabId !== undefined) resumeRun(tabId);
            sendResponse({ success: true });
            break;
          }

          case 'GET_AGENT_STATE': {
            // A freshly loaded page asks what the agent is doing in its tab
            const tabId = _sender.tab?.id;
            sendResponse({ success: true, data: tabId === undefined ? null : getRunView(tabId) });
            break;
          }

          case 'TRUSTED_INPUT': {
            // Real mouse/keyboard input via the DevTools Protocol. On any failure
            // the content script falls back to scripted DOM events.
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const prefs = await loadPrefs();
            if (!prefs.trustedInput) throw new Error('Trusted input is turned off');
            const { kind, x, y, text, key } = payload ?? {};
            if (kind === 'click') await trustedClick(tabId, Number(x), Number(y));
            else if (kind === 'type') await trustedType(tabId, String(text ?? ''));
            else if (kind === 'key') await trustedKey(tabId, String(key ?? 'Enter'));
            else throw new Error(`Unknown trusted input: ${kind}`);
            sendResponse({ success: true });
            break;
          }

          case 'FRAME_SNAPSHOTS': {
            // Find which frames received the top page's tokens (see lib/agent/frames.ts),
            // then collect a snapshot from each one's content script
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const tokens: string[] = Array.isArray(payload?.tokens) ? payload.tokens : [];
            const probes = await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              func: () => (globalThis as any).__genesisFrameToken ?? null,
            });
            const frames = probes.filter((p: any) => p.frameId !== 0 && tokens.includes(p.result));
            const data = await Promise.all(frames.map(async (p: any) => {
              try {
                const res = await withTimeout(
                  chrome.tabs.sendMessage(tabId, { action: 'FRAME_SNAPSHOT' }, { frameId: p.frameId }),
                  3000,
                  'Frame snapshot',
                ) as any;
                return { token: p.result, frameId: p.frameId, snapshot: res?.success ? res.data : null };
              } catch {
                return { token: p.result, frameId: p.frameId, snapshot: null };
              }
            }));
            sendResponse({ success: true, data });
            break;
          }

          case 'FRAME_EXECUTE': {
            // Run an agent action inside a cross-origin frame's content script
            const tabId = _sender.tab?.id;
            if (tabId === undefined) throw new Error('No tab');
            const { frameId, action: frameAction, offset } = payload ?? {};
            const res = await withTimeout(
              chrome.tabs.sendMessage(tabId, { action: 'FRAME_EXECUTE', payload: { action: frameAction, offset } }, { frameId }),
              30000,
              'Frame action',
            ) as any;
            if (!res?.success) throw new Error(res?.error || 'The frame did not respond');
            sendResponse({ success: true, data: res.data });
            break;
          }

          case 'GET_PREFS': {
            sendResponse({ success: true, data: await loadPrefs() });
            break;
          }

          case 'SAVE_PREFS': {
            const prefs = { ...(await loadPrefs()), ...(payload ?? {}) };
            await browser.storage.local.set({ [PREFS_KEY]: prefs });
            sendResponse({ success: true, data: prefs });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown action: ${action}` });
        }
      } catch (error) {
        console.error('[Genesis] Background error:', error);
        sendResponse({ success: false, error: formatError(error) });
      }
    })();

    // Return true to indicate we'll send the response asynchronously
    return true;
  });
});
