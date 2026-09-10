#!/usr/bin/env node
'use strict';

// Real OPFS and Web Locks across two same-origin tabs. This exercises the
// browser storage implementation without booting an unrelated guest program.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function startServer() {
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/lib/overlay-store.js') {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(ROOT, 'lib/overlay-store.js')));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function preparePage(browser, base) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/__overlay-store-test__.html') {
      void request.respond({ status: 200, contentType: 'text/html',
        body: '<!doctype html><script src="/lib/overlay-store.js"></script>' });
    } else void request.continue();
  });
  await page.goto(new URL('/__overlay-store-test__.html', base).href, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.OverlayStore);
  assert(await page.evaluate(() => !!navigator.storage.getDirectory && !!navigator.locks),
    'the browser must provide real OPFS and Web Locks');
  return page;
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.log('SKIP Chrome not found for OPFS browser test');
    return;
  }
  const server = process.env.BASE_URL ? null : await startServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const scope = 'test-' + crypto.randomUUID();
  let browser;
  let first;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--no-first-run', '--disable-gpu'] });
    const pages = await Promise.all([preparePage(browser, base), preparePage(browser, base)]);
    [first] = pages;
    await Promise.all(pages.map(page => page.evaluate(async scope => {
      window.overlay = OverlayStore.opfsStore(scope);
      await window.overlay.list(); // Both stores see the same empty index first.
    }, scope)));

    await Promise.all(pages.map((page, tab) => page.evaluate(async tab => {
      for (let i = 0; i < 12; i++) {
        await window.overlay.writeBatch([{
          path: `c:\\tab-${tab}\\save-${i}`, kind: 'file',
          data: new TextEncoder().encode(`tab=${tab};save=${i};payload`),
        }]);
      }
    }, tab)));

    // Two additional stores in one tab exercise the same-origin instance
    // case separately from independent JS realms in different tabs.
    await first.evaluate(async scope => {
      const a = OverlayStore.opfsStore(scope), b = OverlayStore.opfsStore(scope);
      await Promise.all([a.list(), b.list()]);
      await Promise.all([a, b].map((store, i) => store.writeBatch([{
        path: `c:\\same-tab-${i}`, kind: 'file', data: Uint8Array.of(20 + i),
      }])));
    }, scope);

    for (const page of pages) {
      await page.reload({ waitUntil: 'load' });
      const snapshot = await page.evaluate(async scope => {
        const store = OverlayStore.opfsStore(scope);
        const records = await store.readSnapshot();
        const readbacks = [];
        for (const record of records) {
          if (record.readError) throw record.readError;
          const reopened = await store.read(record.path);
          readbacks.push({ path: record.path, size: record.size,
            data: Array.from(record.data), reopened: Array.from(reopened) });
        }
        return readbacks;
      }, scope);
      assert.strictEqual(snapshot.length, 26, 'different writers must preserve every record');
      for (const record of snapshot) {
        const match = /tab-(\d)\\save-(\d+)$/.exec(record.path);
        const expected = match
          ? [...Buffer.from(`tab=${match[1]};save=${match[2]};payload`)]
          : [20 + Number(record.path.slice(-1))];
        assert.deepStrictEqual(record.data, expected, `snapshot corruption: ${record.path}`);
        assert.deepStrictEqual(record.reopened, expected, `read corruption: ${record.path}`);
        assert.strictEqual(record.size, expected.length);
      }
    }
    console.log('PASS real Chrome OPFS: concurrent two-tab and same-tab stores preserve 26 files across reload and eager snapshot reads');
  } finally {
    try {
      if (first && !first.isClosed()) {
        await first.evaluate(scope => OverlayStore.removeOpfsScope(scope), scope);
      }
    } finally {
      if (browser) await browser.close();
      if (server) await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
