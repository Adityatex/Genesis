import { describe, it, expect, vi } from 'vitest';
import { riskOf, labelOf } from '@/lib/agent/confirm';
import { createDOMSnapshot, commitTarget } from '@/lib/agent/domSnapshot';

const click = { action: 'click' as const };

describe("which actions need the user's OK", () => {
  it('asks before buying, paying, sending, deleting, moving money, booking and applying', () => {
    const cases: [string, string][] = [
      ['<button> type="submit" "Place order"', 'a purchase'],
      ['<button> "Place your order"', 'a purchase'],
      ['<input> type="submit" "Buy now"', 'a purchase'],
      ['<a> "Complete purchase" href="https://shop.test/x"', 'a purchase'],
      ['<button> "Pay $42.00"', 'a payment'],
      ['<button> "Confirm and pay"', 'a payment'],
      ['<input> type="submit" "Submit payment"', 'a payment'],
      ['<button> "Send"', 'sending a message or post'],
      ['<div> role="button" "Post"', 'sending a message or post'],
      ['<button> "Comment"', 'sending a message or post'],
      ['<button> "Delete repository"', 'deleting something'],
      ['<button> "Yes, delete it"', 'deleting something'],
      ['<a> "Cancel subscription" href="https://x.test/account"', 'deleting something'],
      ['<button> "Close my account"', 'deleting something'],
      ['<button> "Transfer funds"', 'moving money'],
      ['<button> "Book now"', 'a booking'],
      ['<button> "Confirm reservation"', 'a booking'],
      ['<button> "Submit application"', 'submitting an application'],
    ];
    for (const [key, risk] of cases) expect(riskOf(click, key), key).toBe(risk);
  });

  it("doesn't ask for steps that can be undone, or that only look similar", () => {
    for (const key of [
      '<button> "Add to cart"',
      '<a> "Proceed to checkout" href="https://shop.test/checkout"',
      '<button> "Remove"', // from a cart: add it back
      '<button> "Search"',
      '<button> "Submit"', // contact forms, searches, logins: too common to ask every time
      '<button> "Next"',
      '<a> "Sent items" href="https://mail.test/sent"',
      '<a> "Posts" href="https://blog.test/posts"',
      '<a> "Buying guide" href="https://shop.test/guide"',
      '<a> "Book a demo" href="https://x.test/demo"',
      '<button> "Apply"', // a filter or a coupon
      '<button> "Cancel"', // closes a dialog
      '<button> "Reply"', // opens the composer; its Send button asks
    ]) expect(riskOf(click, key), key).toBeNull();
  });

  it('never asks about fields, checkboxes or menus that only pick something', () => {
    expect(riskOf(click, '<input> type="checkbox" "Delete my data after 30 days"')).toBeNull();
    expect(riskOf(click, '<input> type="text" "Send to"')).toBeNull();
    expect(riskOf(click, '<textarea> "Post"')).toBeNull();
    expect(riskOf(click, '<div> role="option" "Pay later"')).toBeNull();
    expect(riskOf(click, '<li> role="tab" "Send money"')).toBeNull();
  });

  it('only clicks and Enter can commit', () => {
    const key = '<button> type="submit" "Place order"';
    expect(riskOf({ action: 'press_key', key: 'Enter' }, key)).toBe('a purchase');
    expect(riskOf({ action: 'press_key' }, key)).toBe('a purchase'); // Enter is the default key
    expect(riskOf({ action: 'press_key', key: 'Tab' }, key)).toBeNull();
    expect(riskOf({ action: 'type' }, key)).toBeNull();
    expect(riskOf(click, undefined)).toBeNull();
  });

  it('reads the label, not the attributes after it', () => {
    expect(riskOf(click, '<a> "Read more" href="https://blog.test/post/delete-me"')).toBeNull();
    expect(riskOf(click, '<button> role="button" type="submit" "Pay now" (in frame "Checkout")')).toBe('a payment');
    expect(labelOf('<button> type="submit" "Place order" href="x"')).toBe('Place order');
  });
});

describe('what a click or Enter would set off (commitTarget)', () => {
  function page(html: string) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) },
    );
    document.body.innerHTML = html;
    const { elements } = createDOMSnapshot();
    return (label: string) => elements.find((e) => e.label === label)!.id;
  }

  it('a click: the element clicked', () => {
    const id = page('<button type="submit">Place order</button>');
    expect(commitTarget({ action: 'click', elementId: id('Place order') })).toBe('<button> type="submit" "Place order"');
  });

  it("Enter in a field: the button that submits the field's form", () => {
    const id = page(`
      <form><input name="card" aria-label="Card number"><button>Pay $42.00</button></form>
      <form><input name="q" aria-label="Search for"><button type="submit">Search</button></form>`);
    const pay = commitTarget({ action: 'press_key', elementId: id('Card number') });
    expect(riskOf({ action: 'press_key', key: 'Enter' }, pay)).toBe('a payment');
    const search = commitTarget({ action: 'press_key', elementId: id('Search for') });
    expect(riskOf({ action: 'press_key', key: 'Enter' }, search)).toBeNull();
  });

  it('Enter with nothing given: the focused element', () => {
    page('<form><input name="msg" aria-label="Message"><input type="submit" value="Send"></form>');
    (document.querySelector('input[name="msg"]') as HTMLInputElement).focus();
    expect(riskOf({ action: 'press_key' }, commitTarget({ action: 'press_key' }))).toBe('sending a message or post');
  });
});
