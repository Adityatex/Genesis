// lib/agent/runner.ts
// The agent loop, run by the background service worker.
//
// It used to run in the page, which dies on every navigation: the loop saved
// a session, the next page waited ~3.5s and resumed it, and two race bugs came
// from that hand-off. Here the loop outlives page loads. The page's content
// script is only eyes and hands (AGENT_SNAPSHOT / AGENT_EXECUTE), and the
// sidebar just displays the state pushed to it (AGENT_UPDATE).
//
// Chrome specifics are injected (RunnerDeps) so the loop can be unit-tested.

import type { AgentAction } from '@/lib/agent/actionExecutor';
import { parseAgentAction } from '@/lib/agent/parseAction';
import { MAX_AGENT_STEPS, MAX_INVALID_RESPONSES, describeAction, formatHistory } from '@/lib/agent/history';

export type RunStatus = 'running' | 'done' | 'max-steps' | 'error' | 'stopped';

/** What the sidebar shows; pushed on every change and fetched on page load. */
export interface RunView {
  goal: string;
  status: RunStatus;
  /** Markdown; final messages start with "Task Complete", "Max Steps Reached" or "Agent Error". */
  message: string;
  loading: boolean;
  step: number;
  /** Last change (ms since epoch): a newly loaded page shows recent results only. */
  updatedAt: number;
}

export interface TabInfo {
  status?: string;
  url?: string;
  title?: string;
}

export interface RunnerDeps {
  /** Ask the model for the next action; returns its raw output. */
  plan(goal: string, snapshot: string, history: string[]): Promise<string>;
  /** Message the tab's top-frame content script. Rejects if nothing answers (e.g. mid-navigation). */
  send(tabId: number, message: unknown, timeoutMs: number): Promise<any>;
  getTab(tabId: number): Promise<TabInfo>;
  navigate(tabId: number, url: string): Promise<void>;
  /** Called once when a run ends, however it ends (e.g. to release the debugger). */
  onRunEnded(tabId: number): Promise<void> | void;
  sleep(ms: number): Promise<void>;
}

interface Run extends RunView {
  tabId: number;
  history: string[];
  stopRequested: boolean;
  /** Page loads seen in this tab since the run started (see notifyTabLoading). */
  loads: number;
  /** Text excerpts of pages already seen, by URL (automatic memory). */
  visited: Map<string, string>;
}

/** Automatic memory: how many earlier pages, and how much of each, the model sees. */
const MEMORY_PAGES = 8;
const MEMORY_CHARS_PER_PAGE = 400;

/**
 * The visible-text part of a snapshot, shortened. Models often leave a page
 * without noting what they need from it (comparing products, adding up
 * figures across pages), so the runner keeps these excerpts for them.
 */
export function pageExcerpt(snapshotText: string): string {
  const text = snapshotText.split('--- VISIBLE TEXT (excerpt) ---')[1] ?? '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MEMORY_CHARS_PER_PAGE ? `${clean.slice(0, MEMORY_CHARS_PER_PAGE)}…` : clean;
}

/** "Pages you visited earlier" section for the prompt, leaving out the current page. */
export function memorySection(visited: Map<string, string>, currentUrl: string | undefined): string {
  const entries = [...visited].filter(([url]) => url !== currentUrl).slice(-MEMORY_PAGES);
  if (entries.length === 0) return '';
  const lines = entries.map(([url, excerpt]) => `- ${url}: ${excerpt}`);
  return `\n\n--- PAGES YOU VISITED EARLIER (what they said; they are not on screen now) ---\n${lines.join('\n')}`;
}

/** After an action, time for a click-triggered navigation to start. */
const SETTLE_MS = 700;
const READY_TIMEOUT_MS = 20_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const EXECUTE_TIMEOUT_MS = 60_000;

const runs = new Map<number, Run>();

function view(run: Run): RunView {
  const { goal, status, message, loading, step, updatedAt } = run;
  return { goal, status, message, loading, step, updatedAt };
}

export function getRunView(tabId: number): RunView | null {
  const run = runs.get(tabId);
  return run ? view(run) : null;
}

export function isRunning(tabId: number): boolean {
  return runs.get(tabId)?.status === 'running';
}

/** Feed from chrome.tabs.onUpdated (status "loading"): tells the loop the page changed. */
export function notifyTabLoading(tabId: number): void {
  const run = runs.get(tabId);
  if (run) run.loads++;
}

/** Ask a running agent to stop after its current step. */
export function stopRun(tabId: number): void {
  const run = runs.get(tabId);
  if (run?.status === 'running') run.stopRequested = true;
}

/** Forget a tab's run (tab closed, or the user cleared the chat). */
export function forgetRun(tabId: number): void {
  stopRun(tabId);
  if (runs.get(tabId)?.status !== 'running') runs.delete(tabId);
}

function publish(deps: RunnerDeps, run: Run, message: string, loading: boolean): void {
  run.message = message;
  run.loading = loading;
  run.updatedAt = Date.now();
  // The page may be mid-navigation; the next page asks for the state when it loads
  deps.send(run.tabId, { action: 'AGENT_UPDATE', payload: view(run) }, 2_000).catch(() => {});
}

