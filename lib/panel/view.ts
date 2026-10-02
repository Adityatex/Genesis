// lib/panel/view.ts
// What the side panel derives from a run (lib/agent/runner.ts RunView): the
// mark's state, the status pill, the plan as items, the kind of failure. Pure
// functions, so they're unit-tested apart from React.

import type { RunView } from '@/lib/agent/runner';
import type { TabiMarkState } from '@/components/TabiMark';

/** The mark follows the current tab's task. */
export function markState(run: RunView | null): TabiMarkState {
  if (!run) return 'idle';
  switch (run.status) {
    case 'running': return run.phase === 'reading' ? 'reading' : run.phase === 'thinking' ? 'thinking' : 'acting';
    case 'paused': return 'waiting';
    case 'done': return 'done';
    case 'error': return 'failed';
    case 'stopped': return run.outcome && /block list/.test(run.outcome) ? 'failed' : 'stopped';
    default: return 'idle';
  }
}

export type PillTone = 'running' | 'replay' | 'waiting' | 'done' | 'failed' | 'neutral';

/** The goal card's status pill. */
export function statusPill(run: RunView): { tone: PillTone; label: string } {
  switch (run.status) {
    case 'running':
      if (run.replay === 'replaying') return { tone: 'replay', label: 'Replaying · no AI calls' };
      if (run.replay === 'healed') return { tone: 'running', label: 'Healed · AI on' };
      return { tone: 'running', label: 'Running' };
    case 'paused': return { tone: 'waiting', label: run.asking ? 'Needs your OK' : 'Paused' };
    case 'done': return { tone: 'done', label: 'Done' };
    case 'error': return { tone: 'failed', label: 'Failed' };
    case 'queued': return { tone: 'neutral', label: 'Waiting' };
    default: return /block list/.test(run.outcome ?? '') ? { tone: 'failed', label: 'Blocked' } : { tone: 'neutral', label: run.outcome ? 'Stopped' : 'Stopped by you' };
  }
}

export interface PlanItem {
  text: string;
  state: 'done' | 'current' | 'todo';
  /** Looks like something that can't be undone, so the agent will ask first. */
  irreversible: boolean;
}

/** Plan items worded like a purchase, payment, message, deletion or booking. */
const IRREVERSIBLE = /\b(place|submit|confirm|complete) (the |my |your )?(order|purchase|payment|booking|application)\b|^(buy|pay|send|post|publish|delete|book|reserve|transfer)\b|\bpay for\b/i;

/**
 * "[x] Open the cart" / "[ ] Check out": the first unticked item is the
 * current one. A finished task's plan is all done, ticked or not.
 */
export function planItems(plan: string[], finished = false): PlanItem[] {
  let current = false;
  return plan.map((raw) => {
    const m = /^\[([ xX✓]?)\]\s*(.*)$/.exec(raw.trim());
    const ticked = finished || !!m?.[1].trim();
    const text = (m ? m[2] : raw).trim();
    let state: PlanItem['state'] = 'todo';
    if (ticked) state = 'done';
    else if (!current) {
      state = 'current';
      current = true;
    }
    return { text, state, irreversible: IRREVERSIBLE.test(text) };
  });
}

/** "1:42", "12:05", "1:02:09" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type FailureKind = 'bad_key' | 'rate_limit' | 'model' | 'setup' | 'page_load' | 'other';

/** What went wrong, from a failed run's error, to pick the card and its fix. */
export function failureKind(error: string | undefined): FailureKind {
  const e = error ?? '';
  if (/rejected the API key|invalid[_ ]api[_ ]key|\b401\b|\b403\b/i.test(e)) return 'bad_key';
  if (/rate limit|daily limit|\b429\b|quota/i.test(e)) return 'rate_limit';
  if (/doesn't offer the model|model_not_found/i.test(e)) return 'model';
  if (/No API key|Choose a .* model|Set the server URL/i.test(e)) return 'setup';
  if (/timed out|didn't load|could not read the page|not load/i.test(e)) return 'page_load';
  return 'other';
}

/** The host of a URL without www, or '' for pages Tabi can't work on. */
export function siteOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** Path, query and fragment, for the site row. */
export function pathOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '';
  }
}

/** "2m ago", "Yesterday", "Mon", "Sep 28" */
export function when(at: number, now = Date.now()): string {
  const ago = now - at;
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(now - 86_400_000).toDateString() === d.toDateString()) return 'Yesterday';
  if (ago < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
