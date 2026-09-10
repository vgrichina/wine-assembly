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
const { startStaticServer: startSharedStaticServer } = require('./static-server');
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
  return startSharedStaticServer({
    root: ROOT,
    mimeTypes: MIME,
    cacheControl: 'no-cache',
    crossOriginIsolated: true,
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function clickGuest(page, x, y) {
  const point = await page.evaluate(({ x, y }) => {
    const canvas = document.getElementById('screen');
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (x / canvas.width) * rect.width,
      y: rect.top + (y / canvas.height) * rect.height,
    };
  }, { x, y });
  await page.mouse.click(point.x, point.y);
}

async function launch(browser, port, app, { threaded }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 820 });
  const problems = [];
  let boardChanged = 0;
  page.on('pageerror', e => problems.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|not supported in worker mode|trapped/i.test(t)) {
      problems.push(t);
    }
  });
  // Every page starts without a persisted preference. Exercise the actual UI
  // switch instead of smuggling the mode in through localStorage: real threads
  // must remain off until the checkbox is checked.
  await page.evaluateOnNewDocument(() => {
    localStorage.removeItem('wine-assembly.threads');
  });
  await page.goto(`http://127.0.0.1:${port}/index.html?debug`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('typeof launchApp === "function"', { timeout: 30000 });

  const isolated = await page.evaluate(() => crossOriginIsolated);
  assert(isolated, 'test server must make the page cross-origin isolated');

  const controls = await page.evaluate(async on => {
    const box = document.getElementById('threads-toggle');
    const initial = { checked: box.checked, enabled: window.WINE_THREADS };
    box.checked = on;
    await setThreads(box.checked);
    return {
      initial,
      checked: box.checked,
      enabled: window.WINE_THREADS,
      stored: localStorage.getItem('wine-assembly.threads'),
    };
  }, threaded);

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

  if (app === 'wep16_rodent') {
    await page.waitForFunction(name => {
      const running = (typeof runningApps !== 'undefined')
        ? runningApps.find(item => item && item.name === name) : null;
      const wine = running && running.wine;
      const windows = wine && wine.renderer && wine.renderer.windows
        ? Object.values(wine.renderer.windows) : [];
      return !!(wine && wine.guestWorker && wine.guestWorker.sliceStats.slices > 10
        && windows.filter(win => win && win.visible).length >= 2);
    }, { timeout: 120000 }, app);
    await page.waitForFunction(() => {
      const canvas = document.getElementById('screen');
      const pixels = canvas.getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 40 && pixels[i + 1] > 90 && pixels[i + 1] < 180
            && pixels[i + 2] < 80 && ++green > 10000) return true;
      }
      return false;
    }, { timeout: 60000, polling: 250 });
    const menu = await page.evaluate(() => {
      const win = Object.values(sharedRenderer.windows)
        .find(item => item && item.visible && /^Rodent's Revenge \[\d+\]$/.test(item.title || ''));
      return {
        gameX: win.x + 32, gameY: win.y + 38,
        newX: win.x + 42, newY: win.y + 59,
      };
    });
    await clickGuest(page, menu.gameX, menu.gameY);
    await wait(120);
    await clickGuest(page, menu.newX, menu.newY);
    await page.waitForFunction(() => {
      const wine = runningApps[0] && runningApps[0].wine;
      const focus = wine && (wine._workerFocusHwnd | 0);
      const focused = focus && sharedRenderer.windows[focus];
      return !!(focused && focused.isChild && focused.w >= 250 && focused.h >= 250);
    }, { timeout: 10000, polling: 50 });
    await wait(300);
    await page.evaluate(() => {
      const win = Object.values(sharedRenderer.windows)
        .find(item => item && item.visible && /^Rodent's Revenge \[\d+\]$/.test(item.title || ''));
      const rect = {
        x: win.x + 20, y: win.y + 100,
        w: Math.max(1, win.w - 40), h: Math.max(1, win.h - 120),
      };
      const ctx = document.getElementById('screen').getContext('2d');
      window.__workerRodentBefore = {
        rect,
        pixels: Array.from(ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data),
      };
    });
    await page.keyboard.down('ArrowRight');
    await wait(1200);
    await page.keyboard.up('ArrowRight');
    await wait(500);
    boardChanged = await page.evaluate(() => {
      const before = window.__workerRodentBefore;
      const r = before.rect;
      const after = document.getElementById('screen').getContext('2d')
        .getImageData(r.x, r.y, r.w, r.h).data;
      let changed = 0;
      for (let i = 0; i < after.length; i += 4) {
        if (after[i] !== before.pixels[i] || after[i + 1] !== before.pixels[i + 1] ||
            after[i + 2] !== before.pixels[i + 2] || after[i + 3] !== before.pixels[i + 3]) {
          changed++;
        }
      }
      return changed;
    });
  } else if (app === 'rodent2000') {
    await page.waitForFunction(() => Object.values(sharedRenderer.windows || {}).some(win =>
      win && win.visible && win.w > 300 && /^Rodent's Revenge 2000/.test(win.title || '')),
    { timeout: 120000, polling: 250 });
    const menu = await page.evaluate(() => {
      const win = Object.values(sharedRenderer.windows).find(item =>
        item && item.visible && item.w > 300 && /^Rodent's Revenge 2000/.test(item.title || ''));
      return {
        gameX: win.x + 42, gameY: win.y + 38,
        newX: win.x + 52, newY: win.y + 58,
      };
    });
    await clickGuest(page, menu.gameX, menu.gameY);
    await wait(120);
    await clickGuest(page, menu.newX, menu.newY);
    await page.waitForFunction(() => Object.values(sharedRenderer.windows || {}).some(win =>
      win && win.visible && /Rodent's Revenge 2000 - Level 1/.test(win.title || '')),
    { timeout: 30000, polling: 100 });
    await wait(500);
    await page.evaluate(() => {
      const win = Object.values(sharedRenderer.windows).find(item =>
        item && item.visible && item.w > 300 && /Rodent's Revenge 2000 - Level 1/.test(item.title || ''));
      const rect = {
        x: win.x + 10, y: win.y + 70,
        w: Math.max(1, win.w - 20), h: Math.max(1, win.h - 80),
      };
      const ctx = document.getElementById('screen').getContext('2d');
      window.__workerRodentBefore = {
        rect,
        pixels: Array.from(ctx.getImageData(rect.x, rect.y, rect.w, rect.h).data),
      };
    });
    await page.keyboard.down('ArrowRight');
    await wait(1200);
    await page.keyboard.up('ArrowRight');
    await wait(500);
    boardChanged = await page.evaluate(() => {
      const before = window.__workerRodentBefore;
      const r = before.rect;
      const after = document.getElementById('screen').getContext('2d')
        .getImageData(r.x, r.y, r.w, r.h).data;
      let changed = 0;
      for (let i = 0; i < after.length; i += 4) {
        if (after[i] !== before.pixels[i] || after[i + 1] !== before.pixels[i + 1] ||
            after[i + 2] !== before.pixels[i + 2] || after[i + 3] !== before.pixels[i + 3]) {
          changed++;
        }
      }
      return changed;
    });
  } else {
    await wait(SECONDS * 1000);
  }

  const state = await page.evaluate(() => {
    const running = (typeof runningApps !== 'undefined' && runningApps[0]) || null;
    const wine = running ? running.wine : null;
    const gw = wine && wine.guestWorker;
    const canvas = document.getElementById('screen');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let boardGreen = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 40 && pixels[i + 1] > 90 && pixels[i + 1] < 180
          && pixels[i + 2] < 80) boardGreen++;
    }
    return {
      threaded: !!gw,
      broker: gw && gw.broker ? gw.broker.stats() : null,
      slices: gw ? gw.sliceStats.slices : 0,
      windows: wine && wine.renderer && wine.renderer.windows
        ? Object.keys(wine.renderer.windows).length : 0,
      titles: wine && wine.renderer && wine.renderer.windows
        ? Object.values(wine.renderer.windows).map(w => w && w.title).filter(Boolean).sort() : [],
      boardGreen,
      focusHwnd: wine ? (wine._workerFocusHwnd | 0) : 0,
    };
  });
  state.boardChanged = boardChanged;

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${app}-${threaded ? 'worker' : 'single'}.png`) });
  await page.close();
  return { state, problems, controls };
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

  // The checked-in Winamp INI suppresses the first-run survey. Locate the real
  // player window and translate its window-local Play button (40,100) into
  // desktop coordinates. The old hard-coded desktop point (66,129) coupled the
  // probe to one placement and could silently hit the skin instead of Play.
  const clicked = await page.evaluate(() => {
    const wine = (typeof runningApps !== 'undefined' && runningApps[0])
      ? runningApps[0].wine : null;
    const windows = wine && wine.renderer && wine.renderer.windows
      ? Object.values(wine.renderer.windows) : [];
    const main = windows.find(w => w && w.visible && (w.w | 0) === 275
      && /Winamp/.test(w.title || ''));
    if (!main || !wine.renderer) return false;
    const x = main.x + 40;
    const y = main.y + 100;
    wine.renderer.handleMouseDown(x, y, 0);
    wine.renderer.handleMouseUp(x, y, 0);
    return true;
  });
  if (!clicked) throw new Error('Winamp player window did not become visible');

  // Sampled while playback is live: by the end of the clip every thread has
  // exited and a snapshot taken then cannot tell "ran and finished" from "never
  // started".
  // Keep the original 12 samples. A main slice can spend seconds servicing
  // RPCs before child scheduling resumes; allow bounded readiness recovery
  // without clicking Play again or relaxing any assertion.
  const sampleStarted = Date.now();
  const sampleDeadline = sampleStarted + 60000;
  let readyAtMs = null;
  let firstProgress = null;
  let lastProgress = null;
  const isReady = p => p.backend === 'worker' && p.spawned >= 2
    && p.workers >= 2 && (p.slices || 0) > 10;
  let peak = { workers: 0, spawned: 0, active: 0, backend: null };
  for (let i = 0; Date.now() < sampleDeadline
      && (i < 12 || !isReady(peak)); i++) {
    await wait(Math.max(0, Math.min(1000, sampleDeadline - Date.now())));
    if (Date.now() >= sampleDeadline) break;
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
        progress: {
          mainPending: gw && gw.link ? gw.link._pending.size : 0,
          mainSlices: gw && gw.link ? gw.link.sliceStats.slices : 0,
          rpcServed: gw && gw.link && gw.link.broker
            ? gw.link.broker.stats().served : 0,
        },
      };
    });
    if (s.spawned > peak.spawned) peak = Object.assign({}, s);
    if (s.slices > (peak.slices || 0)) peak.slices = s.slices;
    peak.alive = s.alive;
    peak.backend = s.backend || peak.backend;
    lastProgress = { elapsedMs: Date.now() - sampleStarted, ...s.progress };
    if (!firstProgress) firstProgress = lastProgress;
    if (readyAtMs === null && isReady(peak)) readyAtMs = lastProgress.elapsedMs;
  }
  console.log('Winamp worker readiness:', JSON.stringify({
    readyAtMs, elapsedMs: Date.now() - sampleStarted,
    ...(readyAtMs === null ? { firstProgress, lastProgress } : {}),
  }));
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

      check(!worker.controls.initial.checked && !worker.controls.initial.enabled,
        `${app}: threads are disabled before the checkbox is selected`);
      check(worker.controls.checked && worker.controls.enabled && worker.controls.stored === '1',
        `${app}: checking Threads enables and persists worker mode`);
      check(!single.controls.checked && !single.controls.enabled && single.controls.stored === '0',
        `${app}: leaving Threads unchecked selects cooperative mode`);
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

    // Win16 is not a cooperative exception to the switch. Its NE image, DLL
    // selector arena and far-import fixups must all be initialized inside slot
    // 0's Worker instance; loading those DLLs into the idle main-thread token
    // used to trap RODENT at its first VBRUN100 far jump (EIP 0x100010).
    const win16 = await launch(browser, port, 'wep16_rodent', { threaded: true });
    check(win16.state.threaded, 'Win16 main task stays in the guest Worker');
    check(win16.state.slices > 10, 'Win16 Worker executes past NE startup',
      `slices=${win16.state.slices}`);
    check(win16.state.windows >= 8, 'Win16 Worker creates the Rodent board windows',
      `windows=${win16.state.windows}`);
    check(win16.state.titles.some(title => /^Rodent's Revenge(?: \[\d+\])?$/.test(title)),
      'Win16 Worker retains the Rodent window title',
      `titles=${JSON.stringify(win16.state.titles)}`);
    check(win16.state.boardGreen > 10000, 'Win16 Worker renders the live Rodent board',
      `green=${win16.state.boardGreen}`);
    check(win16.state.boardChanged > 40, 'Win16 Worker routes held arrows to the focused Rodent playfield',
      `changed=${win16.state.boardChanged} focus=0x${(win16.state.focusHwnd >>> 0).toString(16)}`);
    check(win16.problems.length === 0, 'Win16 Worker has no trap or missing import',
      win16.problems.slice(0, 2).join(' | '));

    const remake = await launch(browser, port, 'rodent2000', { threaded: true });
    check(remake.state.threaded, 'Rodent2000 main task stays in the guest Worker');
    check(remake.state.titles.some(title => title === "Rodent's Revenge 2000 - Level 1"),
      'Rodent2000 Worker starts a new game from its real menu',
      `titles=${JSON.stringify(remake.state.titles)}`);
    check(remake.state.boardGreen > 10000, 'Rodent2000 Worker retains the rendered block field',
      `green=${remake.state.boardGreen}`);
    check(remake.state.boardChanged > 40, 'Rodent2000 Worker routes held arrows to the active game form',
      `changed=${remake.state.boardChanged}`);
    check(remake.problems.length === 0, 'Rodent2000 Worker has no trap or missing import',
      remake.problems.slice(0, 2).join(' | '));

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
