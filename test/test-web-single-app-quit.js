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
    // A phone desktop is taller than a phone. If the grid overflows and does
    // not scroll, the icons past the fold are simply gone.
    overflows: icons ? icons.scrollHeight > icons.clientHeight + 1 : false,
    scrollable: style ? (style.overflowY === 'auto' || style.overflowY === 'scroll') : false,
    takesTouches: style ? style.pointerEvents !== 'none' : false,
    // The build watermark is how anyone answers "is this phone on the new
    // version at all", so it has to be somewhere a phone can see.
    stamp: (() => {
      const el = document.getElementById('build-stamp');
      if (!el || getComputedStyle(el).display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, onScreen: r.bottom <= window.innerHeight + 1 && r.top >= 0 };
    })(),
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
    // Driven through the renderer, not by setting the classes: on a browser
    // with no Fullscreen API the display grab now takes the page with it
    // (index.html's enterPageFullscreenIfNoApi), and setting the classes by
    // hand skips exactly the code that has to be undone again on the way out.
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      app.wine.renderer._setExclusiveFullscreen(true);
    });
    const owned = await page.evaluate(() => document.body.className);
    assert(owned.includes('page-fullscreen'),
      `an exclusive app on an API-less browser should own the page, got "${owned}"`);
    // Stopped the pathological way, not the tidy way: something cleared
    // `running` before stop() was reached -- an exit taken inside the run
    // loop, a trap, a second stop() -- which used to swallow the shell's only
    // notification. The entry then lived forever in runningApps, and on a
    // phone that is terminal: the renderer has already dropped the guest's
    // windows so the page is bare teal, the icons stay hidden behind
    // body.app-running, and single-app mode refuses every later launch in
    // silence because it still believes something is running.
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      app.wine.running = false;
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

    // Every icon has to be reachable, not just the ones above the fold. The
    // grid is sized to the guest screen, so on a phone eight rows of icons do
    // not fit and the ones below are unreachable unless it scrolls itself --
    // and it can only scroll if it takes the touches, because the canvas sits
    // over it and preventDefaults them away to the guest.
    // Chrome's device emulation cannot reproduce this one: it has no
    // retractable toolbars, so vh and dvh are the same number and the page
    // measures correct either way. On a real iPhone 100vh is the height the
    // page would have if Safari's bars were hidden, so the bottom ~70px of
    // the desktop sits behind them -- and because the grid was then taller
    // than the screen showed, it never overflowed and never scrolled. Assert
    // the rule itself, since no measurement here can.
    const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
    assert(/body:not\(\.app-running\)\s*\{\s*height:\s*100dvh/.test(source),
      'the idle desktop must be sized in dvh, or its last row hides behind Safari');

    assert(quit.scrollable, 'the phone desktop must scroll');
    assert(quit.takesTouches, 'a grid with pointer-events:none cannot be scrolled by a finger');
    assert(quit.stamp && quit.stamp.onScreen,
      `the build watermark has to be visible on the idle desktop, got ${JSON.stringify(quit.stamp)}`);
    assert(/build /.test(quit.stamp.text), 'the watermark has to name a build');
    if (quit.overflows) {
      const lastIcon = await page.evaluate(() => {
        const grid = document.getElementById('desktop-icons');
        const icons = [...document.querySelectorAll('.desktop-icon')];
        const last = icons[icons.length - 1];
        grid.scrollTop = grid.scrollHeight;
        const rect = last.getBoundingClientRect();
        const box = grid.getBoundingClientRect();
        return {
          scrolled: grid.scrollTop > 0,
          onScreen: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 &&
            rect.bottom <= window.innerHeight + 1,
          app: last.dataset.app,
        };
      });
      assert(lastIcon.scrolled, 'an overflowing grid must actually scroll');
      assert(lastIcon.onScreen,
        `the last icon (${lastIcon.app}) must be reachable by scrolling`);
      await page.screenshot({ path: path.join(OUT, 'desktop-scrolled.png') });
      await page.evaluate(() => { document.getElementById('desktop-icons').scrollTop = 0; });
    }

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
