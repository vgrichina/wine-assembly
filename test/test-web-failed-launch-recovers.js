#!/usr/bin/env node
// A launch that dies has to leave the page usable.
//
// WHY: the boot cursor is a counted ticket (lib/browser-shell.js). Every path
// out of launchApp has to spend exactly one, and several awaits in the middle
// of it had no .catch at all -- so a rejection escaped launchApp with the
// ticket unspent and body.app-booting on for the life of the page. That is a
// permanent hourglass over a desktop where nothing is running, and it was
// seen on a real iPhone: init() failed to get its 512MB, the next line threw
// "null is not an object (evaluating 'wine.instance.exports')", and the page
// never recovered.
//
// The failure is injected at wine.init, which is the one that actually failed
// on the device, and the assertion is on what a visitor is left with: no
// hourglass, nothing registered as running, and an icon that a tap still
// reaches.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for failed-launch test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

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
    // Stand in for the out-of-memory the phone hit: init() rejects, and
    // everything launchApp does after it is reached with no instance.
    await page.evaluateOnNewDocument(() => {
      const install = () => {
        if (typeof WineAssembly === 'undefined') return false;
        WineAssembly.prototype.init = function () {
          return Promise.reject(new RangeError('WebAssembly.Memory(): could not allocate memory'));
        };
        return true;
      };
      if (!install()) window.addEventListener('load', install);
    });
    await page.goto(`${base}/index.html?single-app=1&fail-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === 'notepad');
      if (!icon) throw new Error('no notepad icon on the desktop');
      icon.click();
    });
    // The boot cursor comes on immediately; the point is that it goes off
    // again. Poll rather than sleeping a fixed time, then assert on the end
    // state so a slow machine cannot turn this into a flake.
    await page.waitForFunction(
      () => !document.body.classList.contains('app-booting'), { timeout: 30000 })
      .catch(() => {});

    const state = await page.evaluate(() => {
      const icon = document.querySelector('.desktop-icon');
      const rect = icon ? icon.getBoundingClientRect() : null;
      const hit = rect
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        classes: document.body.className,
        running: typeof runningApps === 'undefined' ? -1 : runningApps.length,
        // The one check that fails for a stuck overlay, a transform, a zoom
        // and a pointer-events hole alike: can a tap on this icon reach it?
        iconReachable: !!hit && !!icon && (hit === icon || icon.contains(hit)),
        status: (document.getElementById('status') || {}).textContent || '',
        crashVisible: (document.getElementById('wine-crash-report') || {}).style?.display === 'flex',
        crashText: (document.querySelector('.wine-crash-text') || {}).value || '',
      };
    });

    assert(!state.classes.includes('app-booting'),
      `a failed launch left the boot cursor on for good, body was "${state.classes}"`);
    assert.strictEqual(state.running, 0, 'a launch that never started must not register an app');
    assert(/ERROR launching/.test(state.status),
      `the failure should be reported to the visitor, status was "${state.status}"`);
    assert(state.crashVisible, 'a fatal launch failure must open a visible crash-report dialog');
    assert(state.crashText.includes('Wine-Assembly crash report'));
    assert(state.crashText.includes('kind: launch'));
    assert(state.crashText.includes('app: notepad'));
    assert(state.crashText.includes('RangeError: WebAssembly.Memory(): could not allocate memory'));
    assert(state.crashText.includes('user-agent: '));

    // Exercise the plain-HTTP phone path even though Chromium treats localhost
    // as trustworthy: no Clipboard API, successful legacy selection copy.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = command => command === 'copy';
    });
    await page.click('.wine-crash-copy');
    await page.waitForFunction(() =>
      /^(Copied|Select all & copy)$/.test(document.querySelector('.wine-crash-copy').textContent));
    const copyState = await page.evaluate(() => ({
      label: document.querySelector('.wine-crash-copy').textContent,
      selected: document.querySelector('.wine-crash-text').selectionEnd >
        document.querySelector('.wine-crash-text').selectionStart,
    }));
    assert.strictEqual(copyState.label, 'Copied',
      'the insecure-origin execCommand fallback should copy the report');
    await page.click('.wine-crash-close');
    const recovered = await page.evaluate(() => {
      const icon = document.querySelector('.desktop-icon');
      const rect = icon && icon.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(
        rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        reportHidden: document.getElementById('wine-crash-report').style.display === 'none',
        iconReachable: !!hit && !!icon && (hit === icon || icon.contains(hit)),
      };
    });
    assert(recovered.reportHidden, 'Close must dismiss the crash report');
    assert(recovered.iconReachable,
      'the desktop icons must take taps again after the crash report is closed');
    console.log('PASS  a failed launch clears the boot cursor and leaves the desktop usable');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
