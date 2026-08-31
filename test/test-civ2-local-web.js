#!/usr/bin/env node
'use strict';

// Real-browser launch regression for the two local Civilization II recipes.
// Their CLI smoke does not exercise the browser-hosted main-thread Worker,
// which is where both reported launch failures occurred.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = String(process.env.CIV2_WEB_APP || '').trim();
const DIAGNOSTIC = process.env.CIV2_WEB_DIAGNOSTIC === '1';
const WAIT_MS = Number(process.env.CIV2_WEB_WAIT_MS || 45000);
const THREADED = process.env.CIV2_WEB_THREADS !== '0';
const CASES = [
  {
    id: 'civ2_win16',
    exe: 'test/binaries/candidates/civilization-2-win16/cd/CIV2/CIV2.EXE',
    startupClass: 'MSWindowClass',
  },
  {
    id: 'civ2_mge',
    exe: 'test/binaries/candidates/civilization-2-mge-win32/installed/civ2.exe',
    title: /Civilization II Multiplayer Gold/i,
  },
].filter(item => !ONLY || item.id === ONLY);

if (!fs.existsSync(CHROME)) {
  console.log('SKIP Chrome not found for Civilization II browser test');
  process.exit(0);
}
if (!CASES.length) throw new Error(`unknown CIV2_WEB_APP ${ONLY}`);
if (CASES.some(item => !fs.existsSync(path.join(ROOT, item.exe)))) {
  console.log('SKIP local Civilization II payloads are not present');
  process.exit(0);
}

const MIME = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.wasm': 'application/wasm',
};

function startServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end('forbidden'); return;
    }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        response.writeHead(404); response.end('not found'); return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      fs.createReadStream(file).pipe(response).on('error', () => response.destroy());
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function snapshot(page, appId) {
  return page.evaluate(id => {
    const app = runningApps.find(item => item && item.name === id);
    const log = document.getElementById('log');
    return {
      running: !!(app && app.wine && app.wine.running),
      worker: !!(app && app.wine && app.wine.guestWorker),
      eip: app && app.wine && app.wine.instance && app.wine.instance.exports.get_eip
        ? app.wine.instance.exports.get_eip() >>> 0 : 0,
      windows: Object.values(sharedRenderer.windows || {})
        .filter(Boolean)
        .map(win => ({
          hwnd: win.hwnd >>> 0, title: win.title || '', className: win.className || '',
          parent: win.parentHwnd >>> 0, visible: !!win.visible, enabled: win.enabled !== false,
          x: win.x | 0, y: win.y | 0, width: win.width | 0, height: win.height | 0,
        })),
      log: log ? log.textContent.slice(-6000) : '',
    };
  }, appId);
}

async function runCase(browser, baseUrl, spec) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push((error && error.stack) || String(error)));
  page.on('console', message => {
    const text = message.text();
    if (DIAGNOSTIC &&
        /\[API\]|\[threads\]|\[win16\]|\[fs\]|\[FS\]|CreateWindow|MessageBox|UNIMPLEMENTED|RuntimeError|trap/i.test(text)) {
      console.log(`[${spec.id}] ${text}`);
    }
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:|guest trapped/i.test(text)) {
      problems.push(text);
    }
  });
  await page.setViewport({ width: 1100, height: 820, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(diagnostic => {
    localStorage.removeItem('wine-assembly.threads');
    if (diagnostic) globalThis.__waTraceCategories = new Set(['fs', 'win16']);
  }, DIAGNOSTIC);
  await page.goto(`${baseUrl}/index.html?debug&no-log&civ2-web=${Date.now()}`,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(id => typeof launchApp === 'function' &&
    document.querySelector(`#app-select option[value="${id}"]`),
  { timeout: 30000 }, spec.id);
  assert(await page.evaluate(() => crossOriginIsolated),
    'Civilization II test server must be cross-origin isolated');

  await page.evaluate(async ({ id, threaded }) => {
    const box = document.getElementById('threads-toggle');
    box.checked = threaded;
    await setThreads(threaded);
    document.getElementById('app-select').value = id;
    launchApp();
  }, { id: spec.id, threaded: THREADED });
  await page.waitForFunction(id => runningApps.some(item => item && item.name === id &&
    item.wine && item.wine.instance), { timeout: 90000 }, spec.id);

  // MGE's opening Heralds controller exposes three owner-drawn MSControlClass
  // children. The bottom control is the same one the reported browser launch
  // clicked before the real game window was created. Win16's corresponding
  // controls are its now-working language selector, which is the success
  // boundary for the reported resource-loader failure.
  if (spec.id === 'civ2_mge') {
    await page.waitForFunction(() => Object.values(sharedRenderer.windows || {})
      .filter(win => win && win.className === 'MSControlClass').length >= 3,
    { timeout: 30000 });
    await page.evaluate(() => {
      const controls = Object.values(sharedRenderer.windows || {})
        .filter(win => win && win.className === 'MSControlClass')
        .sort((a, b) => (a.y | 0) - (b.y | 0));
      const target = controls[controls.length - 1];
      for (const event of [
        { type: 'mouse', hwnd: target.hwnd, msg: 0x0084, wParam: 0, lParam: 0 },
        { type: 'mouse', hwnd: target.hwnd, msg: 0x0201, wParam: 1, lParam: 0 },
        { type: 'mouse', hwnd: target.hwnd, msg: 0x0202, wParam: 0, lParam: 0 },
      ]) sharedRenderer.inputQueue.push(event);
      sharedRenderer._wakeMessageWait();
    });
  }

  try {
    await page.waitForFunction(({ id, title, startupClass, expectWorker }) => {
      const app = runningApps.find(item => item && item.name === id);
      const titleRe = title ? new RegExp(title, 'i') : null;
      return !!(app && app.wine && app.wine.running &&
        (!expectWorker || app.wine.guestWorker) &&
        Object.values(sharedRenderer.windows || {}).some(win => win && win.visible &&
          (startupClass ? win.className === startupClass : titleRe.test(win.title || ''))));
    }, { timeout: WAIT_MS, polling: 200 }, {
      id: spec.id, title: spec.title ? spec.title.source : '',
      startupClass: spec.startupClass || '', expectWorker: THREADED,
    });
  } catch (error) {
    const state = await snapshot(page, spec.id);
    console.error(`[${spec.id}] failed state:\n${JSON.stringify(state, null, 2)}`);
    throw error;
  }

  const state = await snapshot(page, spec.id);
  assert.strictEqual(state.running, true, `${spec.id} stopped after creating its window`);
  assert.strictEqual(state.worker, THREADED,
    `${spec.id} did not use the requested execution backend`);
  assert(state.windows.some(win => spec.startupClass
    ? win.visible && win.className === spec.startupClass
    : spec.title.test(win.title)),
  `${spec.id} did not reach its startup window: ${JSON.stringify(state.windows)}`);
  assert.strictEqual(problems.length, 0, `${spec.id} browser failures:\n${problems.join('\n')}`);
  await page.close();
  return state;
}

(async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    for (const spec of CASES) await runCase(browser, baseUrl, spec);
    console.log(`PASS Civilization II local browser Worker launch (${CASES.map(x => x.id).join(', ')})`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
