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
import { parseAgentResponse } from '@/lib/agent/parseAction';
import type { ScreenshotMode } from '@/lib/agent/prefs';
import { pickSkills, slugify, type Skill } from '@/lib/skills/skill';
import { checkCode, wrapCode, formatCodeResult } from '@/lib/agent/customCode';
import { isReplayed, describeStep, type Workflow, type WorkflowStep } from '@/lib/workflows/workflow';
import type { ElementKey } from '@/lib/agent/domSnapshot';
import { MAX_INVALID_RESPONSES, REPEAT_PAUSE, REPEAT_WARN, describeAction, formatHistory } from '@/lib/agent/history';

/** "paused": waiting for the user to continue or stop (checkpoint, or the agent looks stuck). */
export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'stopped';

/** What the sidebar shows; pushed on every change and fetched on page load. */
export interface RunView {
  goal: string;
  status: RunStatus;
  /** Markdown; final messages start with "Task Complete", "Stopped" or "Agent Error", pauses with "Paused". */
  message: string;
  loading: boolean;
  step: number;
  /** The model's current plan, e.g. "[x] Open the cart", "[ ] Check out". */
  plan: string[];
  /** The model that answered last, e.g. "Groq · qwen/qwen3.8-27b". */
  model?: string;
  /** Last change (ms since epoch): a newly loaded page shows recent results only. */
  updatedAt: number;
  /** A saved workflow run: "replayed" if every step replayed, "healed" if the agent had to take over. */
  replay?: 'replaying' | 'replayed' | 'healed';
  /** The workflow being replayed. */
  workflowName?: string;
  /** Why this run can't be saved as a workflow, if it can't. */
  unrecordable?: string;
}

export interface TabInfo {
  status?: string;
  url?: string;
  title?: string;
}

/**
 * Which model a call goes to. With a fast "executor" model set up, it takes
 * routine steps; the main "planner" model makes the plan, handles anything
 * that went wrong, re-checks the plan now and then, and confirms "done".
 */
export type ModelRole = 'planner' | 'executor';

/** A model's answer, and which model gave it (backup providers can take over). */
export interface PlanReply {
  text: string;
  /** e.g. "Gemini · gemini-3.5-flash-lite" */
  model: string;
  /** Models tried before it that couldn't answer, and why. */
  unavailable?: { label: string; reason: string }[];
  /** A screenshot was sent, but this model doesn't accept images, so it got text only. */
  imageDropped?: boolean;
}

export interface RunnerDeps {
  /** Ask the model for its next actions; returns its raw output. */
  plan(goal: string, snapshot: string, history: string[], currentPlan: string[], role: ModelRole, image?: string): Promise<string | PlanReply>;
  /** Screenshot of the tab with the snapshot's elements numbered (data URL), or null if it can't be taken. */
  screenshot?(tabId: number, visual: unknown): Promise<string | null>;
  /** Evaluate a wrapped run_code expression in the tab (isolated world); resolves with its JSON result. */
  runCode?(tabId: number, expression: string): Promise<string | undefined>;
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
  /** Times each action was chosen on each exact page state (stuck detection). */
  repeats: Map<string, number>;
  /** Pause every this many steps to ask the user (0 = never). */
  checkpoint: number;
  /** Set while paused: true = continue, false = stop. */
  decide?: (keepGoing: boolean) => void;
  /** Why the run stopped, when it wasn't the user's request. */
  stopReason?: string;
  /** A fast executor model is set up (see ModelRole). */
  split: boolean;
  /** The next call must go to the planner. */
  needPlanner: boolean;
  /** Routine (non-planning) steps since the last planning step. */
  routineCalls: number;
  screenshots: ScreenshotMode;
  /** Models already reported as not accepting screenshots. */
  noVision: Set<string>;
  /** The snapshot the model last saw, to tell it what its actions changed. */
  lastSnapshot?: { url?: string; text: string };
  /** The user's saved skills, and the ones the model loaded with use_skill. */
  skills: Skill[];
  loadedSkills: Set<string>;
  customCode: boolean;
  /** The model's summary when it finished. */
  summary?: string;
  /** What this run did, step by step, for saving it as a workflow. */
  trace: WorkflowStep[];
  startUrl?: string;
  /** A saved workflow being replayed, and the next step of it. */
  workflow?: Workflow;
  replayIndex: number;
  /** The page after the last action, for a workflow's final check. */
  lastPage?: TabInfo;
  /** The model that last answered for each role, to spot a backup taking over. */
  roleModels: Partial<Record<ModelRole, string>>;
}

