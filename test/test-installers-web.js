#!/usr/bin/env node
'use strict';

// Real-browser UI/completion matrix for the repository's core installer
// corpus: the three entries shared by the Installers dropdown, APPS registry,
// and test-all-exes manifest. Every case runs once with the guest main thread
// cooperative and once in a real Worker.

const assert = require('assert');
const fs = require('fs');
const { startStaticServer: startSharedStaticServer } = require('./static-server');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.INSTALLERS_WEB_OUT ||
  path.join(os.tmpdir(), 'wine-assembly-installers-web');
const CASE_TIMEOUT = Number(process.env.INSTALLERS_WEB_CASE_TIMEOUT || 90000);
const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;

const CASES = [
  { id: 'winamp291_inst', kind: 'winamp', label: 'Winamp 2.91' },
  { id: 'winamp295_inst', kind: 'winamp', label: 'Winamp 2.95' },
  { id: 'mirc59', kind: 'mirc', label: 'mIRC 5.9' },
];

if (!fs.existsSync(CHROME)) {
  console.log('SKIP Chrome not found for installer browser matrix');
  process.exit(0);
}
for (const spec of CASES) {
  const exe = spec.id === 'winamp291_inst' ? 'winamp291.exe'
    : spec.id === 'winamp295_inst' ? 'winamp295.exe' : 'mirc59.exe';
  if (!fs.existsSync(path.join(ROOT, 'test', 'binaries', 'installers', exe))) {
    console.log(`SKIP core installer payload missing: ${exe}`);
    process.exit(0);
  }
}
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png',
  '.exe': 'application/octet-stream', '.dll': 'application/octet-stream',
  '.fon': 'application/octet-stream', '.ttf': 'font/ttf',
};

