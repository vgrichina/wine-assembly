#!/usr/bin/env node
// Closing an app has to give its 512MB back.
//
// WHY: every launch instantiates `new WebAssembly.Memory({ initial: 8192,
// maximum: 8192, shared: true })` (host.js). initial === maximum and it is
// shared, so the whole half gigabyte is resident from the moment it is made,
// and nothing shrinks it -- the only way to get it back is for the Memory
// object itself to become unreachable. It was not: sharedRenderer is a
// page-lifetime singleton that had been handed the instance and the memory,
// the host imports object kept a `memory` property that outlived the app
// through the window "unlock" audio listener, and every GDI surface the guest
// never deleted held a Uint8Array over the same SharedArrayBuffer.
//
// The reason this needs its own test is that NOTHING ELSE SEES IT. After a
// close, runningApps is empty, sharedRenderer.windows is empty, no hiding
// class is set and the icon grid is display:grid -- the desktop is, by every
// check the shell makes, perfectly healthy, while the page is half a gigabyte
// heavier per launch. On a phone the second or third launch simply fails with
// "Out of memory" and the only way out is a reload, which is what a user hit
// as "already got into state where i can't launch new apps".
//
// So the assertion is on the count of guest memories that survive a forced
// GC, taken from a FinalizationRegistry installed before the page loads.
// Needs --js-flags=--expose-gc; without a real collector the count means
// nothing, so the test skips rather than passing vacuously.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'notepad';
const CYCLES = 2;
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for guest-memory release test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

// Count only guest-sized memories: the page makes small ones of its own (the
// WAT compiler), and those are not what this is about.
const COUNTER = () => {
  const MIN_PAGES = 1024;
  const state = { made: 0, live: 0 };
  window.__guestMemoryCount = state;
  const registry = new FinalizationRegistry(() => { state.live--; });
  const Real = WebAssembly.Memory;
  function Counted(descriptor) {
    const memory = new Real(descriptor);
    if (descriptor && (descriptor.initial | 0) >= MIN_PAGES) {
      state.made++; state.live++;
      registry.register(memory, 'guest');
    }
    return memory;
  }
  Counted.prototype = Real.prototype;
  WebAssembly.Memory = Counted;
};

async function launchAndClose(page) {
  await page.evaluate(app => {
    const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === app);
    if (!icon) throw new Error(`no ${app} icon on the desktop`);
    icon.click();
  }, APP);
  // Wait for a real top-level window, not just `running`: an app that has not
  // painted yet has not wired up half of what this test is about.
  await page.waitForFunction(app => {
    const entry = runningApps.find(item => item && item.name === app);
    if (!entry || !entry.wine.running) return false;
    const lo = entry.wine._hwndBase || 0;
    return Object.keys(sharedRenderer.windows)
      .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
  }, { timeout: 120000 }, APP);
  await page.evaluate(app => {
    const entry = runningApps.find(item => item && item.name === app);
    const lo = entry.wine._hwndBase || 0;
    const hwnd = Object.keys(sharedRenderer.windows).map(Number)
      .filter(h => h >= lo && h < lo + 0x10000)
      .filter(h => !sharedRenderer.windows[h].parentHwnd)
      .sort((a, b) => a - b)[0];
    sharedRenderer._closeWatDialogFrame(hwnd, entry.wine.instance);
  }, APP);
  await page.waitForFunction(() => runningApps.length === 0, { timeout: 60000 });
  // The release is deferred by a turn (stop() is usually called from inside a
  // guest slice), and finalizers run on the collector's schedule, so give it
  // several passes with turns in between before believing a count.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => { if (window.gc) window.gc(); });
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return page.evaluate(() => ({ ...window.__guestMemoryCount }));
}

async function main() {
  const server = process.env.BASE_URL ? null : await startStaticServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run', '--js-flags=--expose-gc'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.evaluateOnNewDocument(COUNTER);
    await page.goto(`${base}/index.html?single-app=1&mem-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    const collectable = await page.evaluate(() => typeof window.gc === 'function');
    if (!collectable) {
      console.log('SKIP  no window.gc (needs --js-flags=--expose-gc); a memory count without it proves nothing');
      return;
    }

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const counts = await launchAndClose(page);
      console.log(`cycle ${cycle}: ${counts.made} guest memories made, ${counts.live} still live`);
      assert.strictEqual(counts.made, cycle,
        `cycle ${cycle} should have instantiated exactly one guest memory`);
      // Zero, not "no more than one": every launch here is followed by a
      // close, so nothing legitimately holds a guest memory at this point.
      assert.strictEqual(counts.live, 0,
        `after ${cycle} launch/close cycle(s), ${counts.live} guest memories (${counts.live * 512}MB) ` +
        'are still reachable -- something took a reference to the instance, the memory, ' +
        'the host imports object or one of the app\'s GDI surfaces and never let go');
    }
    console.log('PASS  closing an app releases its guest memory');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
