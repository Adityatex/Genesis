// eval/history-e2e.mts
// End-to-end check of the run timeline (lib/agent/timeline.ts) and the
// History page. A fake model signs in on a test page (typing a password),
// then says done. The run must be saved, listed, and shown step by step
// with its model calls and token counts, the password masked everywhere,
// including the Markdown export and the side panel's steps. "See the full
// timeline" in the panel must open the page at that run, and Delete must
// remove it. No real model or API key is involved.
//
//   npm run build && npm run eval:history   (-- --headed to watch)

import { chromium, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';
import { openPanel, runState, sendTask } from './panel.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const MODEL = 'https://mock-llm.test/v1';
const PASSWORD = 'tr4il-RUNNER-secret';
const GOAL = 'Sign in as demo';
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

/** A chat completion that reports token usage, like real providers do. */
const answer = (content: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }),
});

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-history-e2e-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-history-dl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    downloadsPath: downloads,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false },
    }), MODEL);

    // The fake model: fill the sign-in form, then finish
    let calls = 0;
    await context.route(`${MODEL}/**`, async (route: Route) => {
      calls++;
      const prompt = String(route.request().postDataJSON()?.messages?.at(-1)?.content ?? '');
      if (calls > 1) return route.fulfill(answer('{"action":"done","summary":"Signed in as demo."}'));
      const id = (re: RegExp) => Number(re.exec(prompt)?.[1]);
      return route.fulfill(answer(JSON.stringify({ actions: [
        { action: 'type', elementId: id(/\[(\d+)\][^\n]*"Username"/), text: 'demo' },
        { action: 'type', elementId: id(/\[(\d+)\][^\n]*type="password"/), text: PASSWORD },
        { action: 'click', elementId: id(/\[(\d+)\] <button>[^\n]*"Sign in"/) },
      ] })));
    });

    // 1. A run from the side panel
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/login.html`);
    const panel = await openPanel(context, worker, page);
    await sendTask(panel, GOAL);
    await panel.locator('[data-run-status="done"]').waitFor({ timeout: 30_000 });
    // The steps the panel shows (in the stream while it runs; the done screen sums up instead)
    const steps = ((await runState(panel))?.steps ?? []).map((st: any) => st.action).join(' | ');
    check('the panel has the steps in plain words, password hidden',
      steps.includes('Typed a password into “Password”') && steps.includes('Clicked “Sign in”') && !steps.includes(PASSWORD) && !(await panel.content()).includes(PASSWORD), steps.slice(0, 400));

    // 2. It's saved
    let stored: any[] = [];
    for (let i = 0; i < 20 && !stored.some((r) => r.ended); i++) {
      if (i) await page.waitForTimeout(250);
      stored = (await worker.evaluate(() => chrome.storage.local.get('tabi_runs')) as any).tabi_runs ?? [];
    }
    const run = stored[0];
    check('the run is saved when it ends', stored.length === 1 && run?.goal === GOAL && run?.status === 'done' && !!run?.ended, JSON.stringify(stored).slice(0, 300));
    check('with its model calls and tokens', run?.calls === 2 && run?.tokens === 2560, `calls ${run?.calls}, tokens ${run?.tokens}`);
    check('and the password masked', !JSON.stringify(stored).includes(PASSWORD) && JSON.stringify(stored).includes('••••'));

    // 3. The History page, from "See the full timeline" in the panel
    const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/history.html') });
    await panel.getByRole('button', { name: 'See the full timeline' }).click();
    const history = await opened;
    await history.waitForLoadState();
    check('it opens at that run', history.url().endsWith(`/history.html#${run?.id}`), history.url());
    await history.locator('.detail h2').waitFor({ timeout: 10_000 });
    check('the run is listed and shown', (await history.locator('.run-item').count()) === 1 && (await history.locator('.detail h2').innerText()) === GOAL);
    const text = await history.locator('.timeline').innerText();
    check('the timeline shows the model calls, the steps and the end',
      (await history.locator('.entry.kind-model').count()) === 2 && (await history.locator('.entry.kind-step').count()) >= 3
        && text.includes('1,280 tokens') && text.includes('Finished'),
      text.slice(0, 600));
    check('steps say what they acted on, by its label', text.includes('on "Password"') && text.includes('on "Sign in"'), text.slice(0, 600));
    check('the page never shows the password',!(await history.content()).includes(PASSWORD));

    // --screenshot: save what the page looks like (eval/results/history.png)
    if (process.argv.includes('--screenshot')) {
      fs.mkdirSync(path.join(ROOT, 'eval', 'results'), { recursive: true });
      await history.screenshot({ path: path.join(ROOT, 'eval', 'results', 'history.png'), fullPage: true });
    }

    // 4. Export as Markdown
    const download = history.waitForEvent('download');
    await history.getByRole('button', { name: 'Export' }).click();
    const file = await (await download).path();
    const md = file ? fs.readFileSync(file, 'utf8') : '';
    check('Export saves the run as Markdown, password masked', md.startsWith(`# Tabi run: ${GOAL}`) && md.includes('2 model calls') && !md.includes(PASSWORD), md.slice(0, 300));

    // 5. Delete
    await history.getByRole('button', { name: 'Delete', exact: true }).click();
    await history.getByText('No runs yet.').waitFor({ timeout: 5_000 }).catch(() => {});
    const left = (await worker.evaluate(() => chrome.storage.local.get('tabi_runs')) as any).tabi_runs ?? [];
    check('Delete removes it', left.length === 0 && await history.getByText('No runs yet.').isVisible(), JSON.stringify(left).slice(0, 200));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll run history checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