export interface RunOptions {
  /** Pause and ask "keep going?" every this many steps; 0 or absent = never. */
  checkpoint?: number;
  /** A fast executor model takes routine steps (see ModelRole). */
  split?: boolean;
  screenshots?: ScreenshotMode;
  /** The user's saved skills (lib/skills); relevant ones are shown to the model. */
  skills?: Skill[];
  /** The user turned on run_code (lib/agent/customCode.ts). */
  customCode?: boolean;
  /** Replay this saved workflow (no model calls), letting the agent take over if a step fails. */
  workflow?: Workflow;
}

/** Most skills listed by name for use_skill (the rest are too unlikely to matter). */
const MAX_LISTED_SKILLS = 20;

/**
 * The skills part of the prompt, placed under the goal: in full, the ones
 * that fit this page and goal plus any the model loaded; by name, the others.
 */
export function skillsSection(all: Skill[], goal: string, url: string | undefined, loaded: Set<string>): string {
  if (all.length === 0) return '';
  const shown = pickSkills(all, goal, url);
  for (const skill of all) if (loaded.has(skill.name) && !shown.includes(skill)) shown.push(skill);
  const others = all.filter((skill) => !shown.includes(skill)).slice(0, MAX_LISTED_SKILLS);
  const parts: string[] = [];
  if (shown.length) {
    const full = shown.map((s) => `### ${s.name}: ${s.description}\n${s.body}`).join('\n\n');
    parts.push(`--- SKILLS (instructions the user saved for tasks like this; follow them where they fit) ---\n${full}`);
  }
  if (others.length) {
    const list = others.map((s) => `- ${s.name}: ${s.description}`).join('\n');
    parts.push(`--- OTHER SKILLS (load one with use_skill if it fits this task) ---\n${list}`);
  }
  return `\n\n${parts.join('\n\n')}`;
}

/** A planning step (the planner answers, if there's an executor) at least every this many calls. */
export const PLANNER_EVERY = 5;

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

/** Most new text lines, new elements and gone elements listed in a change summary. */
const MAX_NEW_TEXT = 5;
const MAX_NEW_ELEMENTS = 8;
const MAX_GONE_ELEMENTS = 5;

/** Element lines of a snapshot, keyed by description: IDs are renumbered every snapshot, and typed values are in the history. */
function elementLines(snapshot: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of snapshot.split('\n')) {
    if (!/^\[\d+\] </.test(line)) continue;
    lines.set(line.replace(/^\[\d+\] /, '').replace(/ value="[^"]*"/, ''), line);
  }
  return lines;
}

/** Words of a snapshot's visible text (capped, to bound the diff's cost). */
function textWords(snapshot: string): string[] {
  const text = snapshot.split('--- VISIBLE TEXT (excerpt) ---')[1] ?? '';
  return text.split(/\s+/).filter(Boolean).slice(0, 800);
}

/**
 * Word-level diff: the runs of words added to and removed from `before` to
 * make `after` (longest common subsequence). Page text often arrives as one
 * long line, so comparing lines would report the whole page as new when one
 * sentence ("Kite 14 added to your cart.") was added to it.
 */
export function textChanges(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const m = before.length;
  const n = after.length;
  // lcs[i][j]: common subsequence length of before[i..] and after[j..]
  const lcs = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let add: string[] = [];
  let del: string[] = [];
  const flush = () => {
    if (add.length) added.push(add.join(' '));
    if (del.length) removed.push(del.join(' '));
    add = [];
    del = [];
  };
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if (j < n && (i === m || lcs[i][j + 1] >= lcs[i + 1][j])) {
      add.push(after[j++]);
    } else {
      del.push(before[i++]);
    }
  }
  flush();
  return { added, removed };
}

/** A diff run for the prompt: quoted, and shortened if long. */
function quoted(run: string): string {
  return `"${run.length > 160 ? `${run.slice(0, 160)}…` : run}"`;
}

