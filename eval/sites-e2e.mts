// eval/sites-e2e.mts
// End-to-end check of the user's site lists (lib/agent/sites.ts). The test
// pages are served on two sites: 127.0.0.1 and localhost. Through the popup,
// localhost goes on the block list; a fake model then tries to go there and
// must be refused without anything loading, and a task started on a localhost
// page must stop before the model sees it. Then, with an allow list that
// doesn't have 127.0.0.1, a task there must ask first. No real model or API key.
//
//   npm run build && npm run eval:sites   (-- --headed to watch)

import { chromium, type Page, type Route } from 'playwright';
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

const answer = (content: string) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
});

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) throw new Error('Build the extension first: npm run build');
  const fixtures = await startFixtureServer();
  const other = fixtures.baseUrl.replace('127.0.0.1', 'localhost');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabi-sites-e2e-'));
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
      tabi_prefs: { trustedInput: false },
    }), MODEL);

    // The fake model: go to the other site; once refused, finish
    const prompts: string[] = [];
    await context.route(`${MODEL}/**`, async (route: Route) => {
      const prompt = String(route.request().postDataJSON()?.messages?.at(-1)?.content ?? '');
      prompts.push(prompt);
      if (prompt.includes('⛔ not run')) return route.fulfill(answer('{"action":"done","summary":"Could not go there."}'));
      return route.fulfill(answer(JSON.stringify({ action: 'navigate', url: `${other}/search.html` })));
    });
    const loads: string[] = [];
    context.on('request', (r) => { if (r.url().startsWith(other)) loads.push(r.url()); });

    // 1. The popup: a bad entry is refused, a good one is saved
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    const blockInput = popup.locator('input[placeholder="mybank.com"]');
    await blockInput.fill('not a site');
    await blockInput.press('Enter');
    const refused = await popup.locator('.message.error').waitFor({ timeout: 5_000 }).then(() => popup.locator('.message.error').innerText()).catch(() => '');
    check("the popup refuses something that isn't a site", refused.includes("isn't a site"), refused || 'no error shown');
    await blockInput.fill(`${other}/anything`);
    await blockInput.press('Enter');
    await popup.getByText('localhost', { exact: true }).waitFor({ timeout: 5_000 }).catch(() => {});
    const stored: any = await worker.evaluate(() => chrome.storage.local.get('tabi_sites'));
    check('the popup blocks a site typed as a full address', JSON.stringify(stored.tabi_sites?.blocked) === '["localhost"]', JSON.stringify(stored));

    // 2. The agent won't go to the blocked site
    const page = await context.newPage();
    const run = async (p: Page, goal: string) => {
      await p.locator('[title="Open Tabi"]').click({ timeout: 15_000 });
      await p.locator('textarea[placeholder^="Describe action"]').fill(goal);
      await p.keyboard.press('Enter');
    };
    const outcome = (p: Page) => p.locator('.markdown-body', { hasText: /Task Complete|Stopped/ }).first();
    await page.goto(`${fixtures.baseUrl}/search.html`);
    await run(page, 'Go to the other search page');
    await outcome(page).waitFor({ timeout: 20_000 });
    check("a blocked site isn't opened", loads.length === 0 && page.url().startsWith(fixtures.baseUrl), `${page.url()} ${JSON.stringify(loads)}`);
    check('the model is told why', prompts.some((p) => p.includes("⛔ not run: localhost is on the user's block list")), prompts.at(-1)?.slice(-400));

    // 3. A task started on a blocked site stops before the model sees the page
    const before = prompts.length;
    const blocked = await context.newPage();
    await blocked.goto(`${other}/search.html`);
    await run(blocked, 'Search for headphones');
    await outcome(blocked).waitFor({ timeout: 20_000 });
    const text = await outcome(blocked).innerText();
    check('a task on a blocked site stops', text.includes('which is on your block list, so it stopped without reading the page'), text.slice(0, 300));
    check('and the model never sees that page', prompts.length === before, `${prompts.length - before} model calls`);

    // 4. With an allow list that doesn't have this site, the agent asks first
    await worker.evaluate(() => chrome.storage.local.set({ tabi_sites: { blocked: [], allowed: ['example.com'] } }));
    const unlisted = await context.newPage();
    await unlisted.goto(`${fixtures.baseUrl}/search.html`);
    await run(unlisted, 'Search for headphones');
    const asking = unlisted.locator('[data-asking]');
    await asking.waitFor({ timeout: 20_000 });
    check('a site off the allow list needs your OK', (await asking.getAttribute('data-risk')) === 'unlisted' && (await asking.innerText()).includes("127.0.0.1 isn't on your list of allowed sites"),
      await asking.innerText());
    await unlisted.getByRole('button', { name: "Don't allow" }).click();
    await outcome(unlisted).waitFor({ timeout: 20_000 });
    check("Don't allow stops the task", (await outcome(unlisted).innerText()).includes("You didn't allow the agent to work on 127.0.0.1."));
  } finally {
    await context.close().catch(() => {});
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll site list checks passed.');
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
