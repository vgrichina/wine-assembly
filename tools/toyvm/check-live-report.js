#!/usr/bin/env node

'use strict';

// Does every "Run it" button on the site actually start the emulator?
//
//   node tools/toyvm/check-live-report.js                       # every tile
//   node tools/toyvm/check-live-report.js --name=BOB.COM        # just one
//   node tools/toyvm/check-live-report.js --from=100 --count=50 # a slice
//   node tools/toyvm/check-live-report.js --seconds=8 --headful --json=out.json
//   node tools/toyvm/check-live-report.js --name=ACME-VIC.EXE --motion=8  # and does it MOVE
//
// docs/dos-corpus/demos.html ships the whole corpus as bytes, and every tile
// gets a Run button that loads half a megabyte of generated VM and runs the
// program in the tab. The page is built from sweep data by site.js, but the
// bundle under live/ is written separately by bundle-browser.js and
// bundle-programs.js, so the two can drift apart with no error anywhere -- a
// site rebuilt against a newer VM keeps serving an older bundle, and the only
// symptom is a button that does nothing when a visitor presses it.
//
// What it checks, per tile: the button appears, pressing it loads the bundle
// without a console error, the VM dispatches, and the canvas ends up with a
// non-black pixel. "The script loaded" is not "the demo runs" -- the failure
// this was written for is a LiveRun that constructs happily and then paints
// nothing, which from the page looks exactly like a demo still warming up.
//
// A tile the sweep photographed blank is held to what the sweep saw: the VM
// has to start and dispatch, and pixels are reported but not required. The
// page must not promise more than the sweep did, and it must not promise less.
//
// Served over http from a throwaway server rather than opened as file://:
// puppeteer's file:// origin rules are not the ones a person double-clicking
// the page gets, and 199 lazily appended <script> tags are exactly the kind of
// thing that behaves differently between the two.

