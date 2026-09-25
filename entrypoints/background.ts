// entrypoints/background.ts
// Background service worker — message router, Groq API proxy, storage management

import { summarizePage, explainText, chatWithPage, planAgentStep, DEFAULT_MODEL, type GroqAuth } from '@/lib/api/groqClient';
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

  // Get the current API key (BYOK-only, never hardcoded)
  async function getApiKey(): Promise<string> {
    const stored: any = await browser.storage.local.get('groqApiKey');
    return stored.groqApiKey || '';
  }

  async function getAuth(): Promise<GroqAuth> {
    const stored: any = await browser.storage.local.get(['groqApiKey', 'groqModel']);
    return { apiKey: stored.groqApiKey || '', model: stored.groqModel || DEFAULT_MODEL };
  }

  // Central message handler
  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    const { action, payload } = message;

    // Handle async operations
    (async () => {
      try {
        switch (action) {
          case 'GET_API_KEY': {
            const key = await getApiKey();
            // Mask the key for display
            const masked = key ? `${key.substring(0, 8)}...${key.substring(key.length - 4)}` : 'Not set';
            sendResponse({ success: true, data: { masked, hasKey: !!key } });
            break;
          }

          case 'SET_API_KEY': {
            await browser.storage.local.set({ groqApiKey: payload.apiKey });
            sendResponse({ success: true, data: { message: 'API key updated successfully' } });
            break;
          }

          case 'SUMMARIZE': {
            const auth = await getAuth();
            if (!auth.apiKey) {
              sendResponse({ success: false, error: 'No API key configured. Please set your Groq API key.' });
              break;
            }
            const summary = await summarizePage(payload.text, auth);
            sendResponse({ success: true, data: { result: summary } });
            break;
          }

          case 'EXPLAIN': {
            const auth = await getAuth();
            if (!auth.apiKey) {
              sendResponse({ success: false, error: 'No API key configured.' });
              break;
            }
            const explanation = await explainText(payload.text, auth);
            sendResponse({ success: true, data: { result: explanation } });
            break;
          }

          case 'CHAT': {
            const auth = await getAuth();
            if (!auth.apiKey) {
              sendResponse({ success: false, error: 'No API key configured.' });
              break;
            }
            const reply = await chatWithPage(payload.message, payload.pageContext || '', auth);
            sendResponse({ success: true, data: { result: reply } });
            break;
          }

          case 'AGENT_STEP': {
            const auth = await getAuth();
            if (!auth.apiKey) {
              sendResponse({ success: false, error: 'No API key configured.' });
              break;
            }
            const { goal, domSnapshot, actionHistory, stepCount } = payload;
            const rawResponse = await planAgentStep(goal, domSnapshot, actionHistory || [], auth);
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
                stepCount: (stepCount || 0) + 1,
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
