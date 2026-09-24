// lib/agent/domSnapshot.ts
// Creates a compact, LLM-friendly representation of the current page DOM

const INTERACTIVE_SELECTORS = [
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
];

const LANDMARK_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'NAV', 'MAIN', 'HEADER', 'FOOTER', 'FORM',
]);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE', 'IFRAME',
]);

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
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
  options?: string[];
  selector: string;
}

const MAX_SELECT_OPTIONS = 15;

/** Visible labels of a <select>'s options, so the model can pick a valid one. */
function getSelectOptions(el: Element): string[] | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;
  const labels = Array.from(el.options)
    .map(o => truncate(o.text, 40))
    .filter(Boolean);
  if (labels.length <= MAX_SELECT_OPTIONS) return labels;
  return [...labels.slice(0, MAX_SELECT_OPTIONS), `…+${labels.length - MAX_SELECT_OPTIONS} more`];
}

function buildUniqueSelector(el: Element, index: number): string {
  // Use data attribute we inject for reliable targeting
  return `[data-genesis-id="${index}"]`;
}

/**
 * Create a compact snapshot of the page for the LLM.
 * Tags each interactive element with a data-genesis-id for reliable targeting.
 * Returns a text representation + the element map.
 */
export function createDOMSnapshot(): { text: string; elements: SnapshotElement[] } {
  const elements: SnapshotElement[] = [];
  let idCounter = 0;

  // Clean up any previous genesis IDs
  document.querySelectorAll('[data-genesis-id]').forEach(el => {
    el.removeAttribute('data-genesis-id');
  });

  // Collect landmark text for page context
  const landmarks: string[] = [];
  document.querySelectorAll('h1, h2, h3, title').forEach(el => {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length > 0 && text.length < 200) {
      landmarks.push(`[${el.tagName}] ${truncate(text, 80)}`);
    }
  });

  // Collect interactive elements
  const seen = new Set<Element>();
  for (const selector of INTERACTIVE_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => {
      if (seen.has(el)) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (!isVisible(el)) return;

      // Skip elements inside our own shadow DOM
      if (el.closest('#genesis-sidebar-root') || el.closest('genesis-sidebar')) return;

      seen.add(el);
      const id = idCounter++;
      el.setAttribute('data-genesis-id', String(id));

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tag;
      const label = getLabel(el);
      const type = el.getAttribute('type') || undefined;
      const href = tag === 'a' ? (el as HTMLAnchorElement).href : undefined;
      const value = (el as HTMLInputElement).value || undefined;
      const placeholder = el.getAttribute('placeholder') || undefined;
      const checked = (el as HTMLInputElement).checked || undefined;
      const disabled = (el as HTMLInputElement).disabled || undefined;

      elements.push({
        id,
        tag,
        role,
        label,
        type,
        href: href ? truncate(href, 100) : undefined,
        value: value ? truncate(value, 50) : undefined,
        placeholder,
        checked,
        disabled,
        options: getSelectOptions(el),
        selector: buildUniqueSelector(el, id),
      });
    });
  }

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
  
  for (const el of elements) {
    let entry = `[${el.id}] <${el.tag}>`;
    if (el.type) entry += ` type="${el.type}"`;
    if (el.label) entry += ` "${el.label}"`;
    if (el.placeholder) entry += ` placeholder="${el.placeholder}"`;
    if (el.href) entry += ` href="${el.href}"`;
    if (el.value) entry += ` value="${el.value}"`;
    if (el.checked) entry += ` [checked]`;
    if (el.disabled) entry += ` [disabled]`;
    if (el.options) entry += ` options=[${el.options.map(o => JSON.stringify(o)).join(', ')}]`;
    lines.push(entry);
  }

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
