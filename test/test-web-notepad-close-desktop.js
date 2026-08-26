#!/usr/bin/env node
// Closing an app the way a finger closes it has to give the desktop back.
//
// WHY a second test next to test-web-single-app-quit.js: that one stops the
// guest from JS and asserts the shell tidies up afterwards. It cannot see a
// failure that happens *before* stop() is ever reached, and that is the half a
// visitor actually exercises -- they tap the close box, the guest runs its own
// shutdown, and something further down the line has to notice the process is
// gone. Reported on a real iPhone: launch Notepad, close it, and the page is
// bare teal with no icons and no way to start anything.
//
// So this drives the close through the renderer's own titlebar path
// (WM_SYSCOMMAND/SC_CLOSE then WM_CLOSE, exactly what a tap on the X sends)
// and then waits on the end state -- no app registered, icons back, no class
// left hiding them.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'notepad-close-desktop');
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for notepad close test');
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

const desktopState = () => {
  const icons = document.getElementById('desktop-icons');
  const style = icons ? getComputedStyle(icons) : null;
  const first = document.querySelector('.desktop-icon');
  const rect = first ? first.getBoundingClientRect() : null;
  return {
    display: style ? style.display : 'missing',
    classes: document.body.className,
    running: typeof runningApps === 'undefined' ? -1 : runningApps.length,
    windows: (typeof sharedRenderer !== 'undefined' && sharedRenderer)
      ? Object.keys(sharedRenderer.windows).map(Number) : [],
    firstIconOnScreen: !!rect && rect.width > 0 && rect.height > 0 &&
      rect.top >= 0 && rect.left >= 0 &&
      rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
  };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = process.env.BASE_URL ? null : await startStaticServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    // The iPhone has no element Fullscreen API, so the display grab takes the
    // whole page instead and nothing ever fires a fullscreenchange event.
    await page.evaluateOnNewDocument(() => {
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen',
                          'mozRequestFullScreen', 'msRequestFullscreen']) {
        delete Element.prototype[name];
      }
    });
    page.on('pageerror', error => console.log('  [pageerror]', error.message));
    await page.goto(`${base}/index.html?single-app=1&close-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('.desktop-icon'), { timeout: 60000 });

    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')]
        .find(el => el.dataset.app === 'notepad');
      if (!icon) throw new Error('no Notepad icon on the desktop');
      icon.click();
    });
    // Notepad has to be up and pumping, not merely registered: closing a guest
    // that has not reached its message loop yet is a different path.
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'notepad');
      if (!app || !app.wine.running) return false;
      const base = app.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= base && Number(hwnd) < base + 0x10000);
    }, { timeout: 120000 });
    await page.screenshot({ path: path.join(OUT, 'running.png') });

    // Park the main thread across the close. This is the case the run loop
    // used to skip: the last window goes, the guest blocks instead of reaching
    // ExitProcess, and the deferred teardown's deadline passes with nobody
    // looking at it because _checkLastWindowStop was only called on the branch
    // that ran a guest slice. `running` then stayed true forever and
    // body.app-running kept the icons hidden -- a bare teal page with no
    // launcher, which is what a visitor reported after closing Notepad.
    // Whether an app parks before or after its final slice is a race, hence
    // "sometimes".
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'notepad');
      app.wine._isMainExecutionSuspended = () => true;
    });

    // Tap the close box. Going through _closeWatDialogFrame is the point --
    // it is what renderer-input calls for a titlebar X, so the guest runs the
    // same shutdown a finger would produce.
    const closed = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'notepad');
      const lo = app.wine._hwndBase || 0;
      const hwnd = Object.keys(sharedRenderer.windows).map(Number)
        .filter(h => h >= lo && h < lo + 0x10000)
        .filter(h => !sharedRenderer.windows[h].parentHwnd)
        .sort((a, b) => a - b)[0];
      if (!hwnd) throw new Error('Notepad has no top-level window to close');
      sharedRenderer._closeWatDialogFrame(hwnd, app.wine.instance);
      return hwnd;
    });

    // The guest still has to run its own shutdown, and the run loop is a
    // setTimeout chain, so this is a wait rather than a check.
    let last = null;
    try {
      await page.waitForFunction(() => runningApps.length === 0, { timeout: 60000 });
    } catch (error) {
      last = await page.evaluate(desktopState);
      await page.screenshot({ path: path.join(OUT, 'stuck.png') });
      throw new Error(`closing Notepad (hwnd 0x${closed.toString(16)}) never unregistered it: ` +
        JSON.stringify(last));
    }

    // Give the shell's own repaint/resize a turn before reading the page.
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await page.evaluate(desktopState);
    await page.screenshot({ path: path.join(OUT, 'after-close.png') });

    assert.strictEqual(after.running, 0, 'the app really stopped');
    for (const stuck of ['app-running', 'exclusive-fullscreen', 'page-fullscreen']) {
      assert(!after.classes.includes(stuck),
        `body still has ${stuck} after the close, so the icons stay hidden: "${after.classes}"`);
    }
    assert.strictEqual(after.display, 'grid',
      `the desktop must come back, body was "${after.classes}"`);
    assert(after.firstIconOnScreen, 'the first icon has to be tappable, not just displayed');
    assert.strictEqual(after.windows.length, 0,
      `no window may outlive the app that owned it, left ${after.windows.map(h => '0x' + h.toString(16))}`);

    // And it has to actually launch again, which is the thing the visitor
    // could not do.
    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')]
        .find(el => el.dataset.app === 'notepad');
      icon.click();
    });
    await page.waitForFunction(() => runningApps.some(item => item && item.name === 'notepad'),
      { timeout: 120000 });

    console.log('PASS  closing an app from its titlebar gives the desktop back');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
