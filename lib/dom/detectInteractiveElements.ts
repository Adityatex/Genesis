// lib/dom/detectInteractiveElements.ts
// Stage 3 — Smart interactive element detection engine

export interface InputElement {
  type: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  value: string;
}

export interface TextareaElement {
  name: string;
  id: string;
  placeholder: string;
  label: string;
  value: string;
}

export interface ButtonElement {
  text: string;
  id: string;
  type: string;
  className: string;
}

export interface DropdownElement {
  name: string;
  id: string;
  options: { value: string; text: string }[];
  selectedValue: string;
}

export interface RadioElement {
  name: string;
  id: string;
  value: string;
  label: string;
  checked: boolean;
}

export interface CheckboxElement {
  name: string;
  id: string;
  value: string;
  label: string;
  checked: boolean;
}

export interface InteractiveElements {
  inputs: InputElement[];
  textareas: TextareaElement[];
  buttons: ButtonElement[];
  dropdowns: DropdownElement[];
  radios: RadioElement[];
  checkboxes: CheckboxElement[];
  summary: string;
}

/**
 * Find the associated label text for a form element
 */
function getLabelText(el: HTMLElement): string {
  // Check for aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  // Check for aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() || '';
  }

  // Check for <label for="id">
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) return label.textContent?.trim() || '';
  }

  // Check for parent <label>
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    // Remove the input itself from the clone to get just the label text
    const inputInClone = clone.querySelector('input, select, textarea');
    if (inputInClone) inputInClone.remove();
    return clone.textContent?.trim() || '';
  }

  return '';
}

/**
 * Detect all interactive elements on the page.
 * Returns structured data about inputs, textareas, buttons, dropdowns, radios, and checkboxes.
 */
export function detectInteractiveElements(): InteractiveElements {
  const inputs: InputElement[] = [];
  const textareas: TextareaElement[] = [];
  const buttons: ButtonElement[] = [];
  const dropdowns: DropdownElement[] = [];
  const radios: RadioElement[] = [];
  const checkboxes: CheckboxElement[] = [];

  // Text inputs (excluding radio, checkbox, hidden, submit)
  const inputEls = document.querySelectorAll<HTMLInputElement>(
    'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'
  );
  inputEls.forEach((el) => {
    inputs.push({
      type: el.type || 'text',
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      label: getLabelText(el),
      value: el.value || '',
    });
  });

  // Textareas
  const textareaEls = document.querySelectorAll<HTMLTextAreaElement>('textarea');
  textareaEls.forEach((el) => {
    textareas.push({
      name: el.name || '',
      id: el.id || '',
      placeholder: el.placeholder || '',
      label: getLabelText(el),
      value: el.value || '',
    });
  });

  // Buttons
  const buttonEls = document.querySelectorAll<HTMLElement>(
    'button, input[type="submit"], input[type="button"], [role="button"]'
  );
  buttonEls.forEach((el) => {
    buttons.push({
      text: el.textContent?.trim() || (el as HTMLInputElement).value || '',
      id: el.id || '',
      type: el.getAttribute('type') || 'button',
      className: el.className || '',
    });
  });

  // Dropdowns / Selects
  const selectEls = document.querySelectorAll<HTMLSelectElement>('select');
  selectEls.forEach((el) => {
    const options = Array.from(el.options).map((opt) => ({
      value: opt.value,
      text: opt.textContent?.trim() || '',
    }));
    dropdowns.push({
      name: el.name || '',
      id: el.id || '',
      options,
      selectedValue: el.value || '',
    });
  });

  // Radio buttons
  const radioEls = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  radioEls.forEach((el) => {
    radios.push({
      name: el.name || '',
      id: el.id || '',
      value: el.value || '',
      label: getLabelText(el),
      checked: el.checked,
    });
  });

  // Checkboxes
  const checkboxEls = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  checkboxEls.forEach((el) => {
    checkboxes.push({
      name: el.name || '',
      id: el.id || '',
      value: el.value || '',
      label: getLabelText(el),
      checked: el.checked,
    });
  });

  const summary = `Found ${inputs.length} input(s), ${textareas.length} textarea(s), ${buttons.length} button(s), ${dropdowns.length} dropdown(s), ${radios.length} radio(s), ${checkboxes.length} checkbox(es)`;

  return { inputs, textareas, buttons, dropdowns, radios, checkboxes, summary };
}