/** Wait until the tab has finished loading and its content script answers. */
async function waitForPage(deps: RunnerDeps, tabId: number): Promise<TabInfo> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await deps.getTab(tabId);
    if (tab.status === 'complete') {
      try {
        await deps.send(tabId, { action: 'AGENT_PING' }, 1_000);
        return tab;
      } catch { /* content script not up yet */ }
    }
    await deps.sleep(250);
  }
  throw new Error('The page did not finish loading within 20 seconds');
}

function progressMessage(run: Run, footer: string): string {
  return `**Agent Progress** (step ${run.step}/${MAX_AGENT_STEPS})\n\n${formatHistory(run.history)}\n\n${footer}`;
}

async function loop(deps: RunnerDeps, run: Run): Promise<void> {
  const { tabId } = run;
  let invalidStreak = 0;

  while (run.step < MAX_AGENT_STEPS && !run.stopRequested) {
    run.step++;
    publish(deps, run, run.history.length ? progressMessage(run, `*Step ${run.step}: scanning the page...*`) : `🔍 **Step ${run.step}**: scanning the page...`, true);

    const page = await waitForPage(deps, tabId);
    const snapshot = await deps.send(tabId, { action: 'AGENT_SNAPSHOT' }, SNAPSHOT_TIMEOUT_MS);
    if (run.stopRequested) break;
    const snapshotText = String(snapshot?.text ?? '');

    publish(deps, run, run.history.length ? progressMessage(run, `*Step ${run.step}: planning...*`) : `🧠 **Step ${run.step}**: planning...`, true);
    const raw = await deps.plan(run.goal, snapshotText + memorySection(run.visited, page.url), run.history);
    if (page.url) {
      // Re-insert so the most recently seen pages come last
      run.visited.delete(page.url);
      run.visited.set(page.url, pageExcerpt(snapshotText));
    }
    if (run.stopRequested) break;

    const parsed = parseAgentAction(raw);
    if (!parsed.ok) {
      // Feed the error back through history so the model can correct itself
      invalidStreak++;
      run.history.push(`(invalid response) → ❌ ${parsed.error}. Respond with ONE valid JSON action.`);
      if (invalidStreak >= MAX_INVALID_RESPONSES) {
        throw new Error(`Model returned ${invalidStreak} invalid actions in a row. Last error: ${parsed.error}`);
      }
      continue;
    }
    invalidStreak = 0;
    const action: AgentAction = parsed.action;

    if (action.action === 'done') {
      run.status = 'done';
      publish(deps, run, `## ✅ Task Complete\n\n${action.summary || 'Done'}\n\n---\n**Steps taken:**\n${formatHistory(run.history)}`, false);
      return;
    }

    const desc = describeAction(action);
    publish(deps, run, progressMessage(run, `*Step ${run.step}: ${desc}*`), true);

    if (action.action === 'navigate') {
      await deps.navigate(tabId, action.url!);
      await deps.sleep(SETTLE_MS);
      const tab = await waitForPage(deps, tabId);
      run.history.push(`${desc} → ✅ now on "${tab.title || 'untitled page'}" (${tab.url})`);
      continue;
    }

    // Run it in the page. If the action navigates (link click, form submit),
    // the page may unload before it answers; that's expected, not an error.
    const loadsBefore = run.loads;
    const urlBefore = (await deps.getTab(tabId)).url;
    let result: string;
    try {
      result = String(await deps.send(tabId, { action: 'AGENT_EXECUTE', payload: action }, EXECUTE_TIMEOUT_MS));
    } catch {
      result = '✅ Done (the page changed before it could report back)';
    }

    await deps.sleep(SETTLE_MS);
    const now = await deps.getTab(tabId);
    if (run.loads > loadsBefore || now.status === 'loading' || now.url !== urlBefore) {
      const tab = await waitForPage(deps, tabId);
      result += `; page changed, now on "${tab.title || 'untitled page'}" (${tab.url})`;
    }
    run.history.push(`${desc} → ${result}`);
  }

  if (run.stopRequested) {
    run.status = 'stopped';
    publish(deps, run, `## ⏹️ Stopped\n\n**Steps taken:**\n${formatHistory(run.history) || 'None'}`, false);
    return;
  }
  run.status = 'max-steps';
  publish(deps, run, `## ⚠️ Max Steps Reached\n\nCompleted ${MAX_AGENT_STEPS} steps without finishing.\n\n**Steps taken:**\n${formatHistory(run.history)}`, false);
}

/**
 * Start an agent run in a tab and resolve when it ends. One run per tab: a new
 * one stops the old one first.
 */
export async function startRun(deps: RunnerDeps, tabId: number, goal: string): Promise<RunView> {
  const previous = runs.get(tabId);
  if (previous?.status === 'running') previous.stopRequested = true;

  const run: Run = { tabId, goal, status: 'running', message: '', loading: true, step: 0, updatedAt: Date.now(), history: [], stopRequested: false, loads: 0, visited: new Map() };
  runs.set(tabId, run);
  try {
    await loop(deps, run);
  } catch (err) {
    run.status = 'error';
    publish(deps, run, `## ❌ Agent Error\n\n${(err as Error).message}\n\n**Steps completed:**\n${formatHistory(run.history) || 'None'}`, false);
  } finally {
    await deps.onRunEnded(tabId);
  }
  return view(run);
}
