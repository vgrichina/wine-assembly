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
    classes: document.body.className,
    taskbarVisible: visible(document.getElementById('taskbar')),
    exitVisible: visible(document.getElementById('page-fullscreen-exit')),
    hintVisible: visible(document.getElementById('page-fullscreen-hint')),
    scrollHeight: document.documentElement.scrollHeight,
    scrollCollapse: document.body.classList.contains('scroll-collapse'),
    gutterVisible: visible(document.getElementById('scroll-collapse-gutter')),
    scrollY: window.scrollY,
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
    // ?diag=1 too: lib/phone-diag.js's scroll probe is the only instrument
    // that will exist on the real phone, where this mode's swipe strip is
    // reported not to work and Chrome cannot reproduce it (device emulation
    // has no retractable toolbars, so vh and dvh are the same number). If the
    // probe misreads a page that is demonstrably armed, it will send the next
    // investigation somewhere wrong.
    await page.goto(`${base}/index.html?diag=1&page-fs=${Date.now()}`,
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

    // A guest taking the display, through the renderer's own transition rather
    // than by setting the class -- the class is the *symptom*, and the thing
    // under test is what the renderer does on the way there. Setting it by
    // hand is what let the "Use browser fullscreen" button survive on iPhone:
    // the test never ran the code that is supposed to skip it.
    const framed = await page.evaluate(layout);
    assert(!framed.pageFullscreen, 'a windowed app does not own the page');
    const before = await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      app.wine.renderer._setExclusiveFullscreen(true);
      const canvas = document.getElementById('screen');
      const rect = canvas.getBoundingClientRect();
      return {
        pageFullscreen: document.body.classList.contains('page-fullscreen'),
        consentVisible: getComputedStyle(
          document.getElementById('browser-fullscreen-consent')).display !== 'none',
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    });
    await page.screenshot({ path: path.join(OUT, 'framed.png') });

    // On a browser with no element Fullscreen API there is nothing behind the
    // consent button but the page fallback, so asking is a dead step: the
    // renderer hands the page over as the guest takes the display.
    assert(before.pageFullscreen,
      'with no Fullscreen API, an exclusive app should get the page without being asked for');
    assert(!before.consentVisible,
      'no button that only leads to the thing that already happened');
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
    // Scroll-to-collapse deliberately makes the document overflow -- Safari
    // retracts its bars only for a real scroll of a document that really is
    // taller than the viewport. So the old "must not scroll at all" rule is
    // replaced by the thing a player would actually notice: the overflow is a
    // spacer's worth and no more, and scrolling never moves the app.
    assert(after.scrollCollapse, 'an iPhone gets the scroll-to-collapse affordance');
    assert(after.gutterVisible,
      'the swipe strip has to exist, because the canvas eats every touch that lands on it');
    assert(after.scrollHeight > after.viewport.height,
      'nothing can collapse unless the document genuinely overflows');
    // A whole extra viewport of it, deliberately: Safari ignores a token
    // scroll, and the 76px this started as reached its end in one flick with
    // the bars straight back on the rubber-band. Capped at two viewports so a
    // regression that makes the page endlessly long still fails.
    assert(after.scrollHeight >= after.viewport.height * 1.9,
      `a real gesture needs a real page: ${after.scrollHeight} vs ${after.viewport.height}`);
    assert(after.scrollHeight <= after.viewport.height * 2.2,
      `the overflow is one spacer, not a long page: ${after.scrollHeight} vs ${after.viewport.height}`);
    // What the beacon will say about all of that from the device. The strip
    // being *present* is not the same as the strip being *touchable*: the
    // canvas, the exit chip and the emulated cursor are all in the same
    // corner, and a swipe that lands on any of them never reaches the page
    // scroller. A hit test is the only form of that question with an answer.
    const probe = await page.evaluate(() => window.PhoneDiag && window.PhoneDiag.snapshot().collapse);
    assert(probe, 'the phone beacon must report the scroll-collapse state');
    assert(/gutter=hit/.test(probe),
      `a finger on the swipe strip must land on the strip; the beacon says ${probe}`);
    const heights = probe.match(/h(\d+)\/v(\d+)/);
    assert(heights && Number(heights[1]) >= Number(heights[2]) * 1.9,
      `the beacon must see the overflow the collapse needs: ${probe}`);

    // The strip retracts WITH the bars -- once they are down it has nothing
    // left to do and is sitting on top of the app. "Are the bars down" is
    // innerHeight against 100lvh, the bars-retracted height, which is a
    // constant and needs no calibration.
    //
    // Chrome has no retractable toolbars, so here lvh and innerHeight are the
    // same number and the page reads as permanently collapsed. That is the
    // correct answer for a browser with nothing to collapse -- what this
    // pins down is that the two agree, so a real iPhone (lvh 710, innerHeight
    // 628 with the bars up) keeps the strip until the swipe lands.
    const strip = await page.evaluate(() => {
      const probeEl = document.createElement('div');
      probeEl.style.cssText = 'position:absolute;top:0;left:0;width:0;height:100lvh;visibility:hidden';
      document.documentElement.appendChild(probeEl);
      const lvh = Math.round(probeEl.getBoundingClientRect().height);
      probeEl.remove();
      window.dispatchEvent(new Event('resize'));
      const gutter = document.getElementById('scroll-collapse-gutter');
      return {
        lvh,
        htmlOverflow: getComputedStyle(document.documentElement).overflowY,
        bodyOverflow: getComputedStyle(document.body).overflowY,
        inner: window.innerHeight,
        collapsedClass: document.body.classList.contains('bars-collapsed'),
        gutterShown: !!(gutter && gutter.getClientRects().length),
      };
    });
    assert(strip.lvh > 10, `lvh must measure something: ${JSON.stringify(strip)}`);
    const barsAreDown = strip.inner >= strip.lvh - 8;
    assert.strictEqual(strip.collapsedClass, barsAreDown,
      `bars-collapsed must follow innerHeight vs lvh: ${JSON.stringify(strip)}`);
    console.log();
    console.log('  strip ' + JSON.stringify(strip));

    // The root scroller has to actually be unlocked, in every class
    // combination that can coexist with scroll-collapse.
    //
    // WHY GENERATED FROM THE STYLESHEET rather than written out: this failed
    // on the phone against a hand-written check that passed here. Three rules
    // set `overflow: hidden` on body and one of them --
    // body.no-debug.exclusive-fullscreen -- has two classes, so the
    // single-class override lost the cascade. Chrome missed it because the
    // test app was not in no-debug mode and that rule was never live. Reading
    // the rules out of the page means the next one that appears is covered
    // whether or not anyone remembers to come back here.
    //
    // Body's overflow is what propagates to the viewport when html is
    // `visible`, so a body that computes `hidden` is a page that cannot
    // scroll -- which is the whole feature.
    const locked = await page.evaluate(() => {
      const hiders = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of Array.from(rules || [])) {
          if (!rule.selectorText || !rule.style) continue;
          if (rule.style.overflow !== 'hidden' && rule.style.overflowY !== 'hidden') continue;
          for (const part of rule.selectorText.split(',')) {
            const selector = part.trim();
            // Only rules that target body itself; `body.x #child` hides the
            // child, not the viewport.
            if (!/^body(\.[\w-]+)*$/.test(selector)) continue;
            hiders.push(selector.split('.').slice(1));
          }
        }
      }
      const original = document.body.className;
      const bad = [];
      for (const classes of hiders) {
        document.body.className = classes.concat(['scroll-collapse']).join(' ');
        const overflow = getComputedStyle(document.body).overflowY;
        if (overflow === 'hidden') bad.push(classes.join('.') + ' -> ' + overflow);
      }
      document.body.className = original;
      return { count: hiders.length, bad };
    });
    assert(locked.count >= 2,
      `the stylesheet scan must find the body overflow rules: ${JSON.stringify(locked)}`);
    assert.deepStrictEqual(locked.bad, [],
      'scroll-collapse must out-specify every rule that locks body overflow');
    console.log(`  scroller  ${locked.count} body-overflow rules, all overridden`);
    assert.strictEqual(strip.gutterShown, !barsAreDown,
      `the strip is shown exactly while a collapse is still available: ${JSON.stringify(strip)}`);

    const scrolled = await page.evaluate(() => {
      window.scrollTo(0, 999);
      const rect = document.getElementById('screen').getBoundingClientRect();
      return { top: rect.top, left: rect.left, height: rect.height, scrollY: window.scrollY };
    });
    assert(scrolled.scrollY > 0, 'the page really scrolled');
    assert(Math.abs(scrolled.top) <= 1 && Math.abs(scrolled.left) <= 1,
      `scrolling must not move the app off screen, got ${scrolled.left},${scrolled.top}`);
    assert(Math.abs(scrolled.height - after.canvas.height) <= 1,
      'scrolling alone must not resize the guest display');
    await page.evaluate(() => window.scrollTo(0, 0));
    assert(after.hintVisible,
      'iOS Safari keeps its own toolbars over this mode, so say what actually removes them');

    // And it has to give the page back.
    await page.click('#page-fullscreen-exit');
    await page.waitForFunction(() => !document.body.classList.contains('page-fullscreen'),
      { timeout: 5000 });
    const exited = await page.evaluate(layout);
    assert(!exited.exitVisible, 'the exit control belongs to full screen only');
    // The consent bar is the way back IN after the exit chip, so it has to
    // return for an app that still holds the display. Asserted off the class
    // rather than off the run, because winmine is not really an exclusive app
    // and the renderer takes the display back on its next repaint -- which is
    // itself correct, and is why `exited` above shows neither class.
    const backIn = await page.evaluate(() => {
      document.body.classList.add('exclusive-fullscreen');
      const el = document.getElementById('browser-fullscreen-consent');
      const shown = getComputedStyle(el).display !== 'none';
      document.body.classList.remove('exclusive-fullscreen');
      return shown;
    });
    assert(backIn, 'an app still holding the display offers the way back into full screen');
    assert(!exited.scrollCollapse && !exited.gutterVisible,
      'the swipe strip and its spacer belong to full screen only');

    // ---- the chip on an app that STAYS exclusive -------------------------
    //
    // Everything above is measured on winmine, which is not really an
    // exclusive app: the repaint right after the chip recomputes exclusive as
    // false all by itself, so both classes come off and the exit looks clean.
    // A full-screen game does not do that. Its window still satisfies the
    // exclusive test on every later repaint, and _setExclusiveFullscreen's
    // "already in this state" early return then means the chip removes
    // page-fullscreen and NOTHING puts exclusive-fullscreen back down --
    // which hides #desktop-icons, the only launcher a phone has. Reported as
    // "cannot launch new app after closing previous - stuck in green
    // desktop".
    //
    // Pinned to the renderer's own decision rather than to a real game so the
    // check costs no extra boot: force the exclusive verdict true and let the
    // repaint loop keep asserting it, which is exactly what a game does.
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      const renderer = app.wine.renderer;
      // The chip above latched a decline, and that latch is doing its job:
      // nothing the guest does may put full screen back on its own. Asking
      // again is the user's move, so make it here before the exclusive app
      // arrives -- otherwise this stage would be testing the latch it just
      // set rather than the exit path.
      approveBrowserFullscreen();
      renderer._isExclusiveFullscreenWindow = () => true;
      renderer.repaint();
    });
    await page.waitForFunction(
      () => document.body.classList.contains('page-fullscreen'), { timeout: 5000 });
    await page.click('#page-fullscreen-exit');
    // Several repaints' worth: the failure is not in the click, it is in what
    // the frames after it put back.
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.evaluate(() => {
      const app = runningApps.find(item => item && item.name === 'winmine_wep');
      for (let i = 0; i < 5; i++) app.wine.renderer.repaint();
    });
    const stuck = await page.evaluate(layout);
    await page.screenshot({ path: path.join(OUT, 'exclusive-exited.png') });
    assert(!stuck.pageFullscreen,
      `the chip must stay pressed: ${stuck.classes}`);
    assert(!stuck.classes.includes('exclusive-fullscreen'),
      `leaving full screen must hand the display back, not keep the half that ` +
      `hides the launcher: ${stuck.classes}`);
    assert(await page.evaluate(() =>
      getComputedStyle(document.getElementById('desktop-icons')).display !== 'none' ||
      document.body.classList.contains('app-running')),
      'the desktop icons must not be hidden by a full-screen mode nobody is in');
    // Deliberately NOT asserting that full screen is taller than the framed
    // page. In no-debug mode our own chrome is already gone, so on this
    // viewport both are the full 664 and the numbers are equal -- what the
    // mode actually buys on iOS is Safari's two toolbars, and Chrome has no
    // retractable toolbars to give back. The spacer/gutter checks above are
    // the only thing that can be asserted about that from here.
    assert(after.canvas.height >= framed.canvas.height - 1,
      `full screen must never give the app less room: ${after.canvas.height} vs ${framed.canvas.height}`);

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
