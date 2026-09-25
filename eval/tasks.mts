// eval/tasks.mts
// Benchmark tasks. Each task is graded by `check` against what the fixture
// server recorded (or, for extraction tasks, the agent's final summary).
//
// `mockPlan` is a scripted planner used by `--mock` runs: each step's `target`
// regex is matched against the DOM snapshot line the real model would see
// (e.g. `[3] <button> type="submit" "Search"`), so mock runs exercise the real
// snapshot + executor + navigation-resume code in a real browser, just without
// an LLM. When the target isn't in the snapshot, the mock gives up — which is
// exactly how a model fails when an element is invisible to it.
//
// `knownIssue` marks tasks the current agent is expected to FAIL in mock mode.
// CI fails if one of them starts passing, so remove the flag when you fix it.

import type { RecordedEvent } from './server.mts';

export type MockStep =
  | { action: 'click'; target: RegExp }
  | { action: 'type' | 'clear_and_type'; target: RegExp; text: string }
  | { action: 'select'; target: RegExp; value: string }
  | { action: 'press_key'; key: string; target?: RegExp }
  | { action: 'done'; summary: string };

export interface GradeInput {
  events: RecordedEvent[];
  summary: string;
  finalUrl: string;
}

export interface Task {
  id: string;
  category: 'forms' | 'navigation' | 'js-app' | 'extraction' | 'hard';
  start: string;
  goal: string;
  check: (r: GradeInput) => boolean;
  mockPlan: MockStep[];
  knownIssue?: string;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** True if the server recorded a request to `path` whose data satisfies `pred`. */
function hit(events: RecordedEvent[], path: string, pred: (d: Record<string, unknown>) => boolean = () => true) {
  return events.some(e => e.path === path && pred(e.data));
}

export const TASKS: Task[] = [
  {
    id: 'search-button',
    category: 'forms',
    start: '/search.html',
    goal: 'Search for wireless headphones',
    check: r => hit(r.events, '/api/search', d => norm(d.q).includes('wireless headphones')),
    mockPlan: [
      { action: 'type', target: /"Search products"/, text: 'wireless headphones' },
      { action: 'click', target: /<button>.*"Search"/ },
    ],
  },
  {
    id: 'search-enter',
    category: 'forms',
    start: '/search.html',
    goal: 'Search for mechanical keyboard and press Enter to submit',
    check: r => hit(r.events, '/api/search', d => norm(d.q).includes('mechanical keyboard')),
    mockPlan: [
      { action: 'clear_and_type', target: /"Search products"/, text: 'mechanical keyboard' },
      { action: 'press_key', key: 'Enter', target: /"Search products"/ },
    ],
  },
  {
    id: 'signup-checkbox',
    category: 'forms',
    start: '/signup.html',
    goal: 'Sign up with the name Ada Lovelace and email ada@example.com, and accept the terms',
    check: r => hit(r.events, '/api/signup', d =>
      norm(d.name) === 'ada lovelace' && norm(d.email) === 'ada@example.com' && d.terms === 'on'),
    mockPlan: [
      { action: 'type', target: /type="text" "name"/, text: 'Ada Lovelace' },
      { action: 'type', target: /type="email"/, text: 'ada@example.com' },
      { action: 'click', target: /type="checkbox"/ },
      { action: 'click', target: /"Create account"/ },
    ],
  },
  {
    id: 'shipping-dropdowns',
    category: 'forms',
    start: '/shipping.html',
    goal: 'Select India as the country and Express shipping, then submit the form',
    check: r => hit(r.events, '/api/shipping', d => d.country === 'IN' && d.speed === 'express'),
    mockPlan: [
      { action: 'select', target: /<select> "Country"/, value: 'India' },
      { action: 'select', target: /<select> "Shipping speed"/, value: 'Express' },
      { action: 'click', target: /"Continue to payment"/ },
    ],
  },
  {
    id: 'login',
    category: 'forms',
    start: '/login.html',
    goal: 'Log in with username demo and password hunter2',
    check: r => hit(r.events, '/api/login', d => d.username === 'demo' && d.password === 'hunter2'),
    mockPlan: [
      { action: 'type', target: /"Username"/, text: 'demo' },
      { action: 'type', target: /type="password"/, text: 'hunter2' },
      { action: 'click', target: /<button>.*"Sign in"/ },
    ],
  },
  {
    id: 'feedback-radio',
    category: 'forms',
    start: '/feedback.html',
    goal: 'Fill the feedback form with a rating of 4 and the comment Fast delivery, then submit it',
    check: r => hit(r.events, '/api/feedback', d => d.rating === '4' && norm(d.comment).includes('fast delivery')),
    mockPlan: [
      { action: 'click', target: /type="radio".*value="4"/ },
      { action: 'type', target: /<textarea>/, text: 'Fast delivery' },
      { action: 'click', target: /"Send feedback"/ },
    ],
  },
  {
    id: 'slow-submit',
    category: 'navigation',
    start: '/slow-form.html',
    goal: 'Fill in 4 guests and submit the booking',
    // Exactly one booking: planning again from the page that is still waiting on
    // the server would act on a stale page (and used to double-submit)
    check: r => r.events.filter(e => e.path === '/api/slow/booking').length === 1
      && hit(r.events, '/api/slow/booking', d => d.guests === '4'),
    mockPlan: [
      { action: 'type', target: /"Number of guests"/, text: '4' },
      { action: 'click', target: /"Book now"/ },
    ],
  },
  {
    id: 'store-add-to-cart',
    category: 'navigation',
    start: '/store/index.html',
    goal: 'Go to the products page, open the Blue Mug and add it to the cart',
    check: r => hit(r.events, '/api/cart', d => d.item === 'blue-mug'),
    mockPlan: [
      { action: 'click', target: /<a> "Products"/ },
      { action: 'click', target: /<a> "Blue Mug"/ },
      { action: 'click', target: /"Add to cart"/ },
    ],
  },
  {
    id: 'todo-enter',
    category: 'js-app',
    start: '/todo.html',
    goal: 'Type buy milk into the todo input and press Enter',
    check: r => hit(r.events, '/api/todo', d => norm(d.text) === 'buy milk'),
    mockPlan: [
      { action: 'type', target: /"New todo"/, text: 'buy milk' },
      { action: 'press_key', key: 'Enter', target: /"New todo"/ },
    ],
  },
  {
    id: 'order-status',
    category: 'extraction',
    start: '/orders.html',
    goal: 'Find the status of order #1042',
    check: r => /\bshipped\b/i.test(r.summary),
    mockPlan: [{ action: 'done', summary: 'Order #1042 is Shipped.' }],
  },

  // ---- Hard cases: each targets a known limitation of the current agent ----
  {
    id: 'long-page-link',
    category: 'hard',
    start: '/long-page.html',
    goal: 'Open the Account settings page',
    check: r => hit(r.events, '/api/visit', d => d.page === 'settings'),
    mockPlan: [{ action: 'click', target: /<a> "Account settings"/ }],
    knownIssue: 'Snapshot is cut at 6000 chars; the link is the 161st element',
  },
  {
    id: 'custom-dropdown',
    category: 'hard',
    start: '/custom-dropdown.html',
    goal: 'Select the Pro plan and click Continue',
    check: r => hit(r.events, '/api/plan', d => d.plan === 'pro'),
    mockPlan: [
      { action: 'click', target: /"Plan"/ },
      { action: 'click', target: /"Pro"/ },
      { action: 'click', target: /"Continue"/ },
    ],
    knownIssue: 'Non-native widgets (aria-haspopup div, role=option) are not in the snapshot',
  },
  {
    id: 'iframe-payment',
    category: 'hard',
    start: '/iframe-payment.html',
    goal: 'Fill in the cardholder name Ada Lovelace in the payment form and submit it',
    check: r => hit(r.events, '/api/pay', d => norm(d.cardholder) === 'ada lovelace'),
    mockPlan: [
      { action: 'type', target: /"Cardholder name"/, text: 'Ada Lovelace' },
      { action: 'click', target: /"Pay \$42\.00"/ },
    ],
  },
  {
    id: 'iframe-cross-origin',
    category: 'hard',
    start: '/iframe-cross-origin.html',
    goal: 'Fill in the cardholder name Ada Lovelace in the payment form and submit it',
    check: r => hit(r.events, '/api/pay', d => norm(d.cardholder) === 'ada lovelace'),
    mockPlan: [
      { action: 'type', target: /"Cardholder name"/, text: 'Ada Lovelace' },
      { action: 'click', target: /"Pay $42.00"/ },
    ],
    knownIssue: 'Cross-origin iframes (e.g. Stripe) are unreachable from the top frame; needs a content script in every frame',
  },
  {
    id: 'shadow-dom-button',
    category: 'hard',
    start: '/shadow-dom.html',
    goal: 'Subscribe to the newsletter',
    check: r => hit(r.events, '/api/subscribe'),
    mockPlan: [{ action: 'click', target: /"Subscribe"/ }],
  },
  {
    id: 'shadow-dom-closed',
    category: 'hard',
    start: '/shadow-dom-closed.html',
    goal: 'Click Reject all on the cookie banner',
    check: r => hit(r.events, '/api/consent', d => d.choice === 'Reject all'),
    mockPlan: [{ action: 'click', target: /"Reject all"/ }],
  },
  {
    id: 'contenteditable-message',
    category: 'hard',
    start: '/editor.html',
    goal: 'Type Hello team in the message box and click Send',
    check: r => hit(r.events, '/api/message', d => norm(d.text).includes('hello team')),
    mockPlan: [
      { action: 'type', target: /"Message #general"/, text: 'Hello team' },
      { action: 'click', target: /<button> "Send"/ },
    ],
  },
];
