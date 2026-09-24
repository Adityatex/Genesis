// lib/agent/actionExecutor.ts
// Executes structured actions on the DOM returned by the LLM agent

export interface AgentAction {
  action: 'click' | 'type' | 'clear_and_type' | 'select' | 'navigate' | 'scroll' | 'read' | 'wait' | 'done' | 'press_key';
  elementId?: number;
  text?: string;
  url?: string;
  direction?: 'up' | 'down';
  key?: string;
  summary?: string;
  value?: string;
  // Internal: session data to save before navigation
  _session?: { goal: string; actionHistory: string[]; stepCount: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getElementByGenesisId(id: number): HTMLElement | null {
  return document.querySelector(`[data-genesis-id="${id}"]`) as HTMLElement | null;
}

function simulateInput(el: HTMLElement, value: string): void {
  // Use native input setter to trigger React/Angular/Vue change detection
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (el instanceof HTMLInputElement && nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(el, value);
  } else {
    (el as any).value = value;
  }

  // Fire events that frameworks listen to
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

/**
 * Execute a single agent action on the current page DOM.
 * Returns a human-readable description of what happened.
 */
export async function executeAction(action: AgentAction): Promise<string> {
  switch (action.action) {
    case 'click': {
      if (action.elementId === undefined) return '❌ No element ID provided for click.';
      const el = getElementByGenesisId(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found on page.`;
      
      // Scroll into view first
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      
      // Focus + click
      el.focus();
      el.click();
      
      // For links, also try dispatching mousedown/mouseup
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      
      const label = el.innerText?.trim().substring(0, 40) || el.getAttribute('aria-label') || `element ${action.elementId}`;
      return `✅ Clicked "${label}"`;
    }

    case 'type': {
      if (action.elementId === undefined) return '❌ No element ID provided for type.';
      const el = getElementByGenesisId(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found.`;
      
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
      el.focus();
      
      // Append text
      const current = (el as HTMLInputElement).value || '';
      simulateInput(el, current + (action.text || ''));
      
      return `✅ Typed "${action.text?.substring(0, 40)}" into element [${action.elementId}]`;
    }

    case 'clear_and_type': {
      if (action.elementId === undefined) return '❌ No element ID provided for type.';
      const el = getElementByGenesisId(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found.`;
      
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
      el.focus();
      
      // Clear then type
      simulateInput(el, action.text || '');
      
      return `✅ Cleared and typed "${action.text?.substring(0, 40)}" into element [${action.elementId}]`;
    }

    case 'select': {
      if (action.elementId === undefined) return '❌ No element ID provided for select.';
      const el = getElementByGenesisId(action.elementId) as HTMLSelectElement | null;
      if (!el || el.tagName !== 'SELECT') return `❌ Element [${action.elementId}] is not a select dropdown.`;
      
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
      el.value = action.value || '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      
      return `✅ Selected "${action.value}" in dropdown [${action.elementId}]`;
    }

    case 'navigate': {
      if (!action.url) return '❌ No URL provided for navigation.';
      try {
        await browser.runtime.sendMessage({
          action: 'NAVIGATE_TAB',
          payload: { url: action.url, session: action._session || null },
        });
      } catch {
        // Fallback — will lose session but at least navigate
        window.location.href = action.url;
      }
      return `🔄 NAVIGATING to ${action.url}`;
    }

    case 'scroll': {
      const amount = action.direction === 'up' ? -400 : 400;
      window.scrollBy({ top: amount, behavior: 'smooth' });
      return `✅ Scrolled ${action.direction || 'down'}`;
    }

    case 'read': {
      if (action.elementId === undefined) {
        // Read whole page
        const text = document.body.innerText?.substring(0, 2000) || '';
        return `📖 Page text: ${text.substring(0, 500)}...`;
      }
      const el = getElementByGenesisId(action.elementId);
      if (!el) return `❌ Element [${action.elementId}] not found.`;
      return `📖 Content of [${action.elementId}]: "${el.innerText?.substring(0, 500) || ''}"`;
    }

    case 'press_key': {
      const key = action.key || 'Enter';
      const target = action.elementId !== undefined
        ? getElementByGenesisId(action.elementId) || document.activeElement || document.body
        : document.activeElement || document.body;
      
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      
      // Special handling for Enter on forms
      if (key === 'Enter' && target instanceof HTMLElement) {
        const form = target.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true }));
        }
      }
      
      return `✅ Pressed "${key}"`;
    }

    case 'wait': {
      const ms = parseInt(action.text || '1000', 10) || 1000;
      const waitTime = Math.min(ms, 5000); // Cap at 5s
      await sleep(waitTime);
      return `⏳ Waited ${waitTime}ms`;
    }

    case 'done': {
      return `✅ Task complete: ${action.summary || 'Done'}`;
    }

    default:
      return `❌ Unknown action: ${(action as any).action}`;
  }
}
