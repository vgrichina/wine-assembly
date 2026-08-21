#!/usr/bin/env node

// The guest's main thread running in a Web Worker, with host imports brokered
// back to the main thread (lib/guest-rpc.js, lib/guest-worker.js).
//
// Only reachable from a browser: it needs a Worker, a shared WebAssembly.Memory
// that survives postMessage, and therefore cross-origin isolation — so this
// test's own server sends COOP/COEP, which is also what makes the mode testable
// at all before the service-worker route is deployed anywhere.
//
// What it asserts is PARITY, not just liveness. The same app launched both ways
// must create the same windows: worker mode has already produced two failures
// that looked fine from the outside — a caption-less window because the guest's
// message wait was never resumed, and MFC refusing to load because set_winver
// was written to the idle main-thread instance. Both were invisible without a
// side-by-side count.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'worker-guest');
const SECONDS = Number(process.env.WORKER_GUEST_SECONDS || 18);

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for worker-guest test');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.wat': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.exe': 'application/octet-stream', '.dll': 'application/octet-stream',
  '.fon': 'application/octet-stream', '.ttf': 'font/ttf', '.mid': 'audio/midi',
};

function startIsolatedServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const full = path.join(root, pathname);
    if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        // The whole point: without these a shared memory cannot reach a Worker.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      fs.createReadStream(full).pipe(res).on('error', () => res.destroy());
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function launch(browser, port, app, { threaded }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 820 });
  const problems = [];
  page.on('pageerror', e => problems.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|not supported in worker mode|trapped/i.test(t)) {
      problems.push(t);
    }
  });
  await page.evaluateOnNewDocument(v => {
    localStorage.setItem('wine-assembly.threads', v);
  }, threaded ? '1' : '0');
  await page.goto(`http://127.0.0.1:${port}/index.html?debug`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('typeof launchApp === "function"', { timeout: 30000 });

  const isolated = await page.evaluate(() => crossOriginIsolated);
  assert(isolated, 'test server must make the page cross-origin isolated');

  await page.evaluate(name => {
    const sel = document.getElementById('app-select');
    if (sel && ![...sel.options].some(o => o.value === name)) {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    }
    if (sel) sel.value = name;
    launchApp();
  }, app);

  await wait(SECONDS * 1000);

  const state = await page.evaluate(() => {
    const running = (typeof runningApps !== 'undefined' && runningApps[0]) || null;
    const wine = running ? running.wine : null;
    const gw = wine && wine.guestWorker;
    return {
      threaded: !!gw,
      broker: gw && gw.broker ? gw.broker.stats() : null,
      slices: gw ? gw.sliceStats.slices : 0,
      windows: wine && wine.renderer && wine.renderer.windows
        ? Object.keys(wine.renderer.windows).length : 0,
      titles: wine && wine.renderer && wine.renderer.windows
        ? Object.values(wine.renderer.windows).map(w => w && w.title).filter(Boolean).sort() : [],
    };
  });

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${app}-${threaded ? 'worker' : 'single'}.png`) });
  await page.close();
  return { state, problems };
}

// Phase 2: the guest's OWN threads, each in its own Worker, all running at once.
//
// Winamp is the probe because it is the corpus app that genuinely threads: press
// Play and it creates a decode thread, an output thread and a visualizer helper.
// Nothing else here reaches CreateThread at all — notepad and calc never call it,
// so the parity checks above cannot see this code path.
//
// What this catches, and did: worker mode handled a parked WaitForSingleObject by
// clearing the yield. $run has already popped the return address by then, so that
// left the stdcall arguments on the guest stack — 12 bytes leaked per wait, and
// Winamp died at EIP=0xffffffff about six seconds into playback. It was invisible
// until guest threads ran, because until then nothing ever satisfied a wait.
async function guestThreadsProbe(browser, port) {
  const problems = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 820 });
  page.on('pageerror', e => problems.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (/RuntimeError|LinkError|trapped|worker spawn .* failed/i.test(t)) problems.push(t);
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('wine-assembly.threads', '1'));
  await page.goto(`http://127.0.0.1:${port}/index.html?debug`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('typeof launchApp === "function"', { timeout: 30000 });
  await page.evaluate(() => { document.getElementById('app-select').value = 'winamp'; launchApp(); });
  await wait(10000);

  // Same sequence as the CLI audio test: dismiss the survey, then click the real
  // Play button at (66,129) in the main window.
  await page.keyboard.press('Enter');
  await wait(1500);
  await page.keyboard.press('Escape');
  await wait(1500);
  const box = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height };
  });
  await page.mouse.click(box.x + 66 * (box.w / box.cw), box.y + 129 * (box.h / box.ch));

  // Sampled while playback is live: by the end of the clip every thread has
  // exited and a snapshot taken then cannot tell "ran and finished" from "never
  // started".
  let peak = { workers: 0, spawned: 0, active: 0, backend: null };
  for (let i = 0; i < 12; i++) {
    await wait(1000);
    const s = await page.evaluate(() => {
      const wine = (typeof runningApps !== 'undefined' && runningApps[0]) ? runningApps[0].wine : null;
      const tm = wine && wine.threadManager;
      const gw = wine && wine.guestWorker;
      return {
        backend: tm ? tm.backend : null,
        spawned: tm ? tm._spawnedCount : 0,
        workers: gw && gw.threadLinks ? gw.threadLinks.size : 0,
        active: tm ? [...tm.threads.values()].filter(t => t.state === 'active').length : 0,
        slices: tm ? [...tm.threads.values()].reduce(
          (n, t) => n + (t.link && t.link.sliceStats ? t.link.sliceStats.slices : 0), 0) : 0,
        alive: typeof runningApps !== 'undefined' ? runningApps.length : 0,
      };
    });
    if (s.spawned > peak.spawned) peak = Object.assign({}, s);
    if (s.slices > (peak.slices || 0)) peak.slices = s.slices;
    peak.alive = s.alive;
    peak.backend = s.backend || peak.backend;
  }
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'winamp-guest-threads.png') });
  await page.close();
  return { peak, problems };
}

