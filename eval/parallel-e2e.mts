// eval/parallel-e2e.mts
// End-to-end check of parallel tasks: from the sidebar, "Run in background"
// three times with at most 2 tasks at once. A fake model answers each call
// after 2 seconds, so the tasks overlap. Checks the limit holds (never more
// than 2 model calls at once, the third waits), every task finishes in its own
// background tab in a "Tabi" group, the user's tab stays in front, and each
// task ends with a notification. No real model or API key is involved.
//
//   npm run build && npm run eval:parallel   (-- --headed to watch)

import { chromium, type Route } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mts';

declare const chrome: any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const MODEL = 'https://mock-llm.test/v1';
const headed = process.argv.includes('--headed');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-parallel-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await worker.evaluate((base) => chrome.storage.local.set({
      tabi_llm: { provider: 'custom', models: { custom: 'mock' }, keys: { custom: 'k' }, customBaseUrl: base },
      tabi_prefs: { trustedInput: false, maxParallel: 2 },
    }), MODEL);

    // The fake model: 2 seconds per answer, counting how many calls overlap
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    await context.route(`${MODEL}/**`, async (route: Route) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2000));
      inFlight--;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"action":"done","summary":"Read the page"}' } }] }),
      }).catch(() => {});
    });

    // The popup's task list, open before the tasks start so it sees the waiting one
    const extensionId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const listTasks = () => popup.evaluate(() => chrome.runtime.sendMessage({ action: 'LIST_TASKS' })) as Promise<any>;
    let sawQueued = false;
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const tasks = (await listTasks().catch(() => null))?.data ?? [];
        if (tasks.some((t: any) => t.status === 'queued')) sawQueued = true;
        await new Promise((r) => setTimeout(r, 100));
      }
    })();

    // The user's page, with the sidebar open
    const page = await context.newPage();
    await page.goto(`${fixtures.baseUrl}/search.html`);
    await page.locator('[title="Open Tabi"]').click({ timeout: 15_000 });
    const box = page.locator('textarea[placeholder^="Describe action"]');
    for (const goal of ['Summarise this page', 'Find the search box', 'Read the page title']) {
      await box.fill(goal);
      await page.getByRole('button', { name: 'Run in background' }).click();
      await page.waitForTimeout(150);
    }

    // Wait for all three to finish
    let tasks: any[] = [];
    for (let i = 0; i < 60; i++) {
      tasks = (await listTasks())?.data ?? [];
      if (tasks.length >= 3 && tasks.every((t) => t.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    watching = false;
    await watch;

    check('three tasks start from "Run in background"', tasks.length === 3, JSON.stringify(tasks.map((t) => t.goal)));
    check('all three finish', tasks.length === 3 && tasks.every((t) => t.status === 'done'), JSON.stringify(tasks.map((t) => t.status)));
    check('never more than 2 use the model at once', maxInFlight === 2, `max in flight ${maxInFlight}`);
    check('the third waits in line until a slot frees up', sawQueued, 'never saw a queued task');
    check('each task called the model', calls === 3, `${calls} calls`);

    const groups: any[] = await worker.evaluate(() => chrome.tabGroups.query({}));
    const grouped: any[] = await worker.evaluate(() => chrome.tabs.query({ groupId: -1 }).then(() => chrome.tabs.query({})));
    const group = groups.find((g) => g.title === 'Tabi');
    const inGroup = grouped.filter((t) => group && t.groupId === group.id);
    check('their tabs are grouped as "Tabi"', !!group && inGroup.length === 3, `groups ${JSON.stringify(groups)}, ${inGroup.length} tabs in it`);
    const active: any[] = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
    check('the user stays on their own page', active[0]?.url?.includes('/search.html'), active[0]?.url);
    const notes: Record<string, unknown> = await worker.evaluate(() => new Promise((resolve) => chrome.notifications.getAll(resolve)));
    check('each finished task notifies, linking to its timeline', Object.keys(notes).filter((k) => k.startsWith('tabi-run:')).length === 3, JSON.stringify(Object.keys(notes)));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll parallel task checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
