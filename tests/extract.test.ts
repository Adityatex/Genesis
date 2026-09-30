import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extract, extractItems, formatExtraction, labelMatches } from '@/lib/agent/extract';
import { parseAgentAction } from '@/lib/agent/parseAction';

const FIXTURES = path.resolve(__dirname, '../eval/fixtures');
const BASE = 'https://shop.test/laptops/index.html';

/** A benchmark fixture page as a document, with links resolving against `base`. */
function fixture(file: string): Document {
  return new DOMParser().parseFromString(fs.readFileSync(path.join(FIXTURES, file), 'utf8'), 'text/html');
}

afterEach(() => vi.unstubAllGlobals());

describe('field names', () => {
  it('match labels by word and by synonym', () => {
    expect(labelMatches('Memory (RAM)', 'RAM')).toBe(true);
    expect(labelMatches('Memory (RAM)', 'memory')).toBe(true);
    expect(labelMatches('Unit cost', 'price')).toBe(true);
    expect(labelMatches('Amount', 'total')).toBe(true);
    expect(labelMatches('Storage', 'RAM')).toBe(false);
  });
});

describe('finding items', () => {
  it('reads a list of links with prices in the text', () => {
    const { kind, items } = extractItems(fixture('laptops/index.html'), ['name', 'price'], BASE, false);
    expect(kind).toBe('list');
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({ name: 'Aero 13', price: '$899', _link: 'https://shop.test/laptops/aero-13.html' });
    expect(items[3]).toMatchObject({ name: 'Kite 14', price: '$1,049' });
  });

  it('reads the details of a product page from its spec table', () => {
    const { kind, items } = extractItems(fixture('laptops/kite-14.html'), ['price', 'RAM', 'storage'], BASE, false);
    expect(kind).toBe('details');
    expect(items).toEqual([{ price: '$1,049', RAM: '16 GB', storage: '512 GB SSD' }]);
  });

  it('reads a table by its column headers', () => {
    const { kind, items } = extractItems(fixture('billing/invoices-1.html'), ['invoice', 'amount', 'status'], BASE, false);
    expect(kind).toBe('table');
    expect(items).toEqual([
      { invoice: 'INV-2031', amount: '$240.00', status: 'Paid' },
      { invoice: 'INV-2032', amount: '$120.00', status: 'Unpaid' },
      { invoice: 'INV-2033', amount: '$75.30', status: 'Paid' },
      { invoice: 'INV-2034', amount: '$89.50', status: 'Unpaid' },
    ]);
  });

  it("prefers a product's details to the site's menu", () => {
    const doc = new DOMParser().parseFromString(`
      <nav><a href="/">Home</a><a href="/deals">Deals</a><a href="/help">Help</a><a href="/account">Account</a></nav>
      <h1>Kite 14</h1><dl><dt>Price</dt><dd>$1,049</dd><dt>Memory</dt><dd>16 GB</dd></dl>`, 'text/html');
    const { kind, items } = extractItems(doc, ['price', 'RAM'], BASE, false);
    expect(kind).toBe('details');
    expect(items).toEqual([{ price: '$1,049', RAM: '16 GB' }]);
  });

  it('uses class names, and "Label: value" text inside cards', () => {
    const doc = new DOMParser().parseFromString(`<div>
      <div class="card"><h3>Trail Runner</h3><span class="price">$120</span><p>Rating: 4.5 out of 5</p></div>
      <div class="card"><h3>Road Racer</h3><span class="price">$95</span><p>Rating: 4.1 out of 5</p></div>
      <div class="card"><h3>Hill Climber</h3><span class="price">$140</span><p>Rating: 3.9 out of 5</p></div></div>`, 'text/html');
    const { kind, items } = extractItems(doc, ['name', 'price', 'rating'], BASE, false);
    expect(kind).toBe('list');
    expect(items.map((i) => [i.name, i.price, i.rating])).toEqual([
      ['Trail Runner', '$120', '4.5 out of 5'], ['Road Racer', '$95', '4.1 out of 5'], ['Hill Climber', '$140', '3.9 out of 5'],
    ]);
  });
});

