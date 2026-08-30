#!/usr/bin/env node

'use strict';

// Does the corpus report's "Run it" button actually start the emulator?
//
//   node tools/toyvm/check-live-report.js                       # every runnable tile
//   node tools/toyvm/check-live-report.js --name=BOB.COM        # just one
//   node tools/toyvm/check-live-report.js --seconds=8 --headful
//
// docs/dos-corpus/index.html ships twelve demos as bytes, and those tiles get
// a Run button that loads half a megabyte of generated VM and runs the program
// in the tab. Nothing tested that path: the page is built from sweep data by
// sweep-report.js, but the bundle under live/ is written separately by
// bundle-browser.js and bundle-programs.js, so the two can drift apart with no
// error anywhere -- a report rebuilt against a newer VM keeps serving an older
// bundle, and the only symptom is a button that does nothing when a visitor
// presses it.
//
// What it checks, per tile: the button appears, pressing it loads the bundle
// without a console error, and the canvas ends up with a non-black pixel. That
// last one is the point. "The script loaded" is not "the demo runs" -- the
// failure this was written for is a LiveRun that constructs happily and then
// paints nothing, which from the page looks exactly like a demo that is still
// warming up.
//
// A tile that legitimately shows a text screen has no pixels to light, so the
// canvas check is "changed from its initial state", not "is colourful".

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

async function main() {
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', '..', 'docs', 'dos-corpus')));
  const page404 = path.join(dir, 'index.html');
  if (!fs.existsSync(page404)) {
    console.error(`no report at ${page404} -- build it with sweep-report.js first`);
    process.exit(2);
  }
  const only = arg('name');
  const seconds = Number(arg('seconds', 6));

  // The system browser, same as tools/profile-web-frames.js: puppeteer's own
  // download is not installed here and a check that cannot find a browser is
  // indistinguishable from a page that does not work.
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: process.env.CHROME
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => errors.push(`${r.url()} ${r.failure()?.errorText}`));

  await page.goto(`file://${page404}`, { waitUntil: 'load' });

  const names = await page.$$eval('figure[data-live]', (els) => els.map((e) => e.dataset.live));
  if (!names.length) {
    console.log('0 runnable tiles -- the page has no data-live figures.');
    console.log('That means live/programs-index.json named nothing the sweep also had,');
    console.log('so re-run tools/toyvm/bundle-programs.js against the current corpus.');
    await browser.close();
    process.exit(1);
  }
  const wanted = only ? names.filter((n) => n === only) : names;
  if (!wanted.length) {
    console.log(`${only} is not a runnable tile. Runnable: ${names.join(', ')}`);
    await browser.close();
    process.exit(2);
  }

  console.log(`${names.length} runnable tile(s) in ${path.relative(process.cwd(), dir)}`);
  let bad = 0;
  for (const name of wanted) {
    errors.length = 0;
    const r = await runOne(page, name, seconds);
    const verdict = r.ok ? 'ok' : 'FAILED';
    console.log(`  ${name.padEnd(16)} ${verdict.padEnd(7)} ${r.note}`
      + (errors.length ? `\n      console: ${errors.slice(0, 3).join(' | ')}` : ''));
    if (!r.ok) bad++;
  }
  await browser.close();
  console.log(bad ? `\n${bad} of ${wanted.length} did not run.` : `\nall ${wanted.length} ran.`);
  process.exit(bad ? 1 : 0);
}

// One tile, start to finish: open it, press Run, wait, read the canvas back.
// The canvas is read as a pixel histogram rather than a hash because the
// question is "is anything on it", and a hash cannot tell an all-black surface
// from a painted one.
async function runOne(page, name, seconds) {
  const opened = await page.evaluate((n) => {
    const fig = document.querySelector(`figure[data-live="${CSS.escape(n)}"]`);
    if (!fig) return false;
    fig.querySelector('button.open').click();
    return true;
  }, name);
  if (!opened) return { ok: false, note: 'no tile with that data-live' };

  const hasButton = await page.evaluate(() => {
    const b = document.getElementById('lb-play');
    return !!b && !b.hidden;
  });
  if (!hasButton) return { ok: false, note: 'lightbox opened but the Run button stayed hidden' };

  await page.evaluate(() => document.getElementById('lb-play').click());
  // Poll rather than sleep: a bundle that fails to load says so immediately and
  // there is no reason to hold the whole budget for it.
  const deadline = Date.now() + seconds * 1000;
  let lit = 0, dispatched = 0, status = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const s = await page.evaluate(() => {
      const c = document.getElementById('lb-canvas');
      const note = document.getElementById('lb-status');
      let lit = 0;
      if (c && !c.hidden) {
        const g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] || d[i + 1] || d[i + 2]) lit++;
        }
      }
      return {
        lit,
        dispatched: (self.liveRun && self.liveRun.session
          && self.liveRun.session.dispatched) || 0,
        status: note ? note.textContent : '',
      };
    });
    lit = s.lit; dispatched = s.dispatched; status = s.status;
    if (lit > 0) break;
  }

  await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    if (d) d.close();
  });

  // Dispatches but no pixels is a real state, not a pass: it is what a demo
  // that is still unpacking looks like, and also what a broken video path
  // looks like. Say which one the numbers support instead of picking.
  if (lit > 0) return { ok: true, note: `${lit.toLocaleString()} lit px, ${dispatched.toLocaleString()} dispatches` };
  if (dispatched > 0) {
    return { ok: false, note: `ran ${dispatched.toLocaleString()} dispatches but painted nothing (status: ${status || 'none'})` };
  }
  return { ok: false, note: `the VM never started (status: ${status || 'none'})` };
}

main().catch((e) => { console.error(e); process.exit(1); });
