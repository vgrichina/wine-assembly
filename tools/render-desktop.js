#!/usr/bin/env node
// Render multiple EXEs into a single desktop screenshot
// Each app runs in its own WASM instance but shares one renderer/canvas
// Uses set_hwnd_base() to give each app a unique hwnd range

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
const MAX_BATCHES = 80;
const BATCH_SIZE = 1000;
const OUT = process.argv[2] || 'desktop.png';

const APPS = [
  { exe: 'test/binaries/notepad.exe', name: 'Notepad' },
  { exe: 'test/binaries/entertainment-pack/freecell.exe', name: 'FreeCell' },
  { exe: 'test/binaries/entertainment-pack/sol.exe', name: 'Solitaire' },
  { exe: 'test/binaries/entertainment-pack/ski32.exe', name: 'SkiFree' },
  { exe: 'test/binaries/xp/winmine.exe', name: 'Minesweeper' },
  { exe: 'test/binaries/entertainment-pack/reversi.exe', name: 'Reversi' },
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

  const ctx = {
    getMemory: () => memory.buffer,
    renderer,
    resourceJson,
    onExit: () => { stopped = true; },
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;

  const instance = await WebAssembly.instantiate(wasmModule, { host: base.host });
  ctx.exports = instance.exports;

  // Set unique hwnd range for this app: 0x10001, 0x20001, 0x30001, ...
  instance.exports.set_hwnd_base(0x10001 + appIndex * 0x10000);

  // Load EXE
  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  instance.exports.load_pe(exeBytes.length);

  // Run
  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
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

  console.log(`  ${app.name}: done (hwnds 0x${(0x10001 + appIndex * 0x10000).toString(16)}+)`);
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