// Launch notepad in worker mode, then exercise the comLoadDll round trip on the
// live worker. msvcrt is the probe DLL: notepad does not load it, so the count
// has to move, and the emulator already runs its DllMain for MFC apps — so a
// failure here is the message path, not the DLL.
async function comLoadDllProbe(browser, port) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('wine-assembly.threads', '1'));
  await page.goto(`http://127.0.0.1:${port}/index.html?debug`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('typeof launchApp === "function"', { timeout: 30000 });
  await page.evaluate(() => { document.getElementById('app-select').value = 'notepad'; launchApp(); });
  // `runningApps` is a module-scope binding in index.html, not a window
  // property, so it has to be referenced bare.
  await page.waitForFunction(
    () => typeof runningApps !== 'undefined' && !!(runningApps[0] && runningApps[0].wine
      && runningApps[0].wine.guestWorker),
    { timeout: 30000 });
  await wait(6000);

  const result = await page.evaluate(async () => {
    const gw = runningApps[0].wine.guestWorker;
    const read = async () => (await gw.readExports(['get_dll_count', 'get_yield_reason', 'get_esp', 'get_eax']));
    const before = await read();
    const bytes = new Uint8Array(await (await fetch('binaries/dlls/msvcrt.dll')).arrayBuffer());
    const hit = await gw.comLoadDll(bytes, 'msvcrt.dll', null);
    const afterHit = await read();

    // Miss path: no bytes at all, which is what a failed fetch produces.
    await gw.comLoadDll(null, 'nosuch.dll', null);
    const afterMiss = await read();

    return {
      dllCountBefore: before.get_dll_count,
      dllCountAfter: afterHit.get_dll_count,
      loadAddr: hit && hit.loadAddr ? hit.loadAddr : 0,
      error: (hit && hit.error) || null,
      yieldAfter: afterHit.get_yield_reason,
      missYield: afterMiss.get_yield_reason,
    };
  });
  await page.close();
  return result;
}

