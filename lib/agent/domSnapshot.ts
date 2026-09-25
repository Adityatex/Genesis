// lib/agent/domSnapshot.ts
// Creates a compact, LLM-friendly representation of the current page DOM

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  // ARIA widgets: how design systems (MUI, Radix, React Select, ...) build
  // dropdowns, toggles and menus out of divs
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="option"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="treeitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[aria-haspopup]:not([aria-haspopup="false"])',
  // Other clickable things without a semantic role
  'summary',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Subtrees that never contain anything the agent can use
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE', 'HEAD',
]);

// Genesis's own sidebar is a shadow-root UI on the page; never show it to the agent
const OWN_UI_TAG = 'GENESIS-SIDEBAR';

// ---------------------------------------------------------------- element registry
// Maps snapshot IDs to live elements. A querySelector on a data attribute can't
// see into shadow roots or iframes, so the executor looks elements up here.

const registry = new Map<number, Element>();

export function getElementById(id: number): HTMLElement | null {
  const el = registry.get(id);
  if (el?.isConnected) return el as HTMLElement;
  // Fallback for elements tagged outside a snapshot (e.g. unit tests)
  return document.querySelector(`[data-genesis-id="${id}"]`) as HTMLElement | null;
}

// ---------------------------------------------------------------- traversal

/** Open shadow root, or a closed one via the extension-only chrome.dom API. */
function shadowRootOf(el: Element): ShadowRoot | null {
  const openOrClosed = (globalThis as any).chrome?.dom?.openOrClosedShadowRoot;
  if (typeof openOrClosed === 'function') {
    try {
      return openOrClosed(el) ?? null;
    } catch { /* not a shadow host */ }
  }
  return el.shadowRoot;
}

/** Same-origin iframe document; cross-origin frames throw or return null. */
function frameDocumentOf(el: Element): Document | null {
  if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

function frameLabel(frame: Element): string {
  return truncate(frame.getAttribute('title') || frame.getAttribute('name') || frame.getAttribute('src') || 'iframe', 40);
}

interface Found {
  el: Element;
  /** Label of the iframe the element lives in, if any. */
  frame?: string;
}

/**
 * Every interactive element in document order, including those inside
 * (open or extension-reachable closed) shadow roots and same-origin iframes.
 */
function collectInteractive(root: Document | ShadowRoot, frame: string | undefined, out: Found[]): void {
  // nodeType, not instanceof: an iframe's Document comes from another realm
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root.ownerDocument as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      SKIP_TAGS.has((node as Element).tagName) || (node as Element).tagName === OWN_UI_TAG
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (el.matches(INTERACTIVE_SELECTOR)) out.push({ el, frame });

    const shadow = shadowRootOf(el);
    if (shadow) collectInteractive(shadow, frame, out);

    const frameDoc = frameDocumentOf(el);
    if (frameDoc && isVisible(el)) collectInteractive(frameDoc, frameLabel(el), out);
  }
}

// ---------------------------------------------------------------- element details

