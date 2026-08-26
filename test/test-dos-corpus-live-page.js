'use strict';

// The Run button, in a real browser.
//
// test-toyvm-browser-bundle.js proves the VM survives being packed into a
// script, and test-toyvm-live.js proves the driver chunks and takes keys. What
// neither can see is the page: whether the button is wired to the right demo,
// whether the lazily-appended <script> tags actually load from where the page
// says they are, and whether anything reaches the canvas.
//
// Those are exactly the failures that look fine from Node and show a black
// rectangle to a person, so this opens docs/dos-corpus/index.html, clicks a
// tile's Run button and reads the pixels back off the canvas.
//
// It runs over http rather than file://, because puppeteer's file:// origin
// rules are not the ones a person double-clicking the page gets, and a test
// that passes under a laxer origin than the real one is worse than no test.
// The file:// path is what the <script>-tag design is FOR, and it is checked by
// the shape of the code rather than here.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'dos-corpus');
// The installed browser, the way the other web tests here find it -- puppeteer
// has no downloaded Chrome in this tree.
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.json': 'application/json', '.css': 'text/css',
};

function serve(dir) {
  return new Promise((ok) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(dir, rel);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('no'); return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

async function main() {
  for (const f of ['index.html', 'live/toyvm-bundle.js', 'live/programs.js']) {
    assert.ok(fs.existsSync(path.join(DOCS, f)),
      `docs/dos-corpus/${f} is missing -- run bundle-browser.js, bundle-programs.js and sweep-report.js`);
  }

  const server = await serve(DOCS);
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });

    // A tile that ships its bytes. There is at least one or the payload was
    // never generated, which is a failure worth naming rather than skipping.
    const live = await page.$$('figure[data-live]');
    assert.ok(live.length > 0, 'no tile offers a live run');

    await page.evaluate(() => {
      document.querySelector('figure[data-live] button.open').click();
    });
    // The button is ON the screenshot, so it has to be both present and over
    // the picture -- a control rendered outside the frame is the bug this
    // checks for, and `hidden` alone would not catch it.
    const btn = await page.evaluate(() => {
      const b = document.getElementById('lb-play');
      const s = document.querySelector('.dlg-stage').getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return {
        hidden: b.hidden,
        inside: r.top >= s.top - 1 && r.bottom <= s.bottom + 1
          && r.left >= s.left - 1 && r.right <= s.right + 1,
        stageH: s.height,
      };
    });
    assert.strictEqual(btn.hidden, false,
      'the Run button stayed hidden on a tile that ships its bytes');
    assert.ok(btn.inside, 'the Run button is not over the screenshot');

    const name = await page.$eval('figure[data-live]', (el) => el.dataset.live);
    await page.click('#lb-play');

    // The emulator is half a megabyte of script and then a wasm build, so this
    // waits on the outcome rather than on a timer: pixels on the canvas.
    //
    // The FULLEST frame, not the current one. Several of these demos draw a
    // screen and then clear it -- BOB.COM puts up 128000 lit pixels and blanks
    // a second later, which is the demo's own behaviour and is what the sweep's
    // best-frame photograph shows too. Sampling the live canvas at one arbitrary
    // moment reads that as a black rectangle, so the page keeps the best sample
    // it has seen and the assertions are made about that.
    await page.evaluate(() => {
      self.__best = { lit: 0, colours: 0 };
      self.__sampler = setInterval(() => {
        const cv = document.getElementById('lb-canvas');
        if (cv.hidden || !cv.width) return;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let lit = 0; const colours = new Set();
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] || d[i + 1] || d[i + 2]) lit++;
          colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
        // Ranked by colours first, coverage second. BOB.COM shows why: it
        // floods the screen with one colour before it draws its menu, and both
        // frames light every one of 128000 pixels -- so "fullest" alone keeps
        // the flat one and the menu never wins.
        const b = self.__best;
        if (colours.size < b.colours || (colours.size === b.colours && lit <= b.lit)) return;
        self.__best = {
          lit, colours: colours.size, width: cv.width, height: cv.height,
          imgHidden: document.getElementById('lb-img').hidden,
          playHidden: document.getElementById('lb-play').hidden,
          status: document.getElementById('lb-status').textContent,
        };
      }, 150);
    });
    await page.waitForFunction(() => self.__best.lit > 500, { timeout: 90000, polling: 500 });
    const shot = await page.evaluate(() => {
      clearInterval(self.__sampler);
      return self.__best;
    });

    assert.ok(shot.imgHidden, 'the screenshot is still covering the live canvas');
    assert.ok(shot.playHidden, 'the Run button is still sitting over the running demo');
    // More than one colour: a canvas filled with a single flat colour is what a
    // palette that never arrived looks like, and it would pass a lit-pixel
    // count on its own.
    assert.ok(shot.colours > 2,
      `the live frame is flat (${shot.colours} colour(s)) -- palette or surface is wrong`);
    assert.deepStrictEqual(errors, [], `the page threw: ${errors.join('; ')}`);

    console.log(`PASS test-dos-corpus-live-page: ${live.length} runnable tiles; `
      + `${name} drew ${shot.lit} lit pixels in ${shot.colours} colours `
      + `at ${shot.width}x${shot.height}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
