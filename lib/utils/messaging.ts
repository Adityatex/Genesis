// lib/utils/messaging.ts
// Typed message passing helpers using WXT's browser namespace

export interface TabiMessage {
  action: string;
  payload?: any;
}

export interface TabiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Send a message to the background service worker
 */
export async function sendToBackground(action: string, payload?: any): Promise<TabiResponse> {
  try {
    const response = await browser.runtime.sendMessage({ action, payload });
    return response as TabiResponse;
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Failed to communicate with background',
    };
  }
}

/**
 * Send a message to the content script in a specific tab
 */
export async function sendToContentScript(tabId: number, action: string, payload?: any): Promise<TabiResponse> {
  try {
    const response = await browser.tabs.sendMessage(tabId, { action, payload });
    return response as TabiResponse;
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Failed to communicate with content script',
    };
  }
}