/**
 * What changed on the page since the previous snapshot of the same page:
 * new text (error messages, confirmations), elements that appeared (a popup,
 * a menu) and elements that went away. Or, just as useful, that nothing did.
 */
export function changesSection(previous: string, current: string): string {
  const before = elementLines(previous);
  const after = elementLines(current);
  const added = [...after].filter(([key]) => !before.has(key)).map(([, line]) => line);
  const gone = [...before.keys()].filter((key) => !after.has(key));
  // Runs without letters are counters and timers ticking ("1:59" → "1:58"), not news
  const news = (run: string) => run.length > 2 && /\p{L}/u.test(run);
  const text = textChanges(textWords(previous), textWords(current));
  const newText = text.added.filter(news);
  const goneText = text.removed.filter(news);

  if (!added.length && !gone.length && !newText.length && !goneText.length) {
    return '\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\nNothing visible changed on the page. That is not always a failure (some actions give no feedback): if the history says your action worked, do not repeat it.';
  }
  const out: string[] = [];
  if (newText.length) out.push(`New text: ${newText.slice(0, MAX_NEW_TEXT).map(quoted).join(' | ')}`);
  if (goneText.length) out.push(`Text gone: ${goneText.slice(0, MAX_NEW_TEXT).map(quoted).join(' | ')}`);
  if (added.length) out.push(`New elements:\n${added.slice(0, MAX_NEW_ELEMENTS).join('\n')}${added.length > MAX_NEW_ELEMENTS ? `\n… and ${added.length - MAX_NEW_ELEMENTS} more` : ''}`);
  if (gone.length) out.push(`Gone: ${gone.slice(0, MAX_GONE_ELEMENTS).join('; ')}${gone.length > MAX_GONE_ELEMENTS ? `; and ${gone.length - MAX_GONE_ELEMENTS} more` : ''}`);
  return `\n\n--- WHAT CHANGED AFTER YOUR LAST ACTIONS ---\n${out.join('\n')}`;
}

/** After an action, time for a click-triggered navigation to start. */
const SETTLE_MS = 700;
/** Actions that can't navigate or open anything need only a short pause. */
const QUICK_SETTLE_MS = 100;
const QUICK_ACTIONS: ReadonlySet<AgentAction['action']> = new Set(['type', 'clear_and_type', 'note', 'find', 'read', 'scroll', 'wait', 'extract']);
const READY_TIMEOUT_MS = 20_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const EXECUTE_TIMEOUT_MS = 60_000;
/** A pause nobody answers ends the run (a paused run keeps the service worker awake). */
const PAUSE_TIMEOUT_MS = 10 * 60_000;

const runs = new Map<number, Run>();

function view(run: Run): RunView {
  const { goal, status, message, loading, step, plan, model, updatedAt, replay, unrecordable } = run;
  return { goal, status, message, loading, step, plan, model, updatedAt, replay, unrecordable, workflowName: run.workflow?.name };
}

export function getRunView(tabId: number): RunView | null {
  const run = runs.get(tabId);
  return run ? view(run) : null;
}

/** What a run did, for turning it into a skill (lib/skills). */
export interface RunRecord {
  goal: string;
  status: RunStatus;
  plan: string[];
  history: string[];
  /** The model's summary when it finished. */
  summary?: string;
  /** Pages it visited, in order. */
  urls: string[];
  /** Its steps, for a workflow (see WorkflowStep), and where it started and ended. */
  trace: WorkflowStep[];
  startUrl?: string;
  finalUrl?: string;
  finalTitle?: string;
  /** Why it can't be saved as a workflow, if it can't. */
  unrecordable?: string;
}

export function getRunRecord(tabId: number): RunRecord | null {
  const run = runs.get(tabId);
  if (!run) return null;
  const { goal, status, plan, history, summary, startUrl, unrecordable } = run;
  return {
    goal, status, plan: [...plan], history: [...history], summary, urls: [...run.visited.keys()],
    trace: [...run.trace], startUrl, finalUrl: run.lastPage?.url, finalTitle: run.lastPage?.title, unrecordable,
  };
}

/** Running or paused: the run's loop is still alive. */
export function isRunning(tabId: number): boolean {
  const status = runs.get(tabId)?.status;
  return status === 'running' || status === 'paused';
}

