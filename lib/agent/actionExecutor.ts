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

// Legacy keyCode values — many sites still check `e.keyCode === 13`
const KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ' ': 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};

function makeKeyEvent(type: 'keydown' | 'keypress' | 'keyup', key: string): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  // keyCode/which can't be set through the constructor
  Object.defineProperty(event, 'keyCode', { get: () => keyCode });
  Object.defineProperty(event, 'which', { get: () => keyCode });
  return event;
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
      
      // Press/release first (menus and custom widgets often listen for these),
      // then exactly ONE click — a second click would re-toggle checkboxes/menus.
      const pointerInit = { bubbles: true, cancelable: true, composed: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
      el.dispatchEvent(new MouseEvent('mousedown', pointerInit));
      el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', pointerInit));
      el.dispatchEvent(new MouseEvent('mouseup', pointerInit));
      el.click();

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
      
      // The model may pass either the option's value or its visible label
      const wanted = (action.value || '').trim().toLowerCase();
      const options = Array.from(el.options);
      const option =
        options.find(o => o.value.toLowerCase() === wanted) ||
        options.find(o => o.text.trim().toLowerCase() === wanted) ||
        options.find(o => wanted !== '' && o.text.trim().toLowerCase().includes(wanted));
      if (!option) {
        const available = options.slice(0, 15).map(o => `"${o.text.trim()}"`).join(', ');
        return `❌ No option matching "${action.value}" in dropdown [${action.elementId}]. Options: ${available}`;
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(200);
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return `✅ Selected "${option.text.trim()}" in dropdown [${action.elementId}]`;
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
      
      // If a page handler calls preventDefault() on keydown it has handled the key
      // itself (e.g. a JS-driven search box), so we must not also submit the form.
      const notHandled = target.dispatchEvent(makeKeyEvent('keydown', key));
      if (notHandled) target.dispatchEvent(makeKeyEvent('keypress', key));
      target.dispatchEvent(makeKeyEvent('keyup', key));

      // Synthetic key events have no default action, so emulate the browser's
      // implicit submission: Enter in a form <input> submits that form.
      // requestSubmit() fires a real submit event AND performs the submission;
      // dispatching a bare 'submit' Event does neither reliably.
      if (key === 'Enter' && notHandled && target instanceof HTMLInputElement && target.form) {
        target.form.requestSubmit();
        return `✅ Pressed "Enter" and submitted the form`;
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
