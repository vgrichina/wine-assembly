#!/usr/bin/env node
// "Use browser fullscreen" on a browser that has no Fullscreen API.
//
// WHY: iPhone Safari exposes no element fullscreen at all -- neither
// requestFullscreen nor webkitRequestFullscreen exists on an element there,
// only <video>.webkitEnterFullscreen does. approveBrowserFullscreen used to
// return at `if (!request)` and the button did nothing at all: the reporter's
// "browser fullscreen doesn't seem to work on iPhone".
//
// Chrome always HAS the API, so the only way to reproduce the iPhone is to
// take it away before any page script runs, which is what this does. The
// assertions are about pixels-on-screen, not about which class got added: the
// canvas has to actually reach the edges of the viewport with none of our own
// chrome left, and it has to hand the page back afterwards.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'page-fullscreen');
// An iPhone 14-ish CSS viewport. The height matters: dvh and vh differ on iOS
// only because of the browser toolbars, and the bug this guards is a canvas
// sized past the bottom of the screen.
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for page-fullscreen test');
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

const layout = () => {
  const canvas = document.getElementById('screen');
  const rect = canvas.getBoundingClientRect();
  const visible = el => !!el && getComputedStyle(el).display !== 'none';
  return {
    pageFullscreen: document.body.classList.contains('page-fullscreen'),
    canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    consentVisible: visible(document.getElementById('browser-fullscreen-consent')),
    taskbarVisible: visible(document.getElementById('taskbar')),
    exitVisible: visible(document.getElementById('page-fullscreen-exit')),
    hintVisible: visible(document.getElementById('page-fullscreen-hint')),
    scrollHeight: document.documentElement.scrollHeight,
  };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // BASE_URL points the same checks at a deployed site, so "it works on my
  // machine" and "it works on the phone the report came from" are one test.
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
    // The hint about Safari's own toolbars is keyed off the user agent, so the
    // emulated phone has to claim to be one.
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    // The iPhone, reproduced: no element Fullscreen API whatsoever.
    await page.evaluateOnNewDocument(() => {
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen',
                          'mozRequestFullScreen', 'msRequestFullscreen']) {
        delete Element.prototype[name];
      }
    });
    await page.goto(`${base}/index.html?page-fs=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(
      () => typeof approveBrowserFullscreen === 'function' && document.getElementById('screen'),
      { timeout: 30000 });

    assert.strictEqual(
      await page.evaluate(() => typeof document.getElementById('screen').requestFullscreen),
      'undefined', 'the emulated iPhone must really have no Fullscreen API');

    // Run a real app in it. A blank canvas would pass every geometry check
    // here while looking like nothing on a phone, and the screenshots this
    // writes are the only way to see that it does not.
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('#app-select option[value="winmine_wep"]'), { timeout: 60000 });
    await page.evaluate(async () => {
      document.getElementById('app-select').value = 'winmine_wep';
      await launchApp();
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      return !!(app && app.wine.running && app.wine._runSliceCount >= 40);
    }, { timeout: 120000 });

    // A guest app taking the display is what puts the consent bar on screen.
    await page.evaluate(() => {
      document.body.classList.add('exclusive-fullscreen');
      resizeCanvas();
    });
    await page.screenshot({ path: path.join(OUT, 'framed.png') });
    const before = await page.evaluate(layout);
    assert(before.consentVisible, 'an exclusive-fullscreen app offers the fullscreen control');
    assert(!before.pageFullscreen, 'the page is not commandeered until the button is pressed');

    // Press it the way a finger does, not by calling the function.
    await page.click('#browser-fullscreen-consent button');
    await page.waitForFunction(() => document.body.classList.contains('page-fullscreen'),
      { timeout: 5000 });
    const after = await page.evaluate(layout);
    await page.screenshot({ path: path.join(OUT, 'page-fullscreen.png') });

    assert(!after.consentVisible, 'the consent bar is chrome too and goes away');
    assert(!after.taskbarVisible, 'no Win98 taskbar in full screen');
    assert(after.exitVisible, 'a phone has no Escape key, so an exit control must remain');
    assert(Math.abs(after.canvas.left) <= 1 && Math.abs(after.canvas.top) <= 1,
      `canvas should start at the top-left corner, got ${after.canvas.left},${after.canvas.top}`);
    assert(after.canvas.width >= after.viewport.width - 1,
      `canvas should span the viewport width: ${after.canvas.width} vs ${after.viewport.width}`);
    // The whole point of dvh over vh: the canvas must fit the visible viewport,
    // not the taller one Safari reports with its toolbars hidden.
    assert(after.canvas.height >= after.viewport.height - 1 &&
           after.canvas.height <= after.viewport.height + 1,
      `canvas height should equal the visible viewport: ${after.canvas.height} vs ${after.viewport.height}`);
    assert(after.scrollHeight <= after.viewport.height + 1,
      'a full-screen page must not be scrollable past its own viewport');
    assert(after.canvas.width > before.canvas.width || after.canvas.height > before.canvas.height,
      'full screen should give the app more room than the framed page did');
    assert(after.hintVisible,
      'iOS Safari keeps its own toolbars over this mode, so say what actually removes them');

    // And it has to give the page back.
    await page.click('#page-fullscreen-exit');
    await page.waitForFunction(() => !document.body.classList.contains('page-fullscreen'),
      { timeout: 5000 });
    const exited = await page.evaluate(layout);
    assert(exited.consentVisible, 'leaving full screen restores the consent control');
    assert(!exited.exitVisible, 'the exit control belongs to full screen only');

    // The other half -- a guest that closes its exclusive display takes the
    // page back with it -- needs no browser and is checked against a stubbed
    // renderer in test/test-web-fullscreen-consent.js.

    console.log('PASS  fullscreen button gives the app the whole page where the Fullscreen API is missing');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
