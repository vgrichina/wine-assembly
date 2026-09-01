#!/usr/bin/env node
// Frozen (agent-stepped) mode and the multi-session dashboard
// (docs/design-agent-control.md), against a real dev-server and a real Chrome.
//
// The claim being tested is a negative one — "nothing runs" — so the checks
// that matter are the ones that let time pass and assert that a counter did
// NOT move. A frozen page that merely runs slowly would pass a
// screenshot-based test and fail this one.
//
// PASS criteria:
//   - a ?frozen page registers on the hub and runs ZERO slices while idle
//   - `ctl step N` runs work, advances the guest clock, and stops again
//   - png is byte-identical between two commands with no step between them
//   - click + step advances the guest and changes the frame
//   - the ?debug toolbar checkbox freezes and unfreezes a LIVE session
//     mid-run, and mirrors a change made over the agent channel
//   - /dashboard boots two emulators in parallel, each with its own hub
//     session, each answering ping and png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Its own port: 8080 is a human's live session, 8098 is test-web-agent-remote.
const PORT = 8094;

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for agent-frozen test');
  process.exit(0);
}
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) {
  console.log('SKIP  puppeteer not installed');
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-frozen-'));
const ctl = (...args) => execFileSync('node', [CTL, `--hub=http://127.0.0.1:${PORT}`, ...args],
  { encoding: 'utf-8', timeout: 120000, cwd: ROOT });

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${pathname}`, r => {
      let text = '';
      r.on('data', c => { text += c; });
      r.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(text.slice(0, 200))); } });
    }).on('error', reject);
  });
}

const server = spawn('node', [path.join(ROOT, 'tools', 'dev-server.js'), `--port=${PORT}`, '--quiet'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

let browser = null;
(async () => {
  const deadline = Date.now() + 60000;
  while (!serverOut.includes('dev server:') && Date.now() < deadline) await sleep(200);
  if (!serverOut.includes('dev server:')) throw new Error(`dev-server never came up:\n${serverOut}`);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

  // ---------------------------------------------------------------- frozen
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?debug&app=sol&frozen`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#screen', { timeout: 15000 });

  // The app launches (?app=sol) but must not RUN: host.js parks the very first
  // slice, so the guest is at instruction zero until somebody steps it.
  const hostUp = await page.waitForFunction(() =>
    window.WineFrozen && window.WineFrozen.status().hosts > 0, { timeout: 60000 })
    .then(() => true).catch(() => false);
  check('?frozen page registered a frozen guest', hostUp, 'no host registered in 60s');

  const toolbar = await page.evaluate(() => ({
    checked: document.getElementById('frozen-toggle').checked,
    badge: document.getElementById('frozen-status').textContent,
  }));
  check('toolbar shows the FROZEN badge and a checked box',
    toolbar.checked && /FROZEN/.test(toolbar.badge), JSON.stringify(toolbar));

  const sliceCount = () => page.evaluate(() => ({
    // `ticks` counts every step BOTH modes retire (host.js `_scheduleStep`),
    // which is the only counter that answers "is anything running at all".
    // `_runSliceCount` is not one — it is bumped only when the guest's main
    // thread was runnable, and an idle app parked in GetMessage takes the
    // other branch forever. Nor is the guest clock: a parked app may not call
    // GetTickCount for seconds at a time.
    ticks: window.WineFrozen.status().ticks | 0,
    slices: (window.wine && window.wine._runSliceCount) | 0,
    steps: window.WineFrozen.status().steps | 0,
    guestMs: window.WineFrozen.status().guestMs | 0,
    // Diagnostics, so a failure names which half broke: is the guest still
    // holding a parked continuation, and does it still consider itself frozen?
    held: !!(window.wine && window.wine._frozenStep),
    frozen: !!(window.wine && window.wine._frozen),
    running: !!(window.wine && window.wine.running),
    budget: (window.wine && window.wine._frozenBudget) | 0,
  }));
  const idleA = await sliceCount();
  await sleep(2500);
  const idleB = await sliceCount();
  check('a frozen page runs zero slices while idle',
    idleA.ticks === idleB.ticks && idleA.steps === idleB.steps && idleA.guestMs === idleB.guestMs,
    `${JSON.stringify(idleA)} -> ${JSON.stringify(idleB)}`);

  // Find this page's session on the hub.
  let sessionId = null;
  const connectDeadline = Date.now() + 20000;
  while (!sessionId && Date.now() < connectDeadline) {
    const { sessions } = await getJson('/api/agent/sessions');
    const mine = sessions.find(s => /app=sol/.test(s.href) && !/tile=/.test(s.href));
    if (mine) sessionId = mine.id;
    else await sleep(300);
  }
  check('frozen page is on the hub', !!sessionId, 'no session with app=sol');

  const stepped = JSON.parse(ctl('-s', sessionId, 'step', '1500'));
  const afterStep = await sliceCount();
  check('ctl step runs exactly that much work and stops again',
    stepped.frozen === true && stepped.ran === 1500
    && afterStep.slices > idleB.slices && afterStep.steps === idleB.steps + 1500,
    `${JSON.stringify(stepped)} ${JSON.stringify(afterStep)}`);
  // Batch-driven guest clock: 1500 steps x the default 16ms of guest time.
  check('the guest clock is driven by steps, not by the wall',
    afterStep.guestMs >= idleB.guestMs + 1500 * 16 - 16, `${idleB.guestMs} -> ${afterStep.guestMs}`);

  const png = (name) => {
    const out = path.join(tmpDir, name);
    ctl('-s', sessionId, 'png', out);
    return fs.readFileSync(out);
  };
  const frameA = png('a.png');
  await sleep(1500);
  const frameA2 = png('a2.png');
  check('png is byte-stable between commands while frozen',
    frameA.length > 500 && frameA.equals(frameA2),
    `${frameA.length} vs ${frameA2.length} bytes`);

  // click, then step: the click is enqueued exactly as today and the guest
  // consumes it during the step. That pair is the atomic unit of play.
  ctl('-s', sessionId, 'click', '120,90');
  const afterClickNoStep = png('b0.png');
  check('a click alone changes nothing while frozen', afterClickNoStep.equals(frameA),
    `${afterClickNoStep.length} vs ${frameA.length} bytes`);
  ctl('-s', sessionId, 'step', '1500');
  const frameB = png('b.png');
  check('click + step advances the guest and changes the frame',
    !frameB.equals(frameA), `still ${frameB.length} bytes and identical`);

  // The checkbox is the feature: it must freeze and unfreeze mid-session.
  ctl('-s', sessionId, 'frozen', 'off');
  const mirrored = await page.evaluate(() => ({
    checked: document.getElementById('frozen-toggle').checked,
    badge: document.getElementById('frozen-status').textContent,
    frozen: window.WineFrozen.status().frozen,
  }));
  check('the toolbar checkbox mirrors an agent-initiated unfreeze',
    !mirrored.checked && !mirrored.frozen && mirrored.badge === '', JSON.stringify(mirrored));

  const liveA = await sliceCount();
  await sleep(1500);
  const liveB = await sliceCount();
  check('a live page runs slices again after unfreezing',
    liveB.ticks > liveA.ticks, `${JSON.stringify(liveA)} -> ${JSON.stringify(liveB)}`);

  await page.click('#frozen-toggle');
  await sleep(400);            // let any slice already in flight finish and park
  const refrozeA = await sliceCount();
  await sleep(2000);
  const refrozeB = await sliceCount();
  check('checking the box freezes a running session mid-play',
    // `>=` and not `>`: the freeze may land inside the 50ms the parked loop
    // was already sleeping for, so zero further steps is a correct outcome.
    // The claim under test is that the count then stops moving.
    refrozeA.ticks === refrozeB.ticks && refrozeA.ticks >= liveB.ticks,
    `${JSON.stringify(refrozeA)} -> ${JSON.stringify(refrozeB)}`);
  check('freezing raises no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // ------------------------------------------------------------- dashboard
  const dash = await browser.newPage();
  const dashErrors = [];
  dash.on('pageerror', e => dashErrors.push(String(e)));
  await dash.goto(`http://127.0.0.1:${PORT}/dashboard?apps=sol,winmine&frozen`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The dashboard's only moving part is a setInterval status poll, and Chrome
  // throttles timers in a background tab hard enough that it never ran once in
  // 90s of this test. A human watching the grid has it in front; so does this.
  await dash.bringToFront();
  const tileCount = await dash.evaluate(() => document.querySelectorAll('.tile').length);
  check('/dashboard serves the grid and lays out one tile per app', tileCount === 2, `${tileCount} tiles`);

  let tiles = [];
  const tileDeadline = Date.now() + 90000;
  while (tiles.length < 2 && Date.now() < tileDeadline) {
    const { sessions } = await getJson('/api/agent/sessions');
    tiles = sessions.filter(s => /tile=/.test(s.href));
    if (tiles.length < 2) await sleep(500);
  }
  check('the dashboard boots two emulators, each its own hub session',
    tiles.length === 2 && tiles[0].id !== tiles[1].id,
    tiles.map(t => `${t.id} ${t.href}`).join(' | '));

  if (tiles.length === 2) {
    let allOk = true;
    const detail = [];
    for (const tile of tiles) {
      const ping = JSON.parse(ctl('-s', tile.id, 'ping'));
      const out = path.join(tmpDir, `tile-${tile.id}.png`);
      ctl('-s', tile.id, 'png', out);
      const bytes = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
      const ok = ping.pong === true && bytes.length > 500
        && bytes.subarray(1, 4).toString() === 'PNG';
      if (!ok) allOk = false;
      detail.push(`${tile.id}:${ping.kind}:${bytes.length}b`);
    }
    check('every tile answers ctl ping and png on its own session', allOk, detail.join(' '));

    // The tiles were asked to boot frozen, and each one reports its own state.
    // Wait for the status poll to have run at least once first: Chrome defers
    // a background tab's timers, and this page's only moving part is one.
    const polled = await dash.waitForFunction(
      () => document.getElementById('hint').textContent !== '',
      { timeout: 30000, polling: 500 }).then(() => true).catch(() => false);
    const tileState = await dash.evaluate(() => ({
      polled: document.getElementById('hint').textContent,
      hint: document.getElementById('hint').textContent,
      tiles: [...document.querySelectorAll('.tile')].map(t => ({
        frozen: t.querySelector('.tile-foot input').checked,
        state: t.querySelector('.state').textContent,
      })),
    }));
    check('dashboard tiles report their own frozen state',
      polled && tileState.tiles.length === 2
      && tileState.tiles.every(t => t.frozen && /FROZEN/.test(t.state)),
      JSON.stringify(tileState));
  }
  check('dashboard raises no uncaught page errors', dashErrors.length === 0, dashErrors.join(' | '));
})().catch(error => {
  console.log('FAIL  ' + (error && error.stack || error));
  failed = true;
}).finally(async () => {
  try { if (browser) await browser.close(); } catch (_) {}
  try { server.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
