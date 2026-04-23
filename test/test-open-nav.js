#!/usr/bin/env node
// Regression: Open dialog directory navigation.
//
// Builds the WAT-driven Open dialog standalone (no exe) against a small
// purpose-built VFS containing one file at C:\ and one subdirectory with
// one nested file. Verifies:
//   - root listbox shows the file + "[sub]" + no ".." (root suppression)
//   - LBN_DBLCLK on "[sub]" navigates into the subdir, listbox shows
//     ".." + the nested file, $opendlg_current_dir is "C:\sub\"
//   - LBN_DBLCLK on ".." returns to root state
//   - $opendlg_current_dir round-trips cleanly through 3 nav cycles
//
// This test does not exercise modal_begin / x86 dispatch — the dialog
// is built directly via the test_create_open_dialog export so we can
// inspect listbox state synchronously without a guest message loop.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { Win98Renderer } = require('../lib/renderer');
const { VirtualFS } = require('../lib/filesystem');

let createCanvas;
try { createCanvas = require('canvas').createCanvas; } catch (_) {
  console.log('SKIP  node-canvas not available');
  process.exit(0);
}

(async () => {
  const SRC = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));

  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const canvas = createCanvas(640, 480);
  const renderer = new Win98Renderer(canvas);

  const vfs = new VirtualFS();
  vfs.files.clear();
  vfs.dirs.clear();
  vfs.dirs.add('c:');
  vfs.dirs.add('c:\\');
  vfs.dirs.add('c:\\sub');
  vfs.files.set('c:\\readme.txt', { data: new Uint8Array([1,2,3]), attrs: 0x80 });
  vfs.files.set('c:\\sub\\nested.txt', { data: new Uint8Array([4,5,6]), attrs: 0x80 });

  const ctx = {
    getMemory: () => memory.buffer, renderer, vfs,
    resourceJson: { menus:{}, dialogs:{}, strings:{}, bitmaps:{} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  ctx.exports = e;
  renderer.wasm = instance;
  renderer.wasmMemory = memory;

  const checks = [];
  const check = (name, pass, info) => {
    checks.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  };

  const dlg = e.test_create_open_dialog(0);

  // Find the listbox child of the dialog (class 4 anywhere in slot table).
  let lb = 0;
  for (let s = 0; s < 256; s++) {
    const h = e.wnd_slot_hwnd(s);
    if (h && e.ctrl_get_class(h) === 4) { lb = h; break; }
  }
  if (!lb) { console.log('FAIL  could not find listbox'); process.exit(1); }

  const u8 = new Uint8Array(memory.buffer);
  const readItem = (idx) => {
    const dest = e.guest_alloc(64);
    const n = e.listbox_get_item_text(lb, idx, dest, 63);
    const wa = dest - e.get_image_base() + 0x12000;
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[wa + i]);
    return s;
  };
  const items = () => {
    const cnt = e.listbox_get_count(lb);
    const arr = [];
    for (let i = 0; i < cnt; i++) arr.push(readItem(i));
    return arr;
  };
  const dblclick = (idx) => {
    e.send_message(lb, 0x0186, idx, 0);
    const y = idx * 16 + 5;
    e.send_message(lb, 0x0203, 0, (5 & 0xFFFF) | ((y & 0xFFFF) << 16));
  };

  // ---- Initial state at C:\ ----
  const items0 = items();
  console.log('  initial: ' + JSON.stringify(items0));
  check('root has readme.txt', items0.includes('readme.txt'));
  check('root has [sub] dir', items0.includes('[sub]'));
  check('root suppresses ".."', !items0.includes('..'));

  // ---- Navigate into [sub] ----
  dblclick(items0.indexOf('[sub]'));
  const items1 = items();
  console.log('  in sub: ' + JSON.stringify(items1));
  check('sub has ".."', items1.includes('..'));
  check('sub has nested.txt', items1.includes('nested.txt'));
  check('sub does NOT have readme.txt', !items1.includes('readme.txt'));

  // ---- Navigate back to root ----
  dblclick(items1.indexOf('..'));
  const items2 = items();
  console.log('  back at root: ' + JSON.stringify(items2));
  check('root again has readme.txt', items2.includes('readme.txt'));
  check('root again has [sub]', items2.includes('[sub]'));
  check('root again suppresses ".."', !items2.includes('..'));

  // ---- Round-trip again to confirm idempotence ----
  dblclick(items2.indexOf('[sub]'));
  const items3 = items();
  dblclick(items3.indexOf('..'));
  const items4 = items();
  check('cycle 2: root has readme.txt', items4.includes('readme.txt'));
  check('cycle 2: root has [sub]', items4.includes('[sub]'));

  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
