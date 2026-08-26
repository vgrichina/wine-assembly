#!/usr/bin/env node
// The scroll-collapse lab pages must at least LOAD.
//
// They exist to be opened on a phone that is not on this desk, and the whole
// point of them is that a wrong reading is worse than no reading -- a page
// that throws halfway through its setup still shows a green readout, still
// posts lines to the server, and reports the shape it never finished building.
// That is exactly how "just opens white page for me" happened once already.
//
// Chrome cannot test the behaviour (it has no retractable toolbars, so lvh and
// innerHeight are the same number and nothing ever collapses). It can test
// that every page parses, runs its own script without throwing, builds the
// elements its readout claims, and reports through the shared instrument.

'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'plain.html', 'spacer.html', 'fixed.html', 'scroller.html'];
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for ios-lab test');
  process.exit(0);
}

// The pages post to same-origin /ios-report, so they need a server that
// answers it -- served from a file:// URL they would log fetch failures and
// the eval channel would not exist at all.
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'POST' || url.pathname === '/ios-cmd') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('[]');
        return;
      }
      const file = path.join(ROOT, url.pathname);
      fs.readFile(file, (error, data) => {
        if (error) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, {
          'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html',
        });
        response.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  try {
    for (const name of PAGES) {
      const errors = [];
      const onError = error => errors.push(String(error));
      const onConsole = message => {
        if (message.type() === 'error') errors.push(message.text());
      };
      page.on('pageerror', onError);
      page.on('console', onConsole);

      const url = `http://127.0.0.1:${port}/tools/ios-lab/${name}`;
      const response = await page.goto(url, { waitUntil: 'load' });
      assert.strictEqual(response.status(), 200, `${name} must serve`);

      const seen = await page.evaluate(() => ({
        lab: document.body.dataset.lab,
        line: window.Lab && window.Lab.line(),
        readout: !!document.getElementById('lab-readout'),
        text: document.getElementById('lab-readout').textContent,
      }));

      assert(seen.lab, `${name} must name itself for the log`);
      assert(seen.readout, `${name} must show the readout`);
      assert(/v\d+ range \d+\.\.\d+/.test(seen.line), `${name} readout: ${seen.line}`);
      assert(seen.text.startsWith(seen.lab), `${name} readout must carry the page name`);
      // A page that never overflows can never collapse anything, so this is
      // the one property the lab cannot be wrong about.
      if (name !== 'scroller.html' && name !== 'index.html') {
        const room = await page.evaluate(() =>
          document.documentElement.scrollHeight - window.innerHeight);
        assert(room > 200, `${name} must overflow enough to scroll: ${room}px`);
      }
      assert.deepStrictEqual(errors, [], `${name} must load without errors`);

      page.off('pageerror', onError);
      page.off('console', onConsole);
      console.log(`  ok  ${name.padEnd(14)} ${seen.lab.padEnd(10)} ${seen.line.split('\n')[0]}`);
    }

    // The C page's knobs are the A/B instrument -- if a param stops being read
    // the two runs silently measure the same shape and agree for a bad reason.
    const shapes = [
      ['?spacer=dvh&gutter=44&right=40&autohide=0', 'C-dvh44'],
      ['?spacer=svh&gutter=96', 'C-svh96a'],
    ];
    for (const [query, expected] of shapes) {
      await page.goto(`http://127.0.0.1:${port}/tools/ios-lab/fixed.html${query}`,
        { waitUntil: 'load' });
      const seen = await page.evaluate(() => ({
        lab: document.body.dataset.lab,
        note: window.LabNote(),
        gutter: document.getElementById('gutter').getBoundingClientRect().height,
      }));
      assert.strictEqual(seen.lab, expected, `${query} -> ${seen.lab}`);
      assert(/lvh\d+ strip=(on|off)/.test(seen.note), `strip state: ${seen.note}`);
      const wanted = query.includes('gutter=44') ? 44 : 96;
      assert.strictEqual(Math.round(seen.gutter), wanted,
        `${query} must build a ${wanted}px strip`);
      console.log(`  ok  ${expected.padEnd(10)} ${seen.note} h=${Math.round(seen.gutter)}`);
    }

    console.log('PASS test-web-ios-lab');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
