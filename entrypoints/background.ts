// entrypoints/background.ts
// Background service worker — message router, LLM API proxy, storage management

import { summarizePage, explainText, chatWithPage, planAgentStep, listModels } from '@/lib/api/llmClient';
import {
  PROVIDERS, PROVIDER_IDS, SETTINGS_KEY, LEGACY_KEYS, readSettings, resolveConfig, configProblem,
  validateBaseUrl, maskKey, type LLMConfig, type ProviderId, type StoredLLMSettings,
} from '@/lib/api/providers';
import { formatError } from '@/lib/utils/errorHandler';
import { parseAgentAction } from '@/lib/agent/parseAction';

declare var chrome: any;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineBackground(() => {
  console.log('[Genesis] Background service worker started');

  // In-memory agent session — persists across page navigations within the same browser session
  let activeAgentSession: any = null;

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
            sendResponse({
              success: true,
              data: { provider: settings.provider, models: settings.models, customBaseUrl: settings.customBaseUrl ?? '', maskedKeys },
            });
            break;
          }

          case 'SAVE_LLM_SETTINGS': {
            const { provider, model, apiKey, customBaseUrl } = payload ?? {};
            if (!isProvider(provider)) throw new Error('Unknown provider');
            if (provider === 'custom') {
              const urlError = validateBaseUrl(customBaseUrl ?? '');
              if (urlError) throw new Error(urlError);
            }
            const settings = await loadSettings();
            settings.provider = provider;
            if (typeof model === 'string') settings.models[provider] = model.trim();
            // An empty key field means "keep the saved key"
            if (typeof apiKey === 'string' && apiKey.trim()) settings.keys[provider] = apiKey.trim();
            if (provider === 'custom') settings.customBaseUrl = customBaseUrl.trim();
            await browser.storage.local.set({ [SETTINGS_KEY]: settings });
            await browser.storage.local.remove([...LEGACY_KEYS]); // migrated
            sendResponse({ success: true, data: { maskedKey: maskKey(settings.keys[provider] ?? '') } });
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
            const config = await requireConfig();
            const summary = await summarizePage(payload.text, config);
            sendResponse({ success: true, data: { result: summary } });
            break;
          }

          case 'EXPLAIN': {
            const config = await requireConfig();
            const explanation = await explainText(payload.text, config);
            sendResponse({ success: true, data: { result: explanation } });
            break;
          }

          case 'CHAT': {
            const config = await requireConfig();
            const reply = await chatWithPage(payload.message, payload.pageContext || '', config);
            sendResponse({ success: true, data: { result: reply } });
            break;
          }

          case 'AGENT_STEP': {
            const config = await requireConfig();
            const { goal, domSnapshot, actionHistory, stepCount } = payload;
            const rawResponse = await planAgentStep(goal, domSnapshot, actionHistory || [], config);
            console.log('[Genesis] LLM raw response:', rawResponse);
            const parsed = parseAgentAction(rawResponse);
            if (!parsed.ok) {
              // Let the loop record the failure and re-plan instead of faking "done"
              sendResponse({ success: false, code: 'INVALID_ACTION', error: parsed.error });
              break;
            }
            const parsedAction = parsed.action;

            console.log('[Genesis] Parsed action:', parsedAction.action, parsedAction.url ?? parsedAction.elementId ?? '');

            // Always save session BEFORE returning the action to content script.
            // If the action causes unintended navigation (clicking a link, form submit),
            // the session is already persisted and can be resumed on the new page.
            if (parsedAction.action !== 'done') {
              const actionDesc = `${parsedAction.action}${parsedAction.elementId !== undefined ? ` [${parsedAction.elementId}]` : ''}${parsedAction.text ? ` "${parsedAction.text}"` : ''}${parsedAction.url ? ` → ${parsedAction.url}` : ''}`;
              const updatedHistory = [...(actionHistory || []), `${actionDesc} → (executing...)`];
              const sessionData = JSON.stringify({
                goal,
                actionHistory: updatedHistory,
                // stepCount is already this step's number; the resumed loop
                // increments before its next step (+1 here counted it twice)
                stepCount: stepCount || 0,
              });
              await chrome.storage.local.set({ genesis_agent_session: sessionData });
              console.log('[Genesis] Session pre-saved before action:', parsedAction.action);
            }

            // If navigate, handle entirely in background
            if (parsedAction.action === 'navigate' && parsedAction.url && _sender.tab?.id) {
              sendResponse({ success: true, data: { action: parsedAction, navigating: true } });
              await wait(300);
              console.log('[Genesis] Navigating tab', _sender.tab.id, 'to', parsedAction.url);
              chrome.tabs.update(_sender.tab.id, { url: parsedAction.url });
            } else {
              sendResponse({ success: true, data: { action: parsedAction } });
            }
            break;
          }

          case 'NAVIGATE_TAB': {
            // Save agent session to chrome.storage.local FIRST, then navigate
            if (payload.session) {
              const sessionStr = JSON.stringify(payload.session);
              await chrome.storage.local.set({ genesis_agent_session: sessionStr });
              // Verify the write
              const verify = await chrome.storage.local.get('genesis_agent_session');
              console.log('[Genesis] Session saved & verified:', !!verify.genesis_agent_session);
            }
            const tab = _sender.tab;
            console.log('[Genesis] NAVIGATE_TAB - tab:', tab?.id, 'url:', payload.url);
            if (tab?.id) {
              sendResponse({ success: true });
              // Delay to ensure response reaches content script before navigation kills it
              await wait(200);
              chrome.tabs.update(tab.id, { url: payload.url });
            } else {
              sendResponse({ success: false, error: 'No tab found' });
            }
            break;
          }

          case 'SAVE_AGENT_SESSION': {
            const sessionStr = JSON.stringify(payload);
            await chrome.storage.local.set({ genesis_agent_session: sessionStr });
            console.log('[Genesis] Agent session saved');
            sendResponse({ success: true });
            break;
          }

          case 'GET_AGENT_SESSION': {
            const stored = await chrome.storage.local.get('genesis_agent_session');
            console.log('[Genesis] Raw storage read:', typeof stored.genesis_agent_session, stored.genesis_agent_session ? 'HAS DATA' : 'EMPTY');
            let sessionData = null;
            if (stored.genesis_agent_session) {
              try {
                sessionData = JSON.parse(stored.genesis_agent_session);
              } catch (e) {
                console.error('[Genesis] Failed to parse session:', e);
              }
            }
            sendResponse({ success: true, data: sessionData });
            break;
          }

          case 'CLEAR_AGENT_SESSION': {
            await chrome.storage.local.remove('genesis_agent_session');
            console.log('[Genesis] Agent session cleared');
            sendResponse({ success: true });
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