function startServer() {
  return startSharedStaticServer({ root: ROOT, mimeTypes: MIME, crossOriginIsolated: true });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(label, probe, timeout = CASE_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last && last.pass) return last.value;
    } catch (error) {
      last = { error: error && error.message || String(error) };
    }
    await wait(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function runtimeState(page, appId) {
  return page.evaluate(id => {
    const app = runningApps.find(item => item && item.name === id);
    return {
      present: !!app,
      running: !!(app && app.wine && app.wine.running),
      worker: !!(app && app.wine && app.wine.guestWorker),
      threadsStatus: document.getElementById('threads-status').textContent,
      titles: Object.values(sharedRenderer.windows || {})
        .filter(win => win && win.visible).map(win => win.title || ''),
    };
  }, appId);
}

// Locate the WAT-owned dialog and one direct control. The shared renderer owns
// only top-level/page canvases; native NSIS/mIRC controls live in WAT, so their
// exported geometry is the authoritative hit target in both backends.
async function controlState(page, appId, controlId) {
  return page.evaluate(async ({ id, controlId }) => {
    const app = runningApps.find(item => item && item.name === id);
    if (!app || !app.wine || !app.wine.running) return null;
    const wine = app.wine;
    const call = (name, ...args) => Promise.resolve(wine.callGuest(name, ...args));
    let dialog = 0;
    for (const win of Object.values(sharedRenderer.windows || {})) {
      if (!win || !win.visible) continue;
      try {
        if ((await call('dlg_get_ctrl_count', win.hwnd)) > 0) {
          dialog = win.hwnd >>> 0;
          break;
        }
      } catch (_) {}
    }
    if (!dialog) return null;
    let slot = 0;
    for (let guard = 0; guard < 512; guard++) {
      slot = await call('wnd_next_child_slot', dialog, slot) | 0;
      if (slot < 0) break;
      const hwnd = await call('wnd_slot_hwnd', slot) >>> 0;
      slot++;
      if ((await call('ctrl_get_id', hwnd) | 0) !== controlId) continue;
      const style = await call('wnd_get_style_export', hwnd) >>> 0;
      const x = await call('wnd_window_screen_x', hwnd) | 0;
      const y = await call('wnd_window_screen_y', hwnd) | 0;
      const width = await call('wnd_screen_w', hwnd) | 0;
      const height = await call('wnd_screen_h', hwnd) | 0;
      return { dialog, hwnd, style, x, y, width, height };
    }
    return { dialog, missing: true };
  }, { id: appId, controlId });
}

async function controlText(page, appId, controlId, getter) {
  return page.evaluate(async ({ id, controlId, getter }) => {
    const app = runningApps.find(item => item && item.name === id);
    if (!app || !app.wine || !app.wine.running) return '';
    const wine = app.wine;
    const call = (name, ...args) => Promise.resolve(wine.callGuest(name, ...args));
    let dialog = 0;
    for (const win of Object.values(sharedRenderer.windows || {})) {
      if (!win || !win.visible) continue;
      try {
        if ((await call('dlg_get_ctrl_count', win.hwnd)) > 0) {
          dialog = win.hwnd >>> 0;
          break;
        }
      } catch (_) {}
    }
    if (!dialog) return '';
    let target = 0;
    let slot = 0;
    for (let guard = 0; guard < 512; guard++) {
      slot = await call('wnd_next_child_slot', dialog, slot) | 0;
      if (slot < 0) break;
      const hwnd = await call('wnd_slot_hwnd', slot) >>> 0;
      slot++;
      if ((await call('ctrl_get_id', hwnd) | 0) === controlId) { target = hwnd; break; }
    }
    if (!target) return '';
    const buffer = await call('guest_alloc', 512) >>> 0;
    const length = await call(getter, target, buffer, 512) | 0;
    const imageBase = await call('get_image_base') >>> 0;
    const offset = memUtils.g2w(buffer, imageBase, wine.memory);
    // TextDecoder rejects views backed by SharedArrayBuffer in browsers.
    // Copy the guest bytes so this assertion works in both execution modes.
    const bytes = new Uint8Array(
      new Uint8Array(wine.memory.buffer, offset, Math.max(0, length)));
    const text = new TextDecoder('windows-1252').decode(bytes);
    await call('guest_free', buffer);
    return text;
  }, { id: appId, controlId, getter });
}

async function clickControl(page, appId, controlId) {
  const control = await controlState(page, appId, controlId);
  assert(control && !control.missing, `${appId} control ${controlId} is absent`);
  assert(control.style & WS_VISIBLE, `${appId} control ${controlId} is hidden`);
  assert(!(control.style & WS_DISABLED), `${appId} control ${controlId} is disabled`);
  const point = {
    x: control.x + Math.max(1, control.width >> 1),
    y: control.y + Math.max(1, control.height >> 1),
  };
  await page.evaluate(({ x, y }) => {
    sharedRenderer.handleMouseMove(x, y);
    sharedRenderer.handleMouseDown(x, y, 0);
    sharedRenderer.handleMouseUp(x, y, 0);
  }, point);
}

async function waitForControl(page, appId, controlId, predicate, label) {
  return waitFor(`${appId} ${label}`, async () => {
    const value = await controlState(page, appId, controlId);
    return { pass: !!(value && !value.missing && predicate(value)), value };
  });
}

async function waitForTitle(page, appId, title) {
  return waitFor(`${appId} title ${title}`, async () => {
    const value = await runtimeState(page, appId);
    return { pass: value.running && value.titles.includes(title), value };
  });
}

async function visualState(page, appId) {
  return page.evaluate(async id => {
    const app = runningApps.find(item => item && item.name === id);
    if (!app || !app.wine || !app.wine.running) return null;
    const wine = app.wine;
    let dialog = null;
    for (const win of Object.values(sharedRenderer.windows || {})) {
      if (!win || !win.visible || !win._backCanvas) continue;
      try {
        if ((await Promise.resolve(wine.callGuest('dlg_get_ctrl_count', win.hwnd))) > 0) {
          dialog = win;
          break;
        }
      } catch (_) {}
    }
    if (!dialog) return null;
    const canvas = dialog._backCanvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0, ink = 0, white = 0, face = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) opaque++;
      if (pixels[i] < 96 && pixels[i + 1] < 96 && pixels[i + 2] < 96 && pixels[i + 3]) ink++;
      if (pixels[i] > 238 && pixels[i + 1] > 238 && pixels[i + 2] > 238 && pixels[i + 3]) white++;
      if (pixels[i] >= 180 && pixels[i] <= 205 && pixels[i + 1] >= 180 &&
          pixels[i + 1] <= 205 && pixels[i + 2] >= 180 && pixels[i + 2] <= 205 && pixels[i + 3]) face++;
    }
    return { width: canvas.width, height: canvas.height, area: canvas.width * canvas.height,
      opaque, ink, white, face, title: dialog.title || '' };
  }, appId);
}

async function assertVisual(page, spec, mode, stage) {
  const visual = await waitFor(`${spec.id} ${stage} visual`, async () => {
    const value = await visualState(page, spec.id);
    const pass = !!(value && value.width >= 300 && value.height >= 250 &&
      value.opaque > value.area * 0.45 && value.ink > 180 &&
      value.face + value.white > value.area * 0.2);
    return { pass, value };
  });
  const png = path.join(OUT, `${spec.id}-${mode}-${stage}.png`);
  await page.screenshot({ path: png, captureBeyondViewport: false });
  assert(fs.statSync(png).size > 10000, `${spec.id} ${stage} screenshot is incomplete`);
  return { visual, png };
}