function isVisible(el: Element): boolean {
  // No `instanceof HTMLElement`: iframe elements come from another realm
  if (typeof (el as HTMLElement).getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

function truncate(str: string, max: number): string {
  const clean = str.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.substring(0, max) + '…' : clean;
}

function getLabel(el: Element): string {
  // Try multiple strategies to get a human-readable label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return truncate(ariaLabel, 60);

  const title = el.getAttribute('title');
  if (title) return truncate(title, 60);

  const innerText = (el as HTMLElement).innerText;
  if (innerText && innerText.trim().length > 0 && innerText.trim().length < 80) {
    return truncate(innerText, 60);
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return truncate(placeholder, 60);

  const alt = el.getAttribute('alt');
  if (alt) return truncate(alt, 60);

  const name = el.getAttribute('name');
  if (name) return name;

  return '';
}

export interface SnapshotElement {
  id: number;
  tag: string;
  role: string;
  label: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  /** ARIA state, e.g. expanded / collapsed / selected / popup=listbox */
  states?: string[];
  options?: string[];
  /** Label of the iframe the element is in, if any. */
  frame?: string;
  selector: string;
}

const MAX_SELECT_OPTIONS = 15;

/** Visible labels of a <select>'s options, so the model can pick a valid one. */
function getSelectOptions(el: Element): string[] | undefined {
  if (el.tagName !== 'SELECT') return undefined;
  const labels = Array.from((el as HTMLSelectElement).options)
    .map(o => truncate(o.text, 40))
    .filter(Boolean);
  if (labels.length <= MAX_SELECT_OPTIONS) return labels;
  return [...labels.slice(0, MAX_SELECT_OPTIONS), `…+${labels.length - MAX_SELECT_OPTIONS} more`];
}

/** ARIA state worth showing: lets the model tell an open dropdown from a closed one. */
function getAriaStates(el: Element): string[] | undefined {
  const states: string[] = [];
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  if (expanded === 'false') states.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') states.push('checked');
  if (checked === 'mixed') states.push('partially checked');
  if (el.getAttribute('aria-pressed') === 'true') states.push('pressed');
  if (el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  const popup = el.getAttribute('aria-haspopup');
  if (popup && popup !== 'false') states.push(`popup=${popup === 'true' ? 'menu' : popup}`);
  return states.length ? states : undefined;
}

function describe(el: Element, id: number, frame: string | undefined): SnapshotElement {
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  // Editors have no .value; show their text so the model can see what's typed
  const value = ((el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : input.value) || undefined;
  const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;

  return {
    id,
    tag,
    role: el.getAttribute('role') || tag,
    label: getLabel(el),
    type: el.getAttribute('type') || undefined,
    href: href ? truncate(href, 100) : undefined,
    value: value ? truncate(value, 50) : undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    checked: input.checked || undefined,
    disabled: input.disabled || undefined,
    states: getAriaStates(el),
    options: getSelectOptions(el),
    frame,
    selector: `[data-genesis-id="${id}"]`,
  };
}

export function formatElement(el: SnapshotElement): string {
  let entry = `[${el.id}] <${el.tag}>`;
  if (el.role !== el.tag) entry += ` role="${el.role}"`;
  if (el.type) entry += ` type="${el.type}"`;
  if (el.label) entry += ` "${el.label}"`;
  if (el.placeholder) entry += ` placeholder="${el.placeholder}"`;
  if (el.href) entry += ` href="${el.href}"`;
  if (el.value) entry += ` value="${el.value}"`;
  if (el.checked) entry += ` [checked]`;
  if (el.disabled) entry += ` [disabled]`;
  if (el.states) entry += ` [${el.states.join(', ')}]`;
  if (el.options) entry += ` options=[${el.options.map(o => JSON.stringify(o)).join(', ')}]`;
  if (el.frame) entry += ` (in frame "${el.frame}")`;
  return entry;
}

// ---------------------------------------------------------------- snapshot

/**
 * Create a compact snapshot of the page for the LLM.
 * Registers each interactive element under a numeric ID (and tags it with
 * data-genesis-id for debugging). Returns a text representation + the elements.
 */
export function createDOMSnapshot(): { text: string; elements: SnapshotElement[] } {
  // Clean up the previous snapshot's IDs, wherever those elements live
  for (const el of registry.values()) el.removeAttribute('data-genesis-id');
  registry.clear();

  const found: Found[] = [];
  collectInteractive(document, undefined, found);

  const elements: SnapshotElement[] = [];
  for (const { el, frame } of found) {
    if (!isVisible(el)) continue;
    const id = elements.length;
    registry.set(id, el);
    el.setAttribute('data-genesis-id', String(id));
    elements.push(describe(el, id, frame));
  }

  // Collect landmark text for page context
  const landmarks: string[] = [];
  document.querySelectorAll('h1, h2, h3, title').forEach(el => {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length > 0 && text.length < 200) {
      landmarks.push(`[${el.tagName}] ${truncate(text, 80)}`);
    }
  });

  // Build text representation
  const lines: string[] = [];
  lines.push(`PAGE: ${document.title}`);
  lines.push(`URL: ${window.location.href}`);

  if (landmarks.length > 0) {
    lines.push('');
    lines.push('--- PAGE STRUCTURE ---');
    landmarks.slice(0, 10).forEach(l => lines.push(l));
  }

  lines.push('');
  lines.push(`--- INTERACTIVE ELEMENTS (${elements.length}) ---`);
  for (const el of elements) lines.push(formatElement(el));

  // Add visible body text snippet for context
  const bodyText = document.body.innerText || '';
  const textSnippet = truncate(bodyText, 2000);
  if (textSnippet.length > 50) {
    lines.push('');
    lines.push('--- VISIBLE TEXT (excerpt) ---');
    lines.push(textSnippet);
  }

  return { text: lines.join('\n'), elements };
}
