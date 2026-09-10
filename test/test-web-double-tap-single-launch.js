#!/usr/bin/env node
// A second tap during a boot must not start a second guest.
//
// WHY: a boot takes seconds on a phone and the desktop icons stay tappable for
// all of it -- body.app-booting hides nothing. `wine` in lib/browser-shell.js
// is ONE shared variable, so the second tap does not launch a second app, it
// overwrites the first one in the middle of its init(): launch A resumes after
// its await and goes on to configure B's instance, while A's own WineAssembly
// is left with no owner, no stop() and its 512MB of shared guest memory held
// for the life of the page.
//
// Nothing else catches this. The single-app guard tests runningApps, which is
// not pushed until a boot *finishes*, so both taps sail through it; afterwards
// the page looks perfectly healthy -- one app running, one window, icons where
// they belong -- while a half gigabyte is gone. On a real iPhone that showed
// up as launches failing with "Out of memory" a couple of taps in, with the
// beacon reporting 4 guest memories made and 3 still alive for two launches.
//
// So the assertion is the count of guest memories instantiated, taken from a
// wrapper installed before the page loads: two taps, one memory.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'notepad';
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for double-tap launch test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

// Count only guest-sized memories: the page makes small ones of its own (the
// WAT compiler), and those are not what this is about.
const COUNTER = () => {
  const MIN_PAGES = 1024;
  const state = { made: 0 };
  window.__guestMemoryCount = state;
  const Real = WebAssembly.Memory;
  function Counted(descriptor) {
    const memory = new Real(descriptor);
    if (descriptor && (descriptor.initial | 0) >= MIN_PAGES) state.made++;
    return memory;
  }
  Counted.prototype = Real.prototype;
  WebAssembly.Memory = Counted;
};

async function main() {
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
    await page.evaluateOnNewDocument(COUNTER);
    await page.goto(`${base}/index.html?single-app=1&double-tap=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    // Two taps on the same icon, back to back, exactly as an impatient thumb
    // on a slow boot delivers them: the second lands while the first launch is
    // parked on an await.
    await page.evaluate(app => {
      const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === app);
      if (!icon) throw new Error(`no ${app} icon on the desktop`);
      icon.click();
      icon.click();
    }, APP);

    await page.waitForFunction(app => {
      const entry = runningApps.find(item => item && item.name === app);
      if (!entry || !entry.wine.running) return false;
      const lo = entry.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
    }, { timeout: 120000 }, APP);

    const state = await page.evaluate(() => ({
      made: window.__guestMemoryCount.made,
      running: runningApps.length,
      booting: document.body.classList.contains('app-booting'),
    }));

    assert.strictEqual(state.made, 1,
      `two taps on one icon instantiated ${state.made} guest memories ` +
      `(${state.made * 512}MB); the extra one has no owner and is never released`);
    assert.strictEqual(state.running, 1, 'single-app mode must end up with exactly one app');
    assert(!state.booting, 'the boot cursor must be spent once the app is up');
    console.log('PASS  a second tap during a boot does not start a second guest');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
