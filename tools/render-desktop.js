#!/usr/bin/env node
// Render multiple EXEs into a single desktop screenshot
// Each app runs in its own WASM instance but shares one renderer/canvas

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { Win98Renderer } = require('../lib/renderer');
const { parseResources } = require('../lib/resources');
const { createHostImports } = require('../lib/host-imports');

const ROOT = path.join(__dirname, '..');
const WASM_PATH = path.join(ROOT, 'build', 'wine-assembly.wasm');

const WIDTH = 1024;
const HEIGHT = 768;
const MAX_BATCHES = 150;
const BATCH_SIZE = 1000;
const OUT = process.argv[2] || 'desktop.png';

const APPS = [
  { exe: 'test/binaries/entertainment-pack/ski32.exe', name: 'SkiFree' },
  { exe: 'test/binaries/notepad.exe', name: 'Notepad' },
  { exe: 'test/binaries/entertainment-pack/reversi.exe', name: 'Reversi' },
  { exe: 'test/binaries/entertainment-pack/winmine.exe', name: 'Minesweeper',
    click: { batch: 80, x: 80, y: 80 } },
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

  console.log(`  ${app.name}: done (hwnd 0x${hwndBase.toString(16)})`);
}

async function main() {
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const renderer = new Win98Renderer(canvas);

  console.log(`Rendering desktop ${WIDTH}x${HEIGHT} with ${APPS.length} apps...`);

  for (let i = 0; i < APPS.length; i++) {
    await runApp(wasmModule, APPS[i], renderer, i);
  }

  renderer.repaint();

  const pngBuf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUT, pngBuf);
  console.log(`Wrote ${OUT} (${WIDTH}x${HEIGHT}, ${pngBuf.length} bytes)`);
}

main().catch(e => console.error(e));
