#!/usr/bin/env node
// Render a PE exe through wine-assembly using the shared Win98Renderer + node-canvas → PNG

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('../test/compile-src.js');
const SRC_DIR = path.join(__dirname, '..', 'src');

const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };

const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');
const OUT_PATH = getArg('out', 'notepad.png');
const WIDTH = parseInt(getArg('width', '640'));
const HEIGHT = parseInt(getArg('height', '480'));
const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
const BATCH_SIZE = parseInt(getArg('batch-size', '1000'));

async function main() {
  const wasmBytes = compileSrcWasm();
  const exeBytes = fs.readFileSync(EXE_PATH);

  // Create node-canvas and renderer
  const canvas = createCanvas(WIDTH, HEIGHT);
  const renderer = new Win98Renderer(canvas);

  // Resource parsing lives in WAT.
  let stopped = false;

  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const base = createHostImports({
    getMemory: () => memory.buffer,
    renderer,
    onExit: (code) => { stopped = true; },
  });
  base.host.memory = memory;

  // No threads/COM in this renderer — same stub set as tools/headless-run.js.
  const threadStubs = {
    create_thread: () => 0, exit_thread: () => {}, create_event: () => 0,
    set_event: () => 0, reset_event: () => 0, wait_single: () => 0,
    wait_multiple: () => 0, com_create_instance: () => 0x80004002,
    has_dll_file: () => 0,
  };
  for (const [name, fn] of Object.entries(threadStubs)) {
    if (!base.host[name]) base.host[name] = fn;
  }

  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: base.host });
  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('PE loaded. Entry: 0x' + (entry >>> 0).toString(16).padStart(8, '0'));

  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    try {
      instance.exports.run(BATCH_SIZE);
    } catch (e) {
      console.log(`Crash at batch ${batch}: ${e.message}`);
      break;
    }
  }

  // Force final repaint
  renderer.repaint();

  // Write PNG
  const pngBuf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUT_PATH, pngBuf);
  console.log(`Wrote ${OUT_PATH} (${WIDTH}x${HEIGHT}, ${pngBuf.length} bytes)`);
}

main().catch(e => console.error(e));