describe('follow', () => {
  function serve(pages: Record<string, string>) {
    const fetchMock = vi.fn(async (url: string) => {
      const file = pages[new URL(url).pathname];
      return file
        ? new Response(fs.readFileSync(path.join(FIXTURES, file), 'utf8'), { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("reads each item's own page for fields the list doesn't show", async () => {
    const fetchMock = serve({
      '/laptops/aero-13.html': 'laptops/aero-13.html', '/laptops/nimbus-14.html': 'laptops/nimbus-14.html',
      '/laptops/vertex-15.html': 'laptops/vertex-15.html', '/laptops/kite-14.html': 'laptops/kite-14.html',
      '/laptops/pico-12.html': 'laptops/pico-12.html',
    });
    const doc = fixture('laptops/index.html');
    Object.defineProperty(doc, 'location', { value: new URL(BASE) });
    const result = await extract(['name', 'price', 'RAM'], { follow: true, root: doc });
    expect(result.followed).toBe(5);
    expect(result.items.map((i) => `${i.name} ${i.price} ${i.RAM}`)).toEqual([
      'Aero 13 $899 8 GB', 'Nimbus 14 $1,099 16 GB', 'Vertex 15 $1,249 32 GB', 'Kite 14 $1,049 16 GB', 'Pico 12 $749 8 GB',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(formatExtraction(['name', 'price', 'RAM'], result, 'laptops')).toBe([
      '📋 Extracted 5 laptops (list):',
      '1. name: Aero 13 | price: $899 | RAM: 8 GB | link: https://shop.test/laptops/aero-13.html',
      '2. name: Nimbus 14 | price: $1,099 | RAM: 16 GB | link: https://shop.test/laptops/nimbus-14.html',
      '3. name: Vertex 15 | price: $1,249 | RAM: 32 GB | link: https://shop.test/laptops/vertex-15.html',
      '4. name: Kite 14 | price: $1,049 | RAM: 16 GB | link: https://shop.test/laptops/kite-14.html',
      '5. name: Pico 12 | price: $749 | RAM: 8 GB | link: https://shop.test/laptops/pico-12.html',
      '(read 5 item pages for missing fields)',
    ].join('\n'));
  });

  it('never follows links to other sites or links that act (log out, delete, add to cart)', async () => {
    const fetchMock = serve({});
    const doc = new DOMParser().parseFromString(`<ul>
      <li><a href="https://evil.test/x">Other site</a></li>
      <li><a href="/account/logout">Log out</a></li>
      <li><a href="/items/9/delete">Delete item</a></li>
      <li><a href="/cart/add?id=3">Add</a></li></ul>`, 'text/html');
    Object.defineProperty(doc, 'location', { value: new URL(BASE) });
    await extract(['name', 'RAM'], { follow: true, root: doc });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts pages that could not be read', async () => {
    serve({}); // every page 404s
    const doc = fixture('laptops/index.html');
    Object.defineProperty(doc, 'location', { value: new URL(BASE) });
    const result = await extract(['name', 'RAM'], { follow: true, root: doc });
    expect(result).toMatchObject({ followed: 0, followFailed: 5 });
    expect(formatExtraction(['name', 'RAM'], result)).toContain("5 item pages couldn't be read");
  });
});

describe('the extract action', () => {
  it('needs fields, as a list or comma-separated', () => {
    expect(parseAgentAction('{"action":"extract","text":"laptops"}')).toMatchObject({ ok: false, error: expect.stringContaining('extract requires fields') });
    expect(parseAgentAction('{"action":"extract","text":"laptops","fields":"name, price","follow":true}'))
      .toEqual({ ok: true, action: { action: 'extract', text: 'laptops', fields: ['name', 'price'], follow: true } });
  });

  it('says so when nothing matches', () => {
    expect(formatExtraction(['price'], { kind: 'none', items: [], followed: 0, followFailed: 0 }, 'laptops'))
      .toBe('❌ Found no laptops with price on this page. Try read, or open a page that lists them.');
  });
});
