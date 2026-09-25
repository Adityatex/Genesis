// eval/run.mts
// End-to-end benchmark: loads the built extension into Chromium, types each
// task's goal into the real sidebar, and grades the result from what the
// fixture server recorded.
//
//   npm run eval                 live run against Groq (needs GROQ_API_KEY)
//   npm run eval:mock            scripted planner, no API calls (used in CI)
//   ... -- --task login,todo-enter --trials 3 --headed --verbose
//   ... -- --model openai/gpt-oss-120b     (default: the extension's DEFAULT_MODEL)

import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startFixtureServer, type FixtureServer } from './server.mts';
import { TASKS, type Task, type MockStep } from './tasks.mts';
import { isAgentCommand } from '../lib/agent/loop.ts';
import { DEFAULT_MODEL } from '../lib/api/groqClient.ts';

// Only exists inside the extension's service worker (see worker.evaluate below)
declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const RESULTS_DIR = path.join(ROOT, 'eval', 'results');
const OUTCOME_RE = /Task Complete|Max Steps Reached|Agent Error/;

const { values: args } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    task: { type: 'string' },
    trials: { type: 'string', default: '1' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    model: { type: 'string' },
    tpm: { type: 'string', default: '7000' },
  },
});

const MODE = args.mock ? 'mock' : 'live';
const TRIALS = Math.max(1, Number(args.trials));
const TIMEOUT_MS = Number(args.timeout ?? (args.mock ? 90 : 300)) * 1000;

type Outcome = 'done' | 'max-steps' | 'error' | 'timeout' | 'rate-limited';

// ---------------------------------------------------------------- rate limiting
// Groq's free tier allows 8000 tokens/minute per model. Pace live planner calls
// under that so the benchmark measures the agent, not the quota. Waits are
// capped below the extension's 15s request timeout; if we still get a 429 the
// extension's own retry/backoff handles it.
const TPM_BUDGET = Number(args.tpm);
const MAX_THROTTLE_MS = 12_000;
const tokenWindow: { t: number; tokens: number }[] = [];

async function throttle(estimate: number): Promise<{ t: number; tokens: number }> {
  const deadline = Date.now() + MAX_THROTTLE_MS;
  for (;;) {
    const now = Date.now();
    while (tokenWindow.length && now - tokenWindow[0].t > 60_000) tokenWindow.shift();
    const used = tokenWindow.reduce((sum, w) => sum + w.tokens, 0);
    if (used + estimate <= TPM_BUDGET || now >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(deadline - now, tokenWindow[0].t + 60_000 - now + 50)));
  }
  const entry = { t: Date.now(), tokens: estimate };
  tokenWindow.push(entry);
  return entry;
}

interface RunResult {
  id: string;
  category: Task['category'];
  trial: number;
  pass: boolean;
  outcome: Outcome;
  llmCalls: number;
  rateLimitHits: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  finalUrl: string;
  summary: string;
  knownIssue?: string;
}

// ---------------------------------------------------------------- helpers

function loadApiKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/^GROQ_API_KEY=(.+)$/m);
    if (m?.[1].trim()) return m[1].trim();
  }
  return '';
}

function chatCompletion(content: string) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  };
}

/** Planner that replays a task's mockPlan against the snapshot the extension sent. */
function mockPlanner(plan: MockStep[]) {
  let step = 0;
  return (prompt: string): string => {
    const next = plan[step++];
    if (!next) return JSON.stringify({ action: 'done', summary: 'MOCK: plan complete' });
    if (next.action === 'done') return JSON.stringify(next);

    // Only look at the element list the model would actually receive
    const snapshot = prompt.split('CURRENT PAGE DOM SNAPSHOT:')[1]?.split(/\n\nACTION HISTORY|\n\nWhat is the NEXT/)[0] ?? '';
    const findId = (target: RegExp) => {
      for (const line of snapshot.split('\n')) {
        const m = line.match(/^\[(\d+)\] (.*)$/);
        if (m && target.test(m[2])) return Number(m[1]);
      }
      return undefined;
    };

    if (next.action === 'press_key') {
      const elementId = next.target ? findId(next.target) : undefined;
      return JSON.stringify({ action: 'press_key', key: next.key, elementId });
    }
    const elementId = findId(next.target);
    if (elementId === undefined) {
      return JSON.stringify({ action: 'done', summary: `MOCK: no element matching ${next.target} in snapshot` });
    }
    const { target: _target, ...rest } = next;
    return JSON.stringify({ ...rest, elementId });
  };
}

