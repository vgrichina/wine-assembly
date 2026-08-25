#!/usr/bin/env node
// Quitting an app on a phone has to give the desktop back.
//
// WHY: in single-app mode the desktop icons are the only launcher on the page
// -- no taskbar, no toolbar, no app dropdown. Three separate classes hide
// them (app-running, exclusive-fullscreen, page-fullscreen), so any one of
// them still set after the last guest stops leaves a blank teal page that
// cannot start anything. The renderer clears exclusive mode on a repaint
// *transition*, and a transition can be missed -- an app that drops out of
// exclusive for a final dialog and exits from there never makes the edge.
//
// So this asserts the end state a visitor cares about, from the worst start:
// both fullscreen classes stuck on, the app stopped, and then a real tap on a
// real icon that has to launch something.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'single-app-quit');
const VIEWPORT = { width: 390, height: 664, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for single-app quit test');
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
    iconCount: document.querySelectorAll('.desktop-icon').length,
    // Displayed is not the same as reachable: an icon scaled or translated off
    // the viewport is exactly as useless as a hidden one.
    firstIconOnScreen: !!rect && rect.width > 0 && rect.height > 0 &&
      rect.top >= 0 && rect.left >= 0 &&
      rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    running: typeof runningApps === 'undefined' ? -1 : runningApps.length,
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
    // The iPhone: no element Fullscreen API, so "full screen" is the page
    // fallback and nothing will ever fire a fullscreenchange event.
    await page.evaluateOnNewDocument(() => {
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen',
                          'mozRequestFullScreen', 'msRequestFullscreen']) {
        delete Element.prototype[name];
      }
    });
    await page.goto(`${base}/index.html?single-app=1&quit-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' &&
      document.querySelector('.desktop-icon'), { timeout: 60000 });

    const idle = await page.evaluate(desktopState);
    assert(idle.classes.includes('single-app'), `phone viewport should be single-app, got "${idle.classes}"`);
    assert(idle.iconCount > 0, 'the desktop should have icons to launch from');
    assert.strictEqual(idle.display, 'grid', 'the idle desktop shows its icons');

    // Launch by tapping an icon, which on a phone is the only way in.
    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')]
        .find(el => el.dataset.app === 'winmine_wep');
      if (!icon) throw new Error('no Minesweeper icon on the desktop');
      icon.click();
    });
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      return !!(app && app.wine.running && app.wine._runSliceCount >= 40);
    }, { timeout: 120000 });
    const playing = await page.evaluate(desktopState);
    assert.strictEqual(playing.display, 'none', 'a running app owns the whole phone screen');

    // The worst case a visitor can be left in: the app took the display and
    // the page went full screen for it, and neither got taken down by an
    // event. This is the state, not a way of producing it -- the point is
    // that stopping the guest has to clear it however it came about.
    await page.evaluate(() => {
      document.body.classList.add('exclusive-fullscreen', 'page-fullscreen');
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      app.wine.stop({ repaint: false });
      if (app.wine.renderer) app.wine.renderer.repaint();
    });
    await page.waitForFunction(() => runningApps.length === 0, { timeout: 30000 });
    const quit = await page.evaluate(desktopState);
    await page.screenshot({ path: path.join(OUT, 'after-quit.png') });

    assert.strictEqual(quit.running, 0, 'the app really stopped');
    assert.strictEqual(quit.display, 'grid',
      `the desktop must come back when the last app quits, body was "${quit.classes}"`);
    assert(!quit.classes.includes('page-fullscreen'),
      'nothing is running, so nothing owns the page');
    assert(!quit.classes.includes('exclusive-fullscreen'),
      'nothing is running, so nothing owns the display');
    assert(quit.firstIconOnScreen, 'the first icon has to be tappable, not just displayed');

    // And the desktop has to work, not just appear.
    await page.evaluate(() => {
      const icon = [...document.querySelectorAll('.desktop-icon')]
        .find(el => el.dataset.app === 'notepad');
      if (!icon) throw new Error('no Notepad icon on the desktop');
      icon.click();
    });
    await page.waitForFunction(() => runningApps.some(item => item && item.name === 'notepad'),
      { timeout: 120000 });

    console.log('PASS  quitting an app in single-app mode gives the desktop back');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