async function runWinamp(page, spec, mode) {
  await waitForTitle(page, spec.id, 'Winamp Setup: License Agreement');
  await assertVisual(page, spec, mode, 'license');
  await clickControl(page, spec.id, 1);
  await waitForTitle(page, spec.id, 'Winamp Setup: Installation Options');
  await clickControl(page, spec.id, 1);
  await waitForTitle(page, spec.id, 'Winamp Setup: Installation Folder');
  await clickControl(page, spec.id, 1);
  await waitForTitle(page, spec.id, 'Winamp Setup: Installing Files');
  await assertVisual(page, spec, mode, 'installing');

  // Winamp normally destroys the wizard as soon as extraction finishes. Some
  // NSIS builds briefly expose enabled Close first, so support that authentic
  // terminal variant too instead of racing it.
  const terminal = await waitFor(`${spec.id} completion`, async () => {
    const state = await runtimeState(page, spec.id);
    if (!state.present || !state.running) return { pass: true, value: { stopped: true } };
    const close = await controlState(page, spec.id, 1);
    return {
      pass: !!(close && !close.missing && (close.style & WS_VISIBLE) && !(close.style & WS_DISABLED)),
      value: { stopped: false, close },
    };
  });
  if (!terminal.stopped) {
    await clickControl(page, spec.id, 1);
    await waitFor(`${spec.id} exit after Close`, async () => {
      const state = await runtimeState(page, spec.id);
      return { pass: !state.present || !state.running, value: state };
    });
  }
}

async function runMirc(page, spec, mode) {
  await waitForControl(page, spec.id, 133, c => !!(c.style & WS_VISIBLE), 'welcome page');
  await assertVisual(page, spec, mode, 'welcome');
  await clickControl(page, spec.id, 1);
  await waitForControl(page, spec.id, 140, c => !!(c.style & WS_VISIBLE), 'license page');
  await clickControl(page, spec.id, 1);
  await waitForControl(page, spec.id, 150, c => !!(c.style & WS_VISIBLE), 'destination page');

  // The reported failure was exactly here: scanning completed internally but
  // the modal pump never dispatched the 25ms timer that enables Install.
  await waitForControl(page, spec.id, 1,
    c => !!(c.style & WS_VISIBLE) && !(c.style & WS_DISABLED), 'scan completion');
  await clickControl(page, spec.id, 1);
  await waitForControl(page, spec.id, 180, c => !!(c.style & WS_VISIBLE), 'success page');
  const success = await controlText(page, spec.id, 180, 'static_get_text');
  assert(/Installation of mIRC was successful/i.test(success),
    `mIRC terminal success text is wrong: ${JSON.stringify(success)}`);
  await assertVisual(page, spec, mode, 'success');
}

async function runCase(browser, baseUrl, spec, threaded) {
  const page = await browser.newPage();
  const mode = threaded ? 'worker' : 'cooperative';
  const problems = [];
  const diagnostics = [];
  page.on('pageerror', error => problems.push((error && error.stack) || String(error)));
  page.on('console', message => {
    const text = message.text();
    diagnostics.push(text);
    if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:|guest trapped/i.test(text)) {
      problems.push(text);
    }
  });
  await page.setViewport({ width: 1100, height: 820, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.removeItem('wine-assembly.threads'));
  await page.goto(`${baseUrl}/index.html?debug&no-log&installer-matrix=${Date.now()}`,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(id => typeof launchApp === 'function' &&
    document.querySelector(`#app-select option[value="${id}"]`),
  { timeout: 30000 }, spec.id);
  assert(await page.evaluate(() => crossOriginIsolated),
    'installer matrix server must enable cross-origin isolation');

  await page.evaluate(async ({ id, threaded }) => {
    const box = document.getElementById('threads-toggle');
    box.checked = threaded;
    await setThreads(threaded);
    document.getElementById('app-select').value = id;
    launchApp();
  }, { id: spec.id, threaded });
  const launched = await waitFor(`${spec.id} ${mode} launch`, async () => {
    const value = await runtimeState(page, spec.id);
    return { pass: value.running && value.worker === threaded, value };
  });
  assert.strictEqual(launched.worker, threaded,
    `${spec.id} used the wrong execution backend in ${mode} mode`);
  await page.evaluate(id => {
    const app = runningApps.find(item => item && item.name === id);
    // Larger than the interactive default, still bounded enough to keep the
    // cooperative page responsive while an installer expands many small files.
    app.wine.stepsPerSlice = 250000;
  }, spec.id);

  try {
    if (spec.kind === 'winamp') await runWinamp(page, spec, mode);
    else await runMirc(page, spec, mode);
    assert.strictEqual(problems.length, 0,
      `${spec.id} ${mode} browser failures:\n${problems.join('\n')}`);
    console.log(`PASS ${spec.label} installer UI + completion (${mode})`);
  } catch (error) {
    const state = await runtimeState(page, spec.id).catch(() => null);
    const threads = await page.evaluate(async () =>
      debugThreadState.collectSnapshotAsync(runningApps)).catch(() => null);
    throw new Error(`${error.message}\nstate=${JSON.stringify(state)}\n` +
      `threads=${JSON.stringify(threads)}\nconsole=${diagnostics.slice(-40).join('\n')}`);
  } finally {
    await page.close();
  }
}

(async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    for (const threaded of [false, true]) {
      for (const spec of CASES) await runCase(browser, baseUrl, spec, threaded);
    }
    console.log(`PASS core installer corpus in cooperative + guest-Worker modes (${OUT})`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
