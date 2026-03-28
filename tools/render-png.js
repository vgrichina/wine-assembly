#!/usr/bin/env node
// Render a PE exe through wine-assembly using the shared Win98Renderer + node-canvas → PNG

const fs = require('fs');
const { createCanvas } = require('canvas');
const { Win98Renderer } = require('../lib/renderer');
const { parseResources } = require('../lib/resources');

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

  const readStr = (mem, ptr) => {
    let s = '';
    for (let i = ptr; i < ptr + 512; i++) { if (!mem[i]) break; s += String.fromCharCode(mem[i]); }
    return s;
  };

  const imports = { host: {
    log: () => {},
    log_i32: () => {},
    message_box: (h, t, c, u) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      console.log(`[MessageBox] "${readStr(mem, c)}": "${readStr(mem, t)}"`);
      return 1;
    },
    exit: code => { console.log('[Exit] code=' + code); stopped = true; },
    draw_rect: (x, y, w, h, color) => {
      const ctx = renderer.ctx;
      ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      ctx.fillRect(x, y, w, h);
    },
    read_file: () => 0,

    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      const title = readStr(mem, titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId}`);
      renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
      return hwnd;
    },
    show_window: (hwnd, cmd) => {
      renderer.showWindow(hwnd, cmd);
    },
    create_dialog: (hwnd, dlgId) => {
      console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlg=${dlgId}`);
      return renderer.createDialog(hwnd, dlgId);
    },
    load_string: (id, bufPtr, bufLen) => {
      if (!resourceJson || !resourceJson.strings) return 0;
      const str = resourceJson.strings[id];
      if (!str || bufLen <= 0) return 0;
      const bytes = new Uint8Array(instance.exports.memory.buffer);
      const maxLen = Math.min(str.length, bufLen - 1);
      for (let i = 0; i < maxLen; i++) bytes[bufPtr + i] = str.charCodeAt(i) & 0xFF;
      bytes[bufPtr + maxLen] = 0;
      return maxLen;
    },
    set_window_text: (hwnd, textPtr) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      renderer.setWindowText(hwnd, readStr(mem, textPtr));
    },
    invalidate: (hwnd) => { renderer.invalidate(hwnd); },
    set_menu: (hwnd, menuResId) => { renderer.setMenu(hwnd, menuResId); },
    draw_text: (x, y, textPtr, textLen, color) => {
      const bytes = new Uint8Array(instance.exports.memory.buffer, textPtr, textLen);
      const text = new TextDecoder().decode(bytes);
      const ctx = renderer.ctx;
      ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      ctx.font = renderer.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(text, x, y);
    },
    check_input: () => 0,
    check_input_lparam: () => 0, check_input_hwnd: () => 0,
    set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
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
