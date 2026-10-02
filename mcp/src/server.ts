#!/usr/bin/env node
// mcp/src/server.ts
// tabi-mcp: an MCP server that lets an AI app you already use (Claude Code,
// Claude Desktop, Codex, ...) drive your real browser through the Tabi
// extension. The model runs inside that app, on your plan with it; Tabi
// supplies the eyes and hands: page snapshots with numbered elements, real
// clicks and typing, Shadow DOM and iframes, screenshots.
//
//   tabi-mcp             run the MCP server (your AI app starts this)
//   tabi-mcp token       show the pairing token to paste into Tabi
//   tabi-mcp new-token   make a new token (the old one stops working)
//
// genesis-mcp (src/genesis-mcp.ts) is the old name, kept for one release.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ExtensionBridge } from './bridgeServer.js';
import { DEFAULT_PORT, isValidToken, newToken, normalizeToken } from './protocol.js';

const TOKEN_FILE = path.join(os.homedir(), '.tabi-mcp', 'token');
/** Where genesis-mcp kept the token before the rename; read for one more release. */
const OLD_TOKEN_FILE = path.join(os.homedir(), '.genesis-mcp', 'token');

/** Notes for people go to stderr: stdout carries the MCP protocol. */
const note = (msg: string) => console.error(`[tabi-mcp] ${msg}`);

/** TABI_MCP_<name>, or its name before the rename (GENESIS_MCP_<name>) for one more release. */
function setting(name: 'TOKEN' | 'PORT'): string | undefined {
  const value = process.env[`TABI_MCP_${name}`];
  if (value) return value;
  const old = process.env[`GENESIS_MCP_${name}`];
  if (old) note(`GENESIS_MCP_${name} is now TABI_MCP_${name}. The old name stops working in the next release.`);
  return old;
}

function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

