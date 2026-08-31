#!/usr/bin/env node
'use strict';

// Real browser input regression for the D3DIM Viewer. In Worker mode menu
// tracking runs in the renderer's shadow instance, while WM_COMMAND must reach
// the live guest Worker. Exercise the same pointer route as the canvas UI and
// require both the Open dialog and persistent Renderer checkmarks.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXTERNAL_URL = String(process.env.VIEWER_WEB_URL || '').trim();

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for D3DIM Viewer browser test');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.exe': 'application/octet-stream', '.dll': 'application/octet-stream',
  '.x': 'application/octet-stream', '.ppm': 'application/octet-stream',
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function clickGuest(page, x, y) {
  await page.evaluate(point => {
    sharedRenderer.handleMouseDown(point.x, point.y, 0);
  }, { x, y });
  await wait(50);
  await page.evaluate(point => {
    sharedRenderer.handleMouseUp(point.x, point.y, 0);
  }, { x, y });
  await wait(150);
}

async function runMode(browser, baseUrl, threaded) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', error => problems.push((error && error.stack) || String(error)));
  page.on('console', message => {
    const text = message.text();
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:|trapped/i.test(text)) {
      problems.push(text);
    }
  });
  await page.setViewport({ width: 1100, height: 820, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.removeItem('wine-assembly.threads'));

  const separator = baseUrl.includes('?') ? '&' : '?';
  await page.goto(`${baseUrl}${separator}debug&no-log&viewer-open=${Date.now()}`,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => typeof launchApp === 'function' &&
    document.querySelector('#app-select option[value="dx_viewer"]'),
  { timeout: 30000 });
  assert(await page.evaluate(() => crossOriginIsolated),
    'Viewer test server must enable cross-origin isolation for threads mode');

  const mode = await page.evaluate(async useThreads => {
    const box = document.getElementById('threads-toggle');
    box.checked = useThreads;
    await setThreads(box.checked);
    document.getElementById('app-select').value = 'dx_viewer';
    launchApp();
    return { checked: box.checked, enabled: window.WINE_THREADS };
  }, threaded);
  assert.strictEqual(mode.checked, threaded, 'threads checkbox did not retain its requested state');
  assert.strictEqual(!!mode.enabled, threaded, 'runtime threads mode disagrees with the checkbox');

  await page.waitForFunction(expectWorker => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const viewer = Object.values(sharedRenderer.windows || {}).find(win =>
      win && win.visible && win.title === 'Direct3D Object Viewer');
    return !!(app && app.wine && app.wine.running && viewer &&
      (!expectWorker || app.wine.guestWorker));
  }, { timeout: 90000 }, threaded);

  // File -> Open Mesh, choose visible row 6 (mslogo.x), then press Open.
  await clickGuest(page, 35, 51);
  await clickGuest(page, 100, 92);
  await page.waitForFunction(() => Object.values(sharedRenderer.windows || {})
    .some(win => win && win.visible && win.title === 'Open'), { timeout: 30000 });
  await clickGuest(page, 100, 219);
  await page.waitForFunction(() => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const dialog = Object.values(sharedRenderer.windows || {}).find(win =>
      win && win.visible && win.title === 'Open');
    const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
    let listHwnd = 0;
    if (dialog && e && e.ctrl_get_id) {
      for (let hwnd = dialog.hwnd + 1; hwnd < dialog.hwnd + 20; hwnd++) {
        if (e.ctrl_get_id(hwnd) === 1089) { listHwnd = hwnd; break; }
      }
    }
    return !!(listHwnd && e.listbox_get_cur_sel && e.listbox_get_cur_sel(listHwnd) === 6);
  }, { timeout: 10000 });
  await clickGuest(page, 381, 102);
  await page.waitForFunction(() => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const open = Object.values(sharedRenderer.windows || {})
      .some(win => win && win.visible && win.title === 'Open');
    return !!(app && app.wine && app.wine.running && !open);
  }, { timeout: 30000 });

  const initial = await page.evaluate(() => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const viewer = Object.values(sharedRenderer.windows || {}).find(win =>
      win && win.visible && win.title === 'Direct3D Object Viewer');
    const e = app.wine.instance.exports;
    return {
      wire: e.menu_child_flags(viewer.hwnd, 2, 3) & 4,
      solid: e.menu_child_flags(viewer.hwnd, 2, 4) & 4,
    };
  });
  assert.deepStrictEqual(initial, { wire: 0, solid: 4 },
    'Viewer should initially show Solid checked and Wireframe unchecked');

  // Renderer -> Wireframe. Check once immediately and again while reopened;
  // the latter catches stale menu blobs that only looked right after another command.
  await clickGuest(page, 110, 51);
  await clickGuest(page, 150, 132);
  await page.waitForFunction(() => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const viewer = Object.values(sharedRenderer.windows || {}).find(win =>
      win && win.visible && win.title === 'Direct3D Object Viewer');
    const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
    return !!(e && viewer && (e.menu_child_flags(viewer.hwnd, 2, 3) & 4) &&
      !(e.menu_child_flags(viewer.hwnd, 2, 4) & 4));
  }, { timeout: 30000 });
  await clickGuest(page, 110, 51);
  const reopened = await page.evaluate(() => {
    const app = runningApps.find(item => item && item.name === 'dx_viewer');
    const viewer = Object.values(sharedRenderer.windows || {}).find(win =>
      win && win.visible && win.title === 'Direct3D Object Viewer');
    const e = app.wine.instance.exports;
    return {
      top: e.menu_open_top(),
      wire: e.menu_child_flags(viewer.hwnd, 2, 3) & 4,
      solid: e.menu_child_flags(viewer.hwnd, 2, 4) & 4,
      running: app.wine.running,
      worker: !!app.wine.guestWorker,
    };
  });
  assert.deepStrictEqual(reopened,
    { top: 2, wire: 4, solid: 0, running: true, worker: threaded },
    'reopened Renderer menu must retain Wireframe state in the requested execution mode');
  assert.strictEqual(problems.length, 0, `browser runtime failures:\n${problems.join('\n')}`);

  await page.close();
  return reopened;
}

(async () => {
  const server = EXTERNAL_URL ? null : await startServer();
  const baseUrl = EXTERNAL_URL ||
    `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    await runMode(browser, baseUrl, false);
    await runMode(browser, baseUrl, true);
    console.log(`PASS D3DIM Viewer Open and Renderer checkmarks in cooperative + threads modes (${baseUrl})`);
  } finally {
    await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
