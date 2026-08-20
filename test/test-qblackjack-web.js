#!/usr/bin/env node

// QuickBlackjack's three byte patches (lib/app-profiles.js) are what stop its
// animation loops from blocking the emulator. They used to be hand-copied into
// host.js and test/run.js separately, so the browser could silently lose one.
// This asserts the page applies all three and the app still runs.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { EXE_PATCHES } = require('../lib/app-profiles');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for QuickBlackjack browser test');
  process.exit(0);
}

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end(); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); return; }
      const types = {
        '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
        '.json': 'application/json', '.wasm': 'application/wasm',
      };
      response.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const expected = EXE_PATCHES['quickblackjack.exe'];
  assert(expected && expected.length === 3, 'expected three QuickBlackjack patches in the profile table');
  const server = await startStaticServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', msg => consoleLines.push(msg.text()));
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&qbj-web=${Date.now()}`, {
      waitUntil: 'load', timeout: 30000,
    });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="qblackjack"]'), { timeout: 15000 });
    await page.evaluate(async () => {
      document.getElementById('app-select').value = 'qblackjack';
      await launchApp();
      const app = runningApps.find(item => item && item.name === 'qblackjack');
      if (app) app.wine.stepsPerSlice = 100000;
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'qblackjack');
      return !!(app && app.wine.running && app.wine._runSliceCount >= 40);
    }, { timeout: 60000 });

    const patched = consoleLines.filter(line => line.startsWith('[compat] patched'));
    for (const patch of expected) {
      assert(patched.some(line => line.includes(patch.label)),
        `browser never applied "${patch.label}"\n${consoleLines.slice(-40).join('\n')}`);
    }
    assert(!patched.some(line => /cannot patch/.test(line)), patched.join('\n'));
    console.log(`PASS  browser applied all ${expected.length} QuickBlackjack compat patches`);
    const live = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'qblackjack');
      return !!(app && app.wine.running);
    });
    assert(live, 'QuickBlackjack stopped running after the patches');
    console.log('PASS  QuickBlackjack stays running in the browser');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
