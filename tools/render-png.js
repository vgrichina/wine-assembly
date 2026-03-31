#!/usr/bin/env node
// Render a PE exe through wine-assembly using the shared Win98Renderer + node-canvas → PNG

const fs = require('fs');
const { createCanvas } = require('canvas');
const { Win98Renderer } = require('../lib/renderer');
const { parseResources } = require('../lib/resources');
const { createHostImports } = require('../lib/host-imports');

const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };

const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');
const OUT_PATH = getArg('out', 'notepad.png');
const WIDTH = parseInt(getArg('width', '640'));
const HEIGHT = parseInt(getArg('height', '480'));
const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
const BATCH_SIZE = parseInt(getArg('batch-size', '1000'));

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync(EXE_PATH);

  // Create node-canvas and renderer
  const canvas = createCanvas(WIDTH, HEIGHT);
  const renderer = new Win98Renderer(canvas);

  // Parse resources directly from EXE
  const resourceJson = parseResources(exeBytes);
  renderer.loadResources(resourceJson);
  console.log('Resources:', Object.keys(resourceJson.menus).length, 'menus,',
    Object.keys(resourceJson.dialogs).length, 'dialogs,',
    Object.keys(resourceJson.strings).length, 'strings');

  let stopped = false;

  const base = createHostImports({
    getMemory: () => instance.exports.memory.buffer,
    renderer,
    resourceJson,
    onExit: (code) => { stopped = true; },
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: base.host });
  const mem = new Uint8Array(instance.exports.memory.buffer);
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