(async () => {
  const server = await startIsolatedServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    headless: true, executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    for (const app of ['notepad', 'calc']) {
      const worker = await launch(browser, port, app, { threaded: true });
      const single = await launch(browser, port, app, { threaded: false });

      check(worker.state.threaded, `${app}: guest runs in a worker`);
      check(!single.state.threaded, `${app}: control run is single-threaded`);
      check(worker.state.slices > 10, `${app}: worker executed slices`,
        `slices=${worker.state.slices}`);
      check(!!worker.state.broker && worker.state.broker.missing.length === 0,
        `${app}: every host import the guest called was found`,
        worker.state.broker ? `served=${worker.state.broker.served} missing=${JSON.stringify(worker.state.broker.missing)}` : '');
      check(worker.state.windows > 0, `${app}: windows exist in worker mode`,
        `windows=${worker.state.windows}`);
      // Parity is the real assertion. A worker-mode run that boots but delivers
      // no messages still creates SOME windows, so only the comparison catches it.
      check(worker.state.windows === single.state.windows,
        `${app}: same window count as single-threaded`,
        `worker=${worker.state.windows} single=${single.state.windows}`);
      check(JSON.stringify(worker.state.titles) === JSON.stringify(single.state.titles),
        `${app}: same window titles as single-threaded`,
        `worker=${JSON.stringify(worker.state.titles)} single=${JSON.stringify(single.state.titles)}`);
      check(worker.problems.length === 0, `${app}: no errors in worker mode`,
        worker.problems.slice(0, 2).join(' | '));
    }

    // Phase 2. Skipped rather than failed without the binary, like the CLI audio
    // test: winamp.exe and demo.mp3 are not in every checkout.
    if (fs.existsSync(path.join(ROOT, 'binaries', 'winamp.exe'))
        || fs.existsSync(path.join(ROOT, 'test', 'binaries', 'winamp.exe'))) {
      const t = await guestThreadsProbe(browser, port);
      check(t.peak.backend === 'worker', 'guest threads use the worker scheduler',
        `backend=${t.peak.backend}`);
      check(t.peak.spawned >= 2, 'playback spawned real guest threads',
        `spawned=${t.peak.spawned} workers=${t.peak.workers}`);
      check(t.peak.workers >= 2, 'each one got its own Worker', `workers=${t.peak.workers}`);
      check((t.peak.slices || 0) > 10, 'and they executed slices', `slices=${t.peak.slices || 0}`);
      check(t.peak.alive === 1, 'the app is still running after playback ends',
        `runningApps=${t.peak.alive}`);
      check(t.problems.length === 0, 'no traps or failed spawns with guest threads live',
        t.problems.slice(0, 2).join(' | '));
    } else {
      console.log('SKIP  winamp.exe not found — guest-thread probe needs a threading app');
    }

    // The COM server load (yield reason 3) has no corpus app that reaches it —
    // it needs a CLSID registered in HKCR pointing at a DLL that is not loaded,
    // and nothing we ship does that. So drive the ported message path directly:
    // it is the half that only exists in worker mode, and an untested branch
    // there is what left worker mode stopping on this yield in the first place.
    const com = await comLoadDllProbe(browser, port);
    check(com.dllCountBefore >= 0 && com.dllCountAfter === com.dllCountBefore + 1,
      'comLoadDll loads the server into the worker instance',
      `dll_count ${com.dllCountBefore} -> ${com.dllCountAfter}`);
    check(com.loadAddr > 0, 'comLoadDll reports the load address', `0x${(com.loadAddr >>> 0).toString(16)}`);
    check(!com.error, 'comLoadDll reported no error', com.error || '');
    // Reason 3 specifically: the app under the probe is a live notepad, so it is
    // normally parked on a message_wait (7) and re-parks between reads. What
    // matters is that it is not left parked on the COM yield.
    check(com.yieldAfter !== 3, 'comLoadDll does not leave the guest parked on the COM yield',
      `yield=${com.yieldAfter}`);
    check(com.missYield !== 3, 'a COM server that cannot be fetched also unparks',
      `yield=${com.missYield}`);
    // NOT asserted here: that the miss path returns REGDB_E_CLASSNOTREG in EAX
    // and drops the return address plus 5 stdcall args. Both are only observable
    // on a guest actually parked mid-CoCreateInstance, which needs an app that
    // registers a COM server in HKCR for a DLL we do not preload — nothing in
    // the corpus does. The 24-byte figure is taken from the synchronous error
    // path in 09a7-handlers-dispatch.wat, which the WAT reaches for the same
    // frame; if a COM app ever lands in the corpus, assert it here.
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error('test-worker-guest failed:', err); process.exit(1); });
