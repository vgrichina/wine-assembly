#!/usr/bin/env node
// Render multiple EXEs into a single desktop screenshot
// Each app runs in its own WASM instance but shares one renderer/canvas

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { Win98Renderer } = require('../lib/renderer');
const { parseResources } = require('../lib/resources');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const WIDTH = 1024;
const HEIGHT = 768;
const MAX_BATCHES = 150;
const BATCH_SIZE = 1000;
const OUT = process.argv[2] || 'desktop.png';

const APPS = [
  { exe: 'test/binaries/entertainment-pack/reversi.exe', name: 'Reversi',
    pos: { x: 10, y: 10 } },
  { exe: 'test/binaries/entertainment-pack/winmine.exe', name: 'Minesweeper',
    pos: { x: 360, y: 10 },
    click: { batch: 80, x: 80, y: 80 } },
  { exe: 'test/binaries/entertainment-pack/ski32.exe', name: 'SkiFree',
    pos: { x: 10, y: 420 } },
  { exe: 'test/binaries/entertainment-pack/freecell.exe', name: 'FreeCell',
    pos: { x: 550, y: 10 } },
];

async function runApp(wasmModule, app, renderer, appIndex) {
  const exePath = path.join(ROOT, app.exe);
  if (!fs.existsSync(exePath)) {
    console.log(`  SKIP ${app.name} — not found`);
    return;
  }
  const exeBytes = fs.readFileSync(exePath);
  const resourceJson = parseResources(exeBytes);
  renderer.loadResources(resourceJson);

  let stopped = false;
  const memory = new WebAssembly.Memory({ initial: 1024 });
  const hwndBase = 0x10001 + appIndex * 0x10000;

  const ctx = {
    getMemory: () => memory.buffer,
    renderer,
    resourceJson,
    onExit: () => { stopped = true; },
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;

  // Override show_window to log but not inject WM_CLOSE
  base.host.show_window = (hwnd, cmd) => {
    console.log(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
    if (renderer) renderer.showWindow(hwnd, cmd);
  };

  // Override create_window and move_window to apply position offset for tiling
  const posOff = app.pos || { x: 0, y: 0 };
  const origCreateWindow = base.host.create_window;
  base.host.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
    if (hwnd === hwndBase) { x = posOff.x; y = posOff.y; }
    return origCreateWindow(hwnd, style, x, y, cx, cy, titlePtr, menuId);
  };
  const origMoveWindow = base.host.move_window;
  base.host.move_window = (hwnd, x, y, w, h) => {
    if (hwnd === hwndBase) {
      x = posOff.x; y = posOff.y;
      if (app.size) { w = app.size.w; h = app.size.h; }
    }
    origMoveWindow(hwnd, x, y, w, h);
  };

  const instance = await WebAssembly.instantiate(wasmModule, { host: base.host });
  ctx.exports = instance.exports;
  instance.exports.set_hwnd_base(hwndBase);

  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  instance.exports.load_pe(exeBytes.length);

  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    // Inject click if configured
    if (app.click && batch === app.click.batch) {
      const lParam = (app.click.y << 16) | app.click.x;
      renderer.inputQueue.push(
        { type: 'click', hwnd: hwndBase, msg: 0x0201, wParam: 1, lParam },
        { type: 'click', hwnd: hwndBase, msg: 0x0202, wParam: 0, lParam },
        { type: 'paint', hwnd: hwndBase, msg: 0x000F, wParam: 0, lParam: 0 },
      );
    }
    try {
      instance.exports.run(BATCH_SIZE);
      if (instance.exports.get_eip() === 0) break;
      const yr = instance.exports.get_yield_reason();
      if (yr === 2) break;
      if (yr) instance.exports.clear_yield();
    } catch (e) {
      break;
    }
  }

  // Save client area content to restore after other apps paint
  // Also save menu reference since loadResources will overwrite shared resources
  for (const w of Object.values(renderer.windows)) {
    if (w.menu) w._savedMenu = w.menu;
  }
  const win = renderer.windows[hwndBase];
  if (win) {
    renderer._computeClientRect(win);
    const cr = win.clientRect;
    if (cr && cr.w > 0 && cr.h > 0) {
      win._savedClient = renderer.ctx.getImageData(cr.x, cr.y, cr.w, cr.h);
      win._savedCR = { x: cr.x, y: cr.y, w: cr.w, h: cr.h };
    }
  }

  console.log(`  ${app.name}: done (hwnd 0x${hwndBase.toString(16)})`);
}

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const renderer = new Win98Renderer(canvas);

  console.log(`Rendering desktop ${WIDTH}x${HEIGHT} with ${APPS.length} apps...`);

  for (let i = 0; i < APPS.length; i++) {
    await runApp(wasmModule, APPS[i], renderer, i);
  }

  renderer.repaint();

  // Restore saved client area content (order matters: lower z-order first)
  const sorted = Object.values(renderer.windows)
    .filter(w => w._savedClient && w._savedCR)
    .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
  for (const win of sorted) {
    const cr = win._savedCR;
    renderer.ctx.putImageData(win._savedClient, cr.x, cr.y);
  }

  const pngBuf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUT, pngBuf);
  console.log(`Wrote ${OUT} (${WIDTH}x${HEIGHT}, ${pngBuf.length} bytes)`);
}

main().catch(e => console.error(e));