async function launch(apiKey: string): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-eval-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !args.headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await worker.evaluate(
    ([key, model]) => chrome.storage.local.set(model ? { groqApiKey: key, groqModel: model } : { groqApiKey: key }),
    [apiKey, args.model ?? ''] as const,
  );
  return context;
}

/** Final agent message text, or '' while the agent is still running. */
async function readOutcome(page: Page): Promise<string> {
  try {
    const texts = await page.locator('.markdown-body').allInnerTexts();
    return texts.reverse().find(t => OUTCOME_RE.test(t)) ?? '';
  } catch {
    return ''; // page is mid-navigation
  }
}

// ---------------------------------------------------------------- runner

async function runTask(task: Task, trial: number, server: FixtureServer, apiKey: string): Promise<RunResult> {
  const context = await launch(apiKey);
  const result: RunResult = {
    id: task.id, category: task.category, trial, pass: false, outcome: 'timeout',
    llmCalls: 0, rateLimitHits: 0, promptTokens: 0, completionTokens: 0, durationMs: 0,
    finalUrl: '', summary: '', knownIssue: task.knownIssue,
  };

  const planMock = mockPlanner(task.mockPlan);
  await context.route('https://api.groq.com/**', async (route: Route) => {
    result.llmCalls++;
    log(`planner call #${result.llmCalls}`);
    if (MODE === 'mock') {
      const body = route.request().postDataJSON();
      await route.fulfill(chatCompletion(planMock(body.messages.at(-1).content)));
      return;
    }
    // ~4 chars/token for the prompt, plus headroom for the (reasoning) completion
    const entry = await throttle(Math.ceil((route.request().postData()?.length ?? 0) / 4) + 400);
    const response = await route.fetch();
    const text = await response.text();
    if (response.status() === 429) {
      result.rateLimitHits++;
      log('429 rate limited');
    }
    try {
      const usage = JSON.parse(text).usage;
      if (usage) entry.tokens = usage.total_tokens ?? entry.tokens;
      result.promptTokens += usage?.prompt_tokens ?? 0;
      result.completionTokens += usage?.completion_tokens ?? 0;
    } catch { /* non-JSON error body */ }
    await route.fulfill({ response, body: text });
  });

  server.reset();
  const started = Date.now();
  const log = (msg: string) => args.verbose && console.log(`    +${((Date.now() - started) / 1000).toFixed(2)}s ${msg}`);
  context.on('console', m => { if (m.text().includes('[Genesis]')) log(`${new URL(m.page()?.url() || 'about:blank').pathname} ${m.text().slice(0, 160)}`); });
  context.on('request', r => { if (r.url().includes('/api/')) log(`server <- ${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    const page = await context.newPage();
    await page.goto(server.baseUrl + task.start);
    await page.locator('[title="Open Genesis Copilot"]').click({ timeout: 15_000 });
    await page.locator('textarea[placeholder^="Describe action"]').fill(task.goal);
    await page.keyboard.press('Enter');

    let finalText = '';
    while (Date.now() - started < TIMEOUT_MS) {
      finalText = await readOutcome(page);
      if (finalText) break;
      await page.waitForTimeout(500).catch(() => {});
    }
    await page.waitForTimeout(1000).catch(() => {}); // let trailing fetches land

    result.outcome = !finalText ? 'timeout'
      : finalText.includes('Task Complete') ? 'done'
      : finalText.includes('Max Steps') ? 'max-steps'
      // Quota, not the agent: reported separately and excluded from success rates
      : /rate limit/i.test(finalText) ? 'rate-limited' : 'error';
    result.summary = finalText.includes('Task Complete')
      ? finalText.split('Task Complete')[1].split('Steps taken')[0].trim()
      : finalText.slice(0, 500).trim();
    result.finalUrl = page.url();
  } catch (err) {
    result.outcome = 'error';
    result.summary = `Harness error: ${(err as Error).message.split('\n')[0]}`;
  } finally {
    result.durationMs = Date.now() - started;
    // Pass = the right side effects happened AND the agent finished cleanly.
    // Doing the work and then hanging or erroring still fails the user.
    result.pass = result.outcome === 'done'
      && task.check({ events: [...server.events], summary: result.summary, finalUrl: result.finalUrl });
    await context.close();
  }
  return result;
}

function pct(n: number, d: number) {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

function report(results: RunResult[], tasks: Task[], meta: Record<string, string>): string {
  const lines: string[] = [];
  const byTask = tasks.map(t => ({ task: t, runs: results.filter(r => r.id === t.id && r.outcome !== 'rate-limited') }));
  const passes = (rs: RunResult[]) => rs.filter(r => r.pass).length;
  const avg = (rs: RunResult[], f: (r: RunResult) => number) =>
    rs.length ? (rs.reduce((s, r) => s + f(r), 0) / rs.length) : 0;

  lines.push(`# Genesis eval — ${meta.mode}`, '');
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}:** ${v}`);
  lines.push('');

  const limited = results.filter(r => r.outcome === 'rate-limited');
  if (limited.length) lines.push(`> ${limited.length} run(s) ended on a Groq rate limit (429) and are excluded from success rates.`, '');
  const scored = results.filter(r => r.outcome !== 'rate-limited');
  const standard = scored.filter(r => r.category !== 'hard');
  const hard = scored.filter(r => r.category === 'hard');
  lines.push('| Suite | Success | Avg LLM calls | Avg tokens | Avg time |', '|---|---|---|---|---|');
  for (const [name, rs] of [['Standard', standard], ['Hard', hard], ['**All**', scored]] as const) {
    lines.push(`| ${name} | ${pct(passes(rs), rs.length)} (${passes(rs)}/${rs.length}) | ${avg(rs, r => r.llmCalls).toFixed(1)} | ${Math.round(avg(rs, r => r.promptTokens + r.completionTokens))} | ${(avg(rs, r => r.durationMs) / 1000).toFixed(1)}s |`);
  }
  lines.push('', '| Task | Category | Pass | Outcome | LLM calls | Notes |', '|---|---|---|---|---|---|');
  for (const { task, runs } of byTask) {
    const outcomes = [...new Set(runs.map(r => r.outcome))].join(', ');
    const note = task.knownIssue ? `known issue: ${task.knownIssue}` : (runs.find(r => !r.pass)?.summary.slice(0, 80) ?? '');
    lines.push(`| \`${task.id}\` | ${task.category} | ${passes(runs)}/${runs.length} | ${outcomes} | ${avg(runs, r => r.llmCalls).toFixed(1)} | ${note.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    console.error('No built extension found. Run `npm run build` first.');
    process.exit(1);
  }
  const apiKey = MODE === 'mock' ? 'mock-key' : loadApiKey();
  if (!apiKey) {
    console.error('Live mode needs GROQ_API_KEY (env var or .env file). Use --mock for a scripted run.');
    process.exit(1);
  }

  const wanted = args.task?.split(',').map(s => s.trim());
  const tasks = wanted ? TASKS.filter(t => wanted.includes(t.id)) : TASKS;
  if (tasks.length === 0) {
    console.error(`No tasks match ${args.task}. Known: ${TASKS.map(t => t.id).join(', ')}`);
    process.exit(1);
  }
  const unrouted = tasks.filter(t => !isAgentCommand(t.goal));
  if (unrouted.length) {
    console.error(`These goals would go to chat instead of the agent: ${unrouted.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  const server = await startFixtureServer();
  const results: RunResult[] = [];
  try {
    for (const task of tasks) {
      for (let trial = 1; trial <= TRIALS; trial++) {
        const r = await runTask(task, trial, server, apiKey);
        results.push(r);
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${task.id}${TRIALS > 1 ? ` #${trial}` : ''}  ${r.outcome}, ${r.llmCalls} calls${r.rateLimitHits ? ` (${r.rateLimitHits}×429)` : ''}, ${(r.durationMs / 1000).toFixed(1)}s${r.pass ? '' : `  — ${r.summary.slice(0, 100).replace(/\n/g, ' ')}`}`);
      }
    }
  } finally {
    await server.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const meta = {
    mode: MODE,
    date: new Date().toISOString(),
    model: MODE === 'mock' ? 'scripted mock planner' : `${args.model ?? DEFAULT_MODEL} (Groq)`,
    tasks: String(tasks.length),
    trials: String(TRIALS),
  };
  const md = report(results, tasks, meta);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${stamp}-${MODE}.json`), JSON.stringify({ meta, results }, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, `latest-${MODE}.md`), md + '\n');
  console.log('\n' + md);

  if (MODE === 'mock') {
    // Mock runs are deterministic: every task should pass unless it has a knownIssue
    const surprises = tasks.filter(t => {
      const ok = results.filter(r => r.id === t.id).every(r => r.pass);
      return ok === Boolean(t.knownIssue);
    });
    if (surprises.length) {
      for (const t of surprises) {
        console.error(t.knownIssue
          ? `UNEXPECTED PASS: ${t.id} — remove its knownIssue ("${t.knownIssue}")`
          : `REGRESSION: ${t.id} failed in mock mode`);
      }
      process.exit(1);
    }
    console.log('\nMock run matches expectations.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