const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

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
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', '..', 'docs', 'dos-corpus')));
  const pageFile = path.join(dir, 'demos.html');
  if (!fs.existsSync(pageFile)) {
    console.error(`no gallery at ${pageFile} -- build it with tools/toyvm/site.js first`);
    process.exit(2);
  }
  const only = arg('name');
  const seconds = Number(arg('seconds', 6));
  const from = Number(arg('from', 0));
  const count = Number(arg('count', 1e9));
  // --motion[=N]: after the first lit frame, watch for N more seconds and
  // require the picture to change. Off by default because it costs N seconds
  // per tile on a 199-tile run; reach for it when the question is whether a
  // demo is running or merely lit. See runOne.
  const motionSecs = flag('motion') ? 6 : Number(arg('motion', 0));
  const jsonOut = arg('json');

  const server = await serve(dir);
  const port = server.address().port;
  // The system browser, same as tools/profile-web-frames.js: puppeteer's own
  // download is not installed here and a check that cannot find a browser is
  // indistinguishable from a page that does not work.
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: process.env.CHROME
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => errors.push(`${r.url()} ${r.failure()?.errorText}`));

  await page.goto(`http://127.0.0.1:${port}/demos.html`, { waitUntil: 'load' });

  // Every tile, by its unique id: the corpus has two ASYLUM.EXEs, and a name
  // cannot pick one of them.
  const tiles = await page.$$eval('figure[data-live]', (els) => els.map((e) => ({
    id: e.dataset.liveId, name: e.dataset.live, kind: e.dataset.kind,
  })));
  if (!tiles.length) {
    console.log('0 runnable tiles -- the page has no data-live figures.');
    console.log('That means live/programs-index.json named nothing the sweep also had,');
    console.log('so re-run tools/toyvm/bundle-programs.js against the current corpus.');
    await browser.close(); server.close();
    process.exit(1);
  }
  let wanted = only ? tiles.filter((t) => t.name === only) : tiles.slice(from, from + count);
  if (!wanted.length) {
    console.log(`${only} is not a runnable tile. Runnable: ${tiles.map((t) => t.name).join(', ')}`);
    await browser.close(); server.close();
    process.exit(2);
  }

  const total = await page.$$eval('figure', (els) => els.length);
  console.log(`${tiles.length} runnable of ${total} tiles in ${path.relative(process.cwd(), dir)}`
    + (wanted.length !== tiles.length ? `; checking ${wanted.length}` : ''));
  let bad = 0;
  const results = [];
  for (const t of wanted) {
    errors.length = 0;
    const r = await runOne(page, t, seconds, motionSecs);
    const verdict = r.ok ? 'ok' : 'FAILED';
    console.log(`  ${t.name.padEnd(16)} ${verdict.padEnd(7)} ${r.note}`
      + (errors.length ? `\n      console: ${errors.slice(0, 3).join(' | ')}` : ''));
    results.push({ ...t, ...r, errors: errors.slice(0, 3) });
    if (!r.ok) bad++;
  }
  await browser.close();
  server.close();
  if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 1)}\n`);
  console.log(bad ? `\n${bad} of ${wanted.length} did not run.` : `\nall ${wanted.length} ran.`);
  process.exit(bad ? 1 : 0);
}

// One tile, start to finish: open it, press Run, wait, read the canvas back.
// The canvas is read as a pixel histogram rather than a hash because the
// question is "is anything on it", and a hash cannot tell an all-black surface
// from a painted one.
//
// `motionSecs` asks the other half of the question. A lit canvas is not a
// running demo: a program that gets as far as its loader screen and then
// wanders into a jump table paints a full 64,000 pixels and then paints them
// forever, which reads here as an unqualified pass. ACME-VIC.EXE was exactly
// that for as long as it was loaded at the default address. So with --motion
// the sample keeps going after the first lit frame and carries a checksum
// alongside the count: two different checksums are a machine still running,
// one repeated checksum is a picture of a machine that stopped.
async function runOne(page, tile, seconds, motionSecs = 0) {
  const opened = await page.evaluate((id) => {
    const fig = document.querySelector(`figure[data-live-id="${CSS.escape(id)}"]`);
    if (!fig) return false;
    fig.querySelector('button.open').click();
    return true;
  }, tile.id);
  if (!opened) return { ok: false, note: 'no tile with that data-live-id' };

  const hasButton = await page.evaluate(() => {
    const b = document.getElementById('lb-play');
    return !!b && !b.hidden;
  });
  if (!hasButton) return { ok: false, note: 'lightbox opened but the Run button stayed hidden' };

  await page.evaluate(() => document.getElementById('lb-play').click());
  // Poll rather than sleep: a bundle that fails to load says so immediately and
  // there is no reason to hold the whole budget for it.
  const deadline = Date.now() + (seconds + motionSecs) * 1000;
  let lit = 0, dispatched = 0, status = '';
  let motionUntil = 0;
  const distinct = new Set();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const s = await page.evaluate(() => {
      const c = document.getElementById('lb-canvas');
      const note = document.getElementById('lb-status');
      let lit = 0, sum = 0;
      if (c && !c.hidden) {
        const g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] || d[i + 1] || d[i + 2]) lit++;
          // A cheap order-sensitive checksum: enough to tell one frame from
          // the next, and it costs one pass we were already making.
          sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) & 0x7FFFFFFF;
        }
      }
      return {
        lit, sum,
        dispatched: (self.liveRun && self.liveRun.session
          && self.liveRun.session.dispatched) || 0,
        status: note ? note.textContent : '',
      };
    });
    lit = s.lit; dispatched = s.dispatched; status = s.status;
    if (lit > 0) {
      if (!motionSecs) break;
      // Keep sampling for the motion window, then stop whether or not the
      // frame ever changed -- "it did not move" is an answer, not a timeout.
      if (!motionUntil) motionUntil = Date.now() + motionSecs * 1000;
      distinct.add(s.sum);
      if (Date.now() >= motionUntil) break;
      continue;
    }
    // A blank-as-swept tile is done as soon as the VM is demonstrably running;
    // waiting the whole budget for pixels the sweep never saw is not a check.
    if (tile.kind === 'blank' && dispatched > 1e6) break;
  }

  await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    if (d) d.close();
  });

  // Dispatches but no pixels is a real state, not a pass: it is what a demo
  // that is still unpacking looks like, and also what a broken video path
  // looks like. Say which one the numbers support instead of picking.
  const moved = distinct.size;
  const px = `${lit.toLocaleString()} lit px, ${dispatched.toLocaleString()} dispatches`
    + (motionSecs ? `, ${moved} distinct frame(s) over ${motionSecs}s` : '');
  if (lit > 0) {
    // Asked for motion and got none: a lit canvas that never changes is a
    // photograph, and calling it a pass is how a demo that stopped stays
    // green. Not asked for, not judged.
    if (motionSecs && moved < 2) {
      return { ok: false, lit, dispatched, moved, note: `${px} -- the frame never changed` };
    }
    return { ok: true, lit, dispatched, moved, note: px };
  }
  if (dispatched > 0) {
    if (tile.kind === 'blank') return { ok: true, lit, dispatched, note: `${px} (blank as swept)` };
    return { ok: false, lit, dispatched, note: `ran ${dispatched.toLocaleString()} dispatches but painted nothing (status: ${status || 'none'})` };
  }
  return { ok: false, lit, dispatched, note: `the VM never started (status: ${status || 'none'})` };
}

main().catch((e) => { console.error(e); process.exit(1); });
