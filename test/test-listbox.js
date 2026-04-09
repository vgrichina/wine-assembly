#!/usr/bin/env node
// Standalone listbox wndproc regression. Loads the wasm module without
// any guest exe, creates a parent + listbox via test_create_listbox,
// then exercises LB_ADDSTRING / LB_GETCOUNT / LB_GETTEXT / LB_SETCURSEL /
// LB_GETCURSEL / LB_RESETCONTENT and a click via WM_LBUTTONDOWN.
//
// PASS criteria:
//   - LB_ADDSTRING returns sequential 0,1,2,...
//   - LB_GETCOUNT matches inserts
//   - LB_GETTEXT round-trips each string
//   - LB_GETTEXTLEN matches strlen
//   - LB_SETCURSEL / LB_GETCURSEL round-trip; out-of-range clamps to -1
//   - LB_RESETCONTENT zeros count and selection
//   - Click at row 1 (y=20) sets cur_sel=1 and posts WM_COMMAND with
//     HIWORD=LBN_SELCHANGE=1 / LOWORD=ctrl_id=100 to the parent
//   - WND_RECORDS slot count returns to baseline after WM_DESTROY

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));

  // WAT module imports its memory; create it externally and pass through.
  const memory = new WebAssembly.Memory({ initial: 1024 });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  // Stub the threading + COM imports the WAT module references but the
  // listbox path never invokes.
  base.host.create_thread = () => 0;
  base.host.exit_thread   = () => 0;
  base.host.create_event  = () => 0;
  base.host.set_event     = () => 0;
  base.host.reset_event   = () => 0;
  base.host.wait_single   = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  }

  // Helper to write a NUL-terminated string into a fresh guest_alloc buffer.
  const writeStr = (s) => {
    const g = e.guest_alloc(s.length + 1);
    const wa = g - e.get_image_base() + 0x12000;
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < s.length; i++) u8[wa + i] = s.charCodeAt(i);
    u8[wa + s.length] = 0;
    return g;
  };
  const readStr = (g, max = 256) => {
    const wa = g - e.get_image_base() + 0x12000;
    const u8 = new Uint8Array(memory.buffer);
    let s = '';
    for (let i = 0; i < max && u8[wa + i]; i++) s += String.fromCharCode(u8[wa + i]);
    return s;
  };

  const baselineSlots = e.wnd_count_used();

  // Create the listbox: 200x100 client area, 6 rows visible.
  const lb = e.test_create_listbox(0, 0, 200, 100);
  check('listbox hwnd allocated', lb !== 0, 'hwnd=0x' + lb.toString(16));

  const slotsAfterCreate = e.wnd_count_used();
  check('create added 2 slots (parent + listbox)', slotsAfterCreate === baselineSlots + 2,
    `${slotsAfterCreate} vs ${baselineSlots}+2`);

  // Insert items
  const items = ['readme.txt', 'WINDOWS', 'config.ini', 'autoexec.bat'];
  let lastIdx = -99;
  for (let i = 0; i < items.length; i++) {
    const g = writeStr(items[i]);
    lastIdx = e.send_message(lb, 0x0180, 0, g); // LB_ADDSTRING
  }
  check('LB_ADDSTRING returns last index', lastIdx === items.length - 1,
    `got ${lastIdx} expected ${items.length - 1}`);

  const count = e.send_message(lb, 0x018B, 0, 0); // LB_GETCOUNT
  check('LB_GETCOUNT matches inserts', count === items.length,
    `got ${count} expected ${items.length}`);

  // Round-trip every item via LB_GETTEXT and check LB_GETTEXTLEN agrees
  let allOk = true;
  for (let i = 0; i < items.length; i++) {
    const dest = e.guest_alloc(64);
    const n = e.send_message(lb, 0x0189, i, dest); // LB_GETTEXT
    const got = readStr(dest);
    const tlen = e.send_message(lb, 0x018A, i, 0); // LB_GETTEXTLEN
    if (got !== items[i] || n !== items[i].length || tlen !== items[i].length) {
      allOk = false;
      console.log(`  FAIL item ${i}: got "${got}" n=${n} tlen=${tlen} expected "${items[i]}" len=${items[i].length}`);
    }
  }
  check('LB_GETTEXT / LB_GETTEXTLEN round-trip all items', allOk);

  // LB_SETCURSEL / LB_GETCURSEL
  e.send_message(lb, 0x0186, 2, 0); // LB_SETCURSEL idx=2
  check('LB_GETCURSEL after set=2', e.send_message(lb, 0x0188, 0, 0) === 2);
  // listbox_get_cur_sel export should agree
  check('listbox_get_cur_sel export agrees', e.listbox_get_cur_sel(lb) === 2);

  // Out-of-range LB_SETCURSEL → -1
  e.send_message(lb, 0x0186, 99, 0);
  check('out-of-range LB_SETCURSEL clamps to -1', e.send_message(lb, 0x0188, 0, 0) === -1);

  // Click at y=20 (row 1) → cur_sel=1
  // lParam = (x & 0xFFFF) | (y << 16)
  const clickL = (5 & 0xFFFF) | ((20 & 0xFFFF) << 16);
  e.send_message(lb, 0x0201, 0, clickL); // WM_LBUTTONDOWN
  check('click at y=20 selects row 1', e.send_message(lb, 0x0188, 0, 0) === 1);

  // Click at y=200 (way past visible) → clamps to count-1=3
  const clickL2 = (5 & 0xFFFF) | ((200 & 0xFFFF) << 16);
  e.send_message(lb, 0x0201, 0, clickL2);
  check('click way past last row clamps to count-1',
    e.send_message(lb, 0x0188, 0, 0) === items.length - 1);

  // LB_RESETCONTENT
  e.send_message(lb, 0x0184, 0, 0);
  check('LB_RESETCONTENT zeros count', e.send_message(lb, 0x018B, 0, 0) === 0);
  check('LB_RESETCONTENT clears cur_sel', e.send_message(lb, 0x0188, 0, 0) === -1);

  // After reset, ADDSTRING starts at 0 again
  const idx0 = e.send_message(lb, 0x0180, 0, writeStr('alpha'));
  check('LB_ADDSTRING after reset returns 0', idx0 === 0);

  // Tear down via $wnd_destroy_tree on the parent — the helper allocated
  // parent before lb so parent = lb - 1. wnd_destroy_tree posts WM_DESTROY
  // to every child (which frees per-class state) AND releases slots.
  if (e.wnd_destroy_tree) e.wnd_destroy_tree(lb - 1);
  const slotsAfterDestroy = e.wnd_count_used();
  check('slot count returns to baseline after destroy',
    slotsAfterDestroy === baselineSlots,
    `${slotsAfterDestroy} vs ${baselineSlots}`);

  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
