#!/usr/bin/env node
// A keyboard shift must not outlive the app it was computed for.
//
// WHY this is separate from test-web-notepad-close-desktop.js: that test asks
// whether the desktop comes *back* -- no app registered, no class hiding the
// grid, display:grid, first icon inside the viewport. Every one of those
// checks reads clean in the failure a visitor actually hit on an iPhone, and
// that is the whole point of this file.
//
// The on-screen keyboard is not allowed to resize the guest, so
// lib/mobile-keyboard.js translates #screen-wrap upward instead
// (see the header comment there). #desktop-icons is a CHILD of #screen-wrap
// (index.html: screen-wrap > desktop-icons > canvas), so that translate takes
// the icon grid with it. If the shift is still applied when the app exits, the
// only launcher a phone has is sitting off the top of the screen: present,
// displayed, unhidden, and untappable. The page is bare teal.
//
// It survives the exit because the two things that would take it down both
// stop looking at exactly the wrong moment. The 500ms syncKeyboardProxy poll
// in lib/browser-input.js used to return early when nothing was running -- and
// an app that exits drops its caret and empties runningApps in the same
// instant, so the blur that lowers the keyboard never fired. And
// controller.update() cannot undo the shift on the close either: it derives
// the inset from visualViewport, which still reports the keyboard as up while
// it is on its way down. Hence the explicit blur + controller.reset() on the
// app-stopped transition, which is what this test pins.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'keyboard-shift-cleared');
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for keyboard shift test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

// Read the state the *old* checks could not see: where the icon grid actually
// is on screen, what transform is on its ancestor, and whether the hidden
// textarea that summons the keyboard still holds focus.
const shiftState = () => {
  const wrap = document.getElementById('screen-wrap');
  const proxy = document.getElementById('mobile-keyboard-proxy');
  const first = document.querySelector('.desktop-icon');
  const rect = first ? first.getBoundingClientRect() : null;
  return {
    running: typeof runningApps === 'undefined' ? -1 : runningApps.length,
    classes: document.body.className,
    transform: wrap ? (wrap.style.transform || '') : 'missing',
    computed: wrap ? getComputedStyle(wrap).transform : 'missing',
    proxyFocused: !!proxy && document.activeElement === proxy,
    keyboardOpen: document.body.classList.contains('keyboard-open'),
    iconTop: rect ? Math.round(rect.top) : null,
    iconOnScreen: !!rect && rect.width > 0 && rect.height > 0 &&
      rect.top >= 0 && rect.bottom <= window.innerHeight,
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
    await page.evaluateOnNewDocument(() => {
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen',
                          'mozRequestFullScreen', 'msRequestFullscreen']) {
        delete Element.prototype[name];
      }
    });
    page.on('pageerror', error => console.log('  [pageerror]', error.message));
    await page.goto(`${base}/index.html?single-app=1&kbshift=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('.desktop-icon'), { timeout: 60000 });

    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')]
        .find(el => el.dataset.app === 'notepad');
      if (!icon) throw new Error('no Notepad icon on the desktop');
      icon.click();
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'notepad');
      if (!app || !app.wine.running) return false;
      const base = app.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= base && Number(hwnd) < base + 0x10000);
    }, { timeout: 120000 });

    // Stand in for "the visitor typed into Notepad on a phone": the hidden
    // proxy holds focus and the wrap carries a keyboard shift. Chrome has no
    // on-screen keyboard to shrink visualViewport with, so the shift is set
    // directly -- what is under test is whether the app-stopped transition
    // takes it down, not how it got there.
    const before = await page.evaluate(() => {
      const wrap = document.getElementById('screen-wrap');
      const proxy = document.getElementById('mobile-keyboard-proxy');
      proxy.focus();
      wrap.style.transform = 'translateY(-213px)';
      document.body.classList.add('keyboard-open');
      const icons = document.getElementById('desktop-icons');
      return { insideWrap: !!icons && wrap.contains(icons) };
    });
    assert(before.insideWrap,
      'the premise of this test is that #desktop-icons is inside #screen-wrap; ' +
      'if that stops being true the shift can no longer hide the launcher and ' +
      'this test is measuring nothing');
    await page.screenshot({ path: path.join(OUT, 'shifted.png') });

    // Close it the way a finger does.
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'notepad');
      const lo = app.wine._hwndBase || 0;
      const hwnd = Object.keys(sharedRenderer.windows).map(Number)
        .filter(h => h >= lo && h < lo + 0x10000)
        .filter(h => !sharedRenderer.windows[h].parentHwnd)
        .sort((a, b) => a - b)[0];
      if (!hwnd) throw new Error('Notepad has no top-level window to close');
      sharedRenderer._closeWatDialogFrame(hwnd, app.wine.instance);
    });
    await page.waitForFunction(() => runningApps.length === 0, { timeout: 60000 });
    // The 500ms proxy poll is one of the two mechanisms under test, so give it
    // more than one turn.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const after = await page.evaluate(shiftState);
    await page.screenshot({ path: path.join(OUT, 'after-close.png') });
    const shown = JSON.stringify(after);

    assert.strictEqual(after.running, 0, `the app really stopped: ${shown}`);
    assert.strictEqual(after.transform, '',
      `the keyboard shift outlived the app, so the icon grid is off screen: ${shown}`);
    assert(after.computed === 'none' || after.computed === 'matrix(1, 0, 0, 1, 0, 0)',
      `#screen-wrap is still translated: ${shown}`);
    assert(!after.proxyFocused,
      `the keyboard proxy still holds focus with nothing behind it, so iOS keeps ` +
      `the keyboard up and the shift comes straight back: ${shown}`);
    assert(!after.keyboardOpen, `body still says keyboard-open: ${shown}`);
    assert(after.iconOnScreen,
      `the first icon is not inside the viewport (top=${after.iconTop}): ${shown}`);

    console.log('PASS  a keyboard shift does not outlive the app that caused it');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