/** Feed from chrome.tabs.onUpdated (status "loading"): tells the loop the page changed. */
export function notifyTabLoading(tabId: number): void {
  const run = runs.get(tabId);
  if (run) run.loads++;
}

/** Ask a running agent to stop after its current step (right away if paused). */
export function stopRun(tabId: number): void {
  const run = runs.get(tabId);
  if (!run || !isRunning(tabId)) return;
  run.stopRequested = true;
  run.decide?.(false);
}

/** Let a paused run carry on. */
export function resumeRun(tabId: number): void {
  runs.get(tabId)?.decide?.(true);
}

/** Forget a tab's run (tab closed, or the user cleared the chat). */
export function forgetRun(tabId: number): void {
  stopRun(tabId);
  if (!isRunning(tabId)) runs.delete(tabId);
}

function publish(deps: RunnerDeps, run: Run, message: string, loading: boolean): void {
  run.message = message;
  run.loading = loading;
  run.updatedAt = Date.now();
  // The page may be mid-navigation; the next page asks for the state when it loads
  deps.send(run.tabId, { action: 'AGENT_UPDATE', payload: view(run) }, 2_000).catch(() => {});
}

/** Wait until the tab has finished loading and its content script answers. */
export async function waitForPage(deps: Pick<RunnerDeps, 'getTab' | 'send' | 'sleep'>, tabId: number): Promise<TabInfo> {
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

/** The plan as a checklist: "[x] a" → "☑ a", "[ ] b" → "☐ b". */
export function formatPlan(plan: string[]): string {
  return plan.map((item) => {
    const m = item.match(/^\[([ xX✓]?)\]\s*(.*)$/);
    if (!m) return `- ${item}`;
    return `- ${m[1].trim() ? '☑' : '☐'} ${m[2]}`;
  }).join('\n');
}

function progressMessage(run: Run, footer: string): string {
  const plan = run.plan.length ? `**Plan**\n${formatPlan(run.plan)}\n\n` : '';
  const by = run.model ? ` · ${run.model}` : '';
  return `**Agent Progress** (step ${run.step}${by})\n\n${plan}${formatHistory(run.history)}\n\n${footer}`;
}

/**
 * History entry for when another model takes over mid-task. The new model gets
 * the same goal, plan, history and page as the old one would have; this tells
 * it that it's continuing, not starting.
 */
export function handoffNote(previous: string, next: string, reason?: string): string {
  const who = reason ? `${previous} ${reason}, so ${next} takes over from here.` : `${next} takes over from ${previous} here.`;
  return `(handoff) ${who} This task is already under way: `
    + 'plan items marked [x] are done, [ ] items are left, and the history above is everything done so far. Carry on from where it ends; don\'t start over.';
}

/**
 * Run one action. If it navigates (link click, form submit), the page may
 * unload before it answers; that's expected, not an error.
 */
export async function runAction(
  deps: Pick<RunnerDeps, 'getTab' | 'send' | 'sleep' | 'navigate'>,
  tabId: number,
  action: AgentAction,
  /** Page loads seen in the tab so far (see notifyTabLoading). */
  loads: () => number,
): Promise<{ result: string; pageChanged: boolean }> {
  if (action.action === 'navigate') {
    await deps.navigate(tabId, action.url!);
    await deps.sleep(SETTLE_MS);
    const tab = await waitForPage(deps, tabId);
    if (isNotFound(tab.title)) return { result: notFoundResult(tab), pageChanged: true };
    return { result: `✅ now on "${tab.title || 'untitled page'}" (${tab.url})`, pageChanged: true };
  }

  const loadsBefore = loads();
  const urlBefore = (await deps.getTab(tabId)).url;
  let result: string;
  try {
    result = String(await deps.send(tabId, { action: 'AGENT_EXECUTE', payload: action }, EXECUTE_TIMEOUT_MS));
  } catch {
    result = '✅ Done (the page changed before it could report back)';
  }

  await deps.sleep(QUICK_ACTIONS.has(action.action) ? QUICK_SETTLE_MS : SETTLE_MS);
  const now = await deps.getTab(tabId);
  if (loads() > loadsBefore || now.status === 'loading' || now.url !== urlBefore) {
    const tab = await waitForPage(deps, tabId);
    if (isNotFound(tab.title)) return { result: notFoundResult(tab), pageChanged: true };
    return { result: `${result}; page changed, now on "${tab.title || 'untitled page'}" (${tab.url})`, pageChanged: true };
  }
  return { result, pageChanged: false };
}

/**
 * Replay a workflow's next step: find its element by description, act, check
 * the result. If the element is gone or the action fails, the agent takes
 * over from there with a note on what happened ("healed").
 */
async function replayNext(deps: RunnerDeps, run: Run): Promise<'next' | 'finished'> {
  const workflow = run.workflow!;
  const { tabId } = run;
  if (run.replayIndex >= workflow.steps.length) return 'finished';
  // Start where the recorded run started
  if (run.replayIndex === 0 && workflow.startUrl && (await deps.getTab(tabId)).url !== workflow.startUrl) {
    await deps.navigate(tabId, workflow.startUrl);
    await deps.sleep(SETTLE_MS);
  }
  const step = workflow.steps[run.replayIndex];
  const n = run.replayIndex + 1;
  publish(deps, run, progressMessage(run, `*Replaying step ${n} of ${workflow.steps.length}: ${describeStep(step)}*`), true);
  const page = await waitForPage(deps, tabId);
  run.startUrl ??= page.url;

  const action: AgentAction = { ...step.action };
  if (step.target) {
    await deps.send(tabId, { action: 'AGENT_SNAPSHOT' }, SNAPSHOT_TIMEOUT_MS); // fresh element IDs
    const found = await deps.send(tabId, { action: 'AGENT_RESOLVE', target: step.target }, 5_000).catch(() => null);
    if (typeof found?.id !== 'number') return heal(run, n, step, `its element (${step.target.key}) isn't on the page any more`);
    action.elementId = found.id;
  }
  const { result } = await runAction(deps, tabId, action, () => run.loads);
  // The executor echoes typed text; never a saved password
  const password = /type="password"/.test(step.target?.key ?? '') ? step.action.text : undefined;
  run.history.push(`↻ ${describeStep(step)} → ${password ? result.split(password).join('••••') : result}`);
  if (result.startsWith('❌')) return heal(run, n, step, result);
  record(run, action, step.target, page.url);
  run.lastPage = await deps.getTab(tabId).catch(() => run.lastPage);
  run.replayIndex++;
  return run.replayIndex >= workflow.steps.length ? 'finished' : 'next';
}

/** A replayed step didn't fit: hand the task to the agent from here. */
function heal(run: Run, n: number, step: WorkflowStep, why: string): 'next' {
  run.replay = 'healed';
  run.needPlanner = true;
  const done = n > 1 ? `steps 1-${n - 1} worked, but step ${n}` : 'its first step';
  run.history.push(`(note from Genesis) Replaying the saved workflow "${run.workflow!.name}": ${done} (${describeStep(step)}) didn't: ${why}. The page may have changed. Carry on with the task from here yourself.`);
  return 'next';
}

/** Same page, ignoring the query and fragment (search terms, session IDs). */
function samePage(a: string | undefined, b: string | undefined): boolean {
  try {
    const x = new URL(a ?? '');
    const y = new URL(b ?? '');
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

/** Every step replayed: finish without asking a model, noting if it ended somewhere unexpected. */
function finishReplay(deps: RunnerDeps, run: Run): void {
  const workflow = run.workflow!;
  const now = run.lastPage;
  run.status = 'done';
  run.replay = 'replayed';
  const where = now ? ` Now on "${now.title || 'untitled page'}" (${now.url}).` : '';
  const check = workflow.finalUrl && now && !samePage(now.url, workflow.finalUrl)
    ? ` ⚠️ The recorded run ended on ${workflow.finalUrl}, so check this worked.`
    : '';
  run.summary = `Replayed the workflow "${workflow.name}": ${workflow.steps.length} steps, no model calls.${where}${check}`;
  publish(deps, run, `## ✅ Task Complete\n\n${run.summary}\n\n---\n**Steps taken:**\n${formatHistory(run.history)}`, false);
}

/** An element's lasting description for a workflow step, or undefined (and the run can't be saved as one). */
async function describeTarget(deps: RunnerDeps, run: Run, elementId: number): Promise<ElementKey | undefined> {
  const target = await deps.send(run.tabId, { action: 'AGENT_DESCRIBE', id: elementId }, 2_000).catch(() => null) as ElementKey | null;
  if (!target?.key) run.unrecordable ??= `element [${elementId}] couldn't be described (it may be in a cross-origin frame)`;
  return target?.key ? target : undefined;
}

/** Add a successful action to the run's workflow trace. */
function record(run: Run, action: AgentAction, target: ElementKey | undefined, url: string | undefined): void {
  if (action.elementId !== undefined && !target) return; // already marked unrecordable
  const { elementId: _id, ...rest } = action;
  run.trace.push({ action: rest, ...(target ? { target } : {}), ...(url ? { url } : {}) });
}

/** run_code: check the code, run it if allowed, and say what happened. */
async function runCodeAction(deps: RunnerDeps, run: Run, code: string): Promise<string> {
  if (!run.customCode || !deps.runCode) {
    return '❌ Running your own code is turned off (the user can allow it in the Genesis popup). Use extract, read or find instead.';
  }
  const refused = checkCode(code);
  if (refused) return `❌ Not run: ${refused}. The code may only read this page and return data.`;
  try {
    return formatCodeResult(await deps.runCode(run.tabId, wrapCode(code)));
  } catch (err) {
    return `❌ The code failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
  }
}

/** An error page's title: "404", "Page not found", "Not Found", ... */
export function isNotFound(title: string | undefined): boolean {
  return !!title && /\b404\b|\bnot found\b|page (does not|doesn't) exist/i.test(title);
}

/**
 * A missing page is a failure, not "✅ now on Page not found": told it
 * succeeded, models keep guessing URLs (/cart, /checkout, ...) for dozens of steps.
 */
function notFoundResult(tab: TabInfo): string {
  return `❌ landed on "${tab.title}" (${tab.url}): that page doesn't exist. Don't guess URLs; use links you have seen.`;
}

/** Short fingerprint of a page snapshot (FNV-1a), so repeats are cheap to spot. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Pause and wait for the user. Resolves true to continue; false if they stop
 * or don't answer within PAUSE_TIMEOUT_MS.
 */
async function pause(deps: RunnerDeps, run: Run, reason: string): Promise<boolean> {
  run.status = 'paused';
  const decision = new Promise<boolean>((resolve) => { run.decide = resolve; });
  publish(deps, run, `## ⏸️ Paused\n\n${reason}\n\n**Steps so far:**\n${formatHistory(run.history) || 'None'}`, false);
  const keepGoing = await Promise.race([decision, deps.sleep(PAUSE_TIMEOUT_MS).then(() => null)]);
  run.decide = undefined;
  if (keepGoing) {
    run.status = 'running';
    return true;
  }
  if (keepGoing === null) run.stopReason = 'Paused for 10 minutes without an answer, so the agent stopped.';
  run.stopRequested = true;
  return false;
}

async function loop(deps: RunnerDeps, run: Run): Promise<void> {
  const { tabId } = run;
  let invalidStreak = 0;
  let nextCheckpoint = run.checkpoint;

  // No step limit: the run ends when the model says "done" or the user stops it
  while (!run.stopRequested) {
    if (run.checkpoint > 0 && run.step >= nextCheckpoint) {
      if (!await pause(deps, run, `The agent has taken ${run.step} steps without finishing. Keep going?`)) break;
      nextCheckpoint = run.step + run.checkpoint;
    }
    run.step++;
    // A saved workflow: its steps first, with no model calls
    if (run.replay === 'replaying') {
      if (await replayNext(deps, run) === 'finished') {
        finishReplay(deps, run);
        return;
      }
      continue;
    }
    publish(deps, run, run.history.length ? progressMessage(run, `*Step ${run.step}: scanning the page...*`) : `🔍 **Step ${run.step}**: scanning the page...`, true);

    // Planning steps: the first, any after trouble, and a regular re-check
    const planning = run.needPlanner || run.routineCalls >= PLANNER_EVERY;
    const role: ModelRole = run.split && !planning ? 'executor' : 'planner';
    const wantImage = run.screenshots === 'always' || (run.screenshots === 'planning' && planning);

    const page = await waitForPage(deps, tabId);
    run.startUrl ??= page.url; // where a workflow of this run starts
    const snapshot = await deps.send(tabId, { action: 'AGENT_SNAPSHOT', visual: wantImage }, SNAPSHOT_TIMEOUT_MS);
    if (run.stopRequested) break;
    const snapshotText = String(snapshot?.text ?? '');
    let image: string | undefined;
    if (wantImage && snapshot?.visual && deps.screenshot) {
      // No screenshot (tab hidden, capture refused) just means text only this step
      image = (await deps.screenshot(tabId, snapshot.visual).catch(() => null)) ?? undefined;
    }

    publish(deps, run, run.history.length ? progressMessage(run, `*Step ${run.step}: planning...*`) : `🧠 **Step ${run.step}**: planning...`, true);
    // Same page as last time: say what the last actions changed (a new page is all new)
    const last = run.lastSnapshot;
    const changes = last && last.url === page.url && run.history.length ? changesSection(last.text, snapshotText) : '';
    run.lastSnapshot = { url: page.url, text: snapshotText };
    // Skills go with the goal: near the start, where they don't break the prompt cache
    const goal = run.goal + skillsSection(run.skills, run.goal, page.url, run.loadedSkills);
    const reply = await deps.plan(goal, snapshotText + changes + memorySection(run.visited, page.url), run.history, run.plan, role, image);
    const { text: raw, model, unavailable, imageDropped } = typeof reply === 'string'
      ? { text: reply, model: undefined, unavailable: undefined, imageDropped: false }
      : reply;
    if (imageDropped && model && !run.noVision.has(model)) {
      run.noVision.add(model);
      run.history.push(`(note from Genesis) Screenshots are on, but ${model} doesn't accept images, so it gets the page as text only.`);
    }
    // A different model in the same role means a backup took over; switching
    // between the planner and executor is routine and needs no note
    const before = run.roleModels[role];
    if (model && before && model !== before) {
      const reason = unavailable?.find((u) => u.label === before)?.reason;
      run.history.push(handoffNote(before, model, reason));
    }
    if (model) {
      run.model = model;
      run.roleModels[role] = model;
    }
    run.routineCalls = planning ? 0 : run.routineCalls + 1;
    run.needPlanner = false;
    if (page.url) {
      // Re-insert so the most recently seen pages come last
      run.visited.delete(page.url);
      run.visited.set(page.url, pageExcerpt(snapshotText));
    }
    if (run.stopRequested) break;

    const parsed = parseAgentResponse(raw);
    if (!parsed.ok) {
      // Feed the error back through history so the model can correct itself
      invalidStreak++;
      run.needPlanner = true;
      run.history.push(`(invalid response) → ❌ ${parsed.error}. Respond with valid JSON: {"plan": [...], "actions": [...]}.`);
      if (invalidStreak >= MAX_INVALID_RESPONSES) {
        throw new Error(`Model returned ${invalidStreak} invalid responses in a row. Last error: ${parsed.error}`);
      }
      continue;
    }
    invalidStreak = 0;
    if (parsed.plan?.length) run.plan = parsed.plan;
    const { actions } = parsed;
    const descs = actions.map(describeAction);

    // Stuck detection: the same actions chosen again on the same, unchanged page
    const stateKey = `${page.url}\n${hashText(snapshotText)}\n${descs.join('\n')}`;
    const seen = (run.repeats.get(stateKey) ?? 0) + 1;
    run.repeats.set(stateKey, seen);
    if (seen >= REPEAT_PAUSE && actions[0]?.action !== 'done') {
      const what = descs.join(', ') || 'a plan with no actions';
      const reason = `The agent looks stuck: it chose \`${what}\` ${seen} times on this page, and the page didn't change. Continue to let it try something else, or stop.`;
      if (!await pause(deps, run, reason)) break;
      run.repeats.set(stateKey, REPEAT_WARN); // choosing it once more pauses again
      run.needPlanner = true;
      run.history.push(`${what} → ⏸️ not run: you chose this ${seen} times on this unchanged page. Do something different.`);
      continue;
    }
    const repeatWarning = seen >= REPEAT_WARN
      ? ' ⚠️ You already did exactly this on this same page. If nothing changed, do something different.'
      : '';
    if (repeatWarning || parsed.notes.length) run.needPlanner = true;
    for (const note of parsed.notes) run.history.push(`(note from Genesis) ${note}`);

    for (const [i, action] of actions.entries()) {
      if (run.stopRequested) break;
      if (action.action === 'done' && role === 'executor') {
        // The fast model may call it done too early; the planner confirms
        run.needPlanner = true;
        run.history.push(`(note from Genesis) The fast model says the goal is complete: "${action.summary || 'Done'}". Check the page: if it really is, send "done"; if not, carry on.`);
        break;
      }
      if (action.action === 'done') {
        run.status = 'done';
        run.summary = action.summary || 'Done';
        publish(deps, run, `## ✅ Task Complete\n\n${action.summary || 'Done'}\n\n---\n**Steps taken:**\n${formatHistory(run.history)}`, false);
        return;
      }
      const desc = descs[i];
      if (action.action === 'run_code') {
        // Run by the background through the debugger, not by the page's content script
        publish(deps, run, progressMessage(run, `*Step ${run.step}: ${desc}*`), true);
        const result = await runCodeAction(deps, run, action.text ?? '');
        run.history.push(`${desc} → ${result}`);
        if (result.startsWith('❌')) run.needPlanner = true;
        continue;
      }
      if (action.action === 'use_skill') {
        // Handled here, not on the page: the skill joins the prompt from the next call
        const skill = run.skills.find((sk) => sk.name === slugify(action.text ?? ''));
        if (skill) run.loadedSkills.add(skill.name);
        run.history.push(`${desc} → ${skill ? '✅ loaded: its instructions are now under SKILLS' : `❌ there is no skill named "${action.text}"`}`);
        continue;
      }
      publish(deps, run, progressMessage(run, `*Step ${run.step}: ${desc}*`), true);
      // Workflows: describe the element before acting, while its ID is still valid
      const target = isReplayed(action) && action.elementId !== undefined ? await describeTarget(deps, run, action.elementId) : undefined;
      const { result, pageChanged } = await runAction(deps, tabId, action, () => run.loads);
      run.history.push(`${desc} → ${result}${i === 0 ? repeatWarning : ''}`);
      if (isReplayed(action) && !result.startsWith('❌')) record(run, action, target, page.url);
      run.lastPage = await deps.getTab(tabId).catch(() => run.lastPage);

      // Later actions were planned for the page as it was; stop if that changed
      const left = actions.length - i - 1;
      const failed = result.startsWith('❌');
      if (failed) run.needPlanner = true;
      if (left > 0 && (pageChanged || failed)) {
        const why = pageChanged ? 'the page changed, so they may not fit it any more' : 'the action above failed';
        run.history.push(`(note from Genesis) ${left} more action${left === 1 ? '' : 's'} not run: ${why}`);
        break;
      }
    }
  }

  // The loop only gets here when the run was stopped
  run.status = 'stopped';
  const why = run.stopReason ? `${run.stopReason}\n\n` : '';
  publish(deps, run, `## ⏹️ Stopped\n\n${why}**Steps taken:**\n${formatHistory(run.history) || 'None'}`, false);
}

/**
 * Start an agent run in a tab and resolve when it ends. One run per tab: a new
 * one stops the old one first.
 */
export async function startRun(deps: RunnerDeps, tabId: number, goal: string, options: RunOptions = {}): Promise<RunView> {
  stopRun(tabId);

  const run: Run = {
    tabId, goal, status: 'running', message: '', loading: true, step: 0, plan: [], updatedAt: Date.now(), history: [],
    stopRequested: false, loads: 0, visited: new Map(), repeats: new Map(), checkpoint: Math.max(0, options.checkpoint ?? 0),
    split: !!options.split, needPlanner: true, routineCalls: 0, roleModels: {},
    screenshots: options.screenshots ?? 'off', noVision: new Set(),
    skills: options.skills ?? [], loadedSkills: new Set(), customCode: !!options.customCode,
    trace: [], workflow: options.workflow, replayIndex: 0, ...(options.workflow ? { replay: 'replaying' as const } : {}),
  };
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