/** The pairing token: TABI_MCP_TOKEN, or the one saved in ~/.tabi-mcp (made on first use). */
export function loadToken(fresh = false): string {
  const fromEnv = setting('TOKEN');
  if (fromEnv && isValidToken(fromEnv)) return normalizeToken(fromEnv);
  if (!fresh) {
    for (const file of [TOKEN_FILE, OLD_TOKEN_FILE]) {
      if (!fs.existsSync(file)) continue;
      const saved = fs.readFileSync(file, 'utf8');
      if (!isValidToken(saved)) continue;
      const token = normalizeToken(saved);
      // A token from before the rename moves to ~/.tabi-mcp; it still pairs with the one in the extension
      if (file === OLD_TOKEN_FILE) {
        saveToken(token);
        note(`Moved your pairing token from ${OLD_TOKEN_FILE} to ${TOKEN_FILE}.`);
      }
      return token;
    }
  }
  const token = newToken();
  saveToken(token);
  return token;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (err: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(err as Error)?.message ?? err}` }], isError: true });

const tabId = z.number().int().optional().describe('Tab to use; defaults to the tab Tabi is working in (the last one opened or selected, else the active tab)');

const action = z.object({
  action: z.enum(['click', 'type', 'clear_and_type', 'select', 'navigate', 'scroll', 'press_key', 'read', 'find', 'extract', 'note', 'wait']),
  elementId: z.number().int().optional().describe('Element ID from the latest browser_snapshot, e.g. 12 for [12]'),
  text: z.string().optional().describe('Text to type, words to find, or milliseconds to wait'),
  value: z.string().optional().describe('Option label, for select'),
  url: z.string().optional().describe('Full http(s) URL, for navigate'),
  direction: z.enum(['up', 'down']).optional(),
  key: z.string().optional().describe('Key for press_key: Enter, Tab, Escape, ArrowDown, ...'),
  fields: z.array(z.string()).optional().describe('For extract: fields to collect from the list, table or details on the page, e.g. ["name", "price"]'),
  follow: z.boolean().optional().describe('For extract: also read the page of each listed item (same site, read-only) for missing fields'),
});

/** The MCP tools, answered by the extension over `bridge`. */
export function createServer(bridge: Pick<ExtensionBridge, 'request'>): McpServer {
  const server = new McpServer(
    { name: 'tabi', version: '0.1.0' },
    {
      instructions:
        'Tabi controls the user\'s real Chrome browser (their tabs, their logins). To work on a page: call browser_snapshot '
        + 'to see it, with every interactive element numbered like [12]; then browser_act with those IDs. Element IDs change '
        + 'on every snapshot, so take a new one after anything that changes the page. Several actions can go in one '
        + 'browser_act call (e.g. fill a whole form, then submit last). browser_screenshot shows the page with the same '
        + 'numbers drawn on it. browser_run_task hands a whole task to Tabi\'s own agent instead. Ask the user before '
        + 'anything irreversible, such as paying, sending, deleting or posting.',
    },
  );

  server.registerTool('browser_tabs', {
    title: 'List tabs',
    description: 'List the open browser tabs, with their IDs, titles and URLs, and which one Tabi is working in.',
    annotations: { readOnlyHint: true },
  }, async () => {
    try { return text(JSON.stringify(await bridge.request('tabs_list'), null, 2)); } catch (e) { return failure(e); }
  });

  server.registerTool('browser_open', {
    title: 'Open a URL',
    description: 'Open a URL, in a new tab by default, and make it the tab Tabi works in. Waits for the page to load.',
    inputSchema: { url: z.string().describe('Full http(s) URL'), newTab: z.boolean().optional().describe('Default true') },
  }, async ({ url, newTab }) => {
    try { return text(String(await bridge.request('tab_open', { url, newTab: newTab ?? true }))); } catch (e) { return failure(e); }
  });

  server.registerTool('browser_select_tab', {
    title: 'Switch tab',
    description: 'Make a tab (from browser_tabs) the one Tabi works in, and bring it to the front.',
    inputSchema: { tabId: z.number().int() },
  }, async ({ tabId: id }) => {
    try { return text(String(await bridge.request('tab_select', { tabId: id }))); } catch (e) { return failure(e); }
  });

  server.registerTool('browser_snapshot', {
    title: 'Read the page',
    description: 'The page as text: title, URL, headings, every interactive element with a numbered ID (including inside iframes and Shadow DOM), and the visible text. Use the IDs with browser_act.',
    inputSchema: { tabId },
    annotations: { readOnlyHint: true },
  }, async ({ tabId: id }) => {
    try { return text(String(await bridge.request('page_snapshot', { tabId: id }))); } catch (e) { return failure(e); }
  });

  server.registerTool('browser_act', {
    title: 'Act on the page',
    description: 'Run 1 to 10 actions in order, with real mouse and keyboard input: click, type, clear_and_type, select (dropdowns, native or custom), navigate, scroll, press_key, read, find (search every element, including ones the snapshot left out), note, wait. Stops early if an action fails or the page changes. Returns what each action did.',
    inputSchema: { tabId, actions: z.array(action).min(1).max(10) },
  }, async ({ tabId: id, actions }) => {
    try { return text(String(await bridge.request('page_act', { tabId: id, actions }))); } catch (e) { return failure(e); }
  });

  server.registerTool('browser_screenshot', {
    title: 'Screenshot',
    description: 'A screenshot of the visible part of the page, with each interactive element boxed and labelled with its browser_snapshot ID.',
    inputSchema: { tabId },
    annotations: { readOnlyHint: true },
  }, async ({ tabId: id }) => {
    try {
      const url = String(await bridge.request('page_screenshot', { tabId: id }));
      const m = /^data:(image\/\w+);base64,(.*)$/.exec(url);
      if (!m) return failure(new Error('The browser returned no image'));
      return { content: [{ type: 'image' as const, data: m[2], mimeType: m[1] }] };
    } catch (e) { return failure(e); }
  });

  server.registerTool('browser_run_task', {
    title: 'Hand a task to Tabi',
    description: 'Give a whole task in plain words to Tabi\'s own agent, which plans and acts by itself using the model set up in Tabi (not yours), and returns its result. Useful for long, routine web chores.',
    inputSchema: { goal: z.string(), tabId },
  }, async ({ goal, tabId: id }) => {
    try { return text(String(await bridge.request('run_task', { goal, tabId: id }, 15 * 60_000))); } catch (e) { return failure(e); }
  });

  return server;
}

function setupHelp(token: string): string {
  const script = fileURLToPath(import.meta.url);
  return [
    'Tabi pairing token:',
    '',
    `  ${token}`,
    '',
    'In Chrome: open the Tabi popup, turn on "Let AI apps control this browser" and paste the token.',
    '',
    'Then add tabi-mcp to your AI app, e.g.:',
    `  Claude Code:     claude mcp add tabi -- node "${script}"`,
    `  Claude Desktop:  "mcpServers": { "tabi": { "command": "node", "args": ["${script.replace(/\\/g, '\\\\')}"] } }`,
    `  Codex:           codex mcp add tabi -- node "${script}"`,
  ].join('\n');
}

/** How to switch a setup made before the rename, for the genesis-mcp command. */
export function renameNote(): string {
  const script = fileURLToPath(import.meta.url);
  return 'genesis-mcp is now tabi-mcp. This name keeps working until the next release. '
    + `To switch, add it to your AI app as "tabi" and remove "genesis", e.g. in Claude Code: claude mcp add tabi -- node "${script}"`;
}

export async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'token' || command === 'new-token') {
    console.log(setupHelp(loadToken(command === 'new-token')));
    return;
  }
  const port = Number(setting('PORT')) || DEFAULT_PORT;
  const bridge = new ExtensionBridge(loadToken(), port, note);
  try {
    await bridge.start();
    note(`Waiting for the Tabi extension on 127.0.0.1:${port}.`);
  } catch (err) {
    // Still serve MCP, so the AI app gets a clear error from each tool
    note((err as Error).message);
  }
  await createServer(bridge).connect(new StdioServerTransport());
}

// Run when started as a program, not when imported (tests)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    note(err?.stack ?? String(err));
    process.exit(1);
  });
}
