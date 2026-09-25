// lib/agent/trustedInput.ts
// Trusted input through the Chrome DevTools Protocol (chrome.debugger).
// Background service worker only.
//
// Scripted DOM events carry isTrusted === false, and many sites ignore them:
// bot protection, keystroke-driven editors (Google Docs, code editors,
// terminals), some framework handlers. CDP Input.* events go through Chrome's
// real input pipeline, so pages see them exactly like a user's mouse and keyboard.
//
// While attached, Chrome shows a "started debugging this browser" banner, so
// we attach lazily on the first trusted action of an agent run and detach
// when the run ends.

import { keyParams } from '@/lib/agent/keys';

declare const chrome: any;

const PROTOCOL_VERSION = '1.3';
/** Above this length, type with one insertText call instead of per-key events. */
const MAX_KEYSTROKE_TEXT = 120;

const attached = new Set<number>();
/** Tabs where the user dismissed the debugging banner: don't re-attach this run. */
const declined = new Set<number>();

function target(tabId: number) {
  return { tabId };
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  if (declined.has(tabId)) throw new Error('Trusted input was cancelled for this tab');
  await chrome.debugger.attach(target(tabId), PROTOCOL_VERSION);
  attached.add(tabId);
}

function send(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand(target(tabId), method, params);
}

/** Left-click at (x, y) in the tab's top-level viewport (CSS pixels). */
export async function trustedClick(tabId: number, x: number, y: number): Promise<void> {
  await ensureAttached(tabId);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function keyStroke(tabId: number, rawKey: string): Promise<void> {
  const { key, code, keyCode, text } = keyParams(rawKey);
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  // keyDown with text also produces keypress + beforeinput/input, like a real key
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text ? { text, unmodifiedText: text } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/** Press one key (Enter, Tab, Escape, ArrowDown, "a", ...) on the focused element. */
export async function trustedKey(tabId: number, key: string): Promise<void> {
  await ensureAttached(tabId);
  await keyStroke(tabId, key);
}

/** Type text into the focused element as real keystrokes. */
export async function trustedType(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  if (text.length > MAX_KEYSTROKE_TEXT) {
    // Still trusted input events, just without a keydown per character
    await send(tabId, 'Input.insertText', { text });
    return;
  }
  for (const ch of text) await keyStroke(tabId, ch === '\n' ? 'Enter' : ch);
}

/** Detach at the end of an agent run so Chrome's debugging banner goes away. */
export async function releaseTab(tabId: number): Promise<void> {
  declined.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach(target(tabId));
  } catch { /* already gone */ }
}

/** Keep state in sync when Chrome detaches us (tab closed, user cancelled, DevTools). */
export function watchDetach(): void {
  chrome.debugger.onDetach.addListener((source: { tabId?: number }, reason: string) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    // The user clicked "Cancel" on the banner: respect it for the rest of this run
    if (reason === 'canceled_by_user') declined.add(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId: number) => {
    attached.delete(tabId);
    declined.delete(tabId);
  });
}
