// lib/utils/messaging.ts
// Typed message passing helpers using WXT's browser namespace

export interface GenesisMessage {
  action: string;
  payload?: any;
}

export interface GenesisResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Send a message to the background service worker
 */
export async function sendToBackground(action: string, payload?: any): Promise<GenesisResponse> {
  try {
    const response = await browser.runtime.sendMessage({ action, payload });
    return response as GenesisResponse;
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
export async function sendToContentScript(tabId: number, action: string, payload?: any): Promise<GenesisResponse> {
  try {
    const response = await browser.tabs.sendMessage(tabId, { action, payload });
    return response as GenesisResponse;
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Failed to communicate with content script',
    };
  }
}
