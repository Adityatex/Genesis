// eval/server.mts
// Static server for the fixture pages. Every request under /api/ is recorded
// so tasks are graded on what the agent actually did, not on what it claims.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface RecordedEvent {
  method: string;
  path: string;
  /** Query-string params merged with the form/JSON body. */
  data: Record<string, unknown>;
}

export interface FixtureServer {
  baseUrl: string;
  events: RecordedEvent[];
  reset(): void;
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const events: RecordedEvent[] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      const data = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
      events.push({ method: req.method || 'GET', path: url.pathname, data });
      // /api/slow/* simulates a slow backend: the old page stays alive while it waits
      if (url.pathname.startsWith('/api/slow/')) await new Promise(r => setTimeout(r, 2500));

      if ((req.headers['content-type'] || '').includes('application/json')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } else {
        // A regular form submission / link: land on a confirmation page
        const summary = Object.entries(data).map(([k, v]) => `<li>${k}: ${String(v)}</li>`).join('');
        res.writeHead(200, { 'content-type': 'text/html' })
          .end(page('Request received', `<p>Your request to ${url.pathname} was received.</p><ul>${summary}</ul>`));
      }
      return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(FIXTURES, rel));
    if (!file.startsWith(FIXTURES)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end(page('Page not found', `<p>${url.pathname} does not exist.</p>`));
    }
  });

  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const { port: actualPort } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    events,
    reset: () => { events.length = 0; },
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
