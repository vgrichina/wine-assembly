#!/usr/bin/env node
// Standalone combobox wndproc regression. Loads the wasm module without
// any guest exe, creates a parent + combobox via test_create_combobox,
// then exercises CB_* messages, dropdown open/close state machine,
// keyboard navigation (forwarded to inner listbox), and click-into-listbox
// from within the dropped state.
//
// Phase 1 model: inner listbox child does item storage. WM_LBUTTONDOWN on
// the field opens the dropdown (CBS_DROPDOWNLIST/DROPDOWN); a subsequent
// click into the dropped listbox area selects + (via LBN_DBLCLK) closes
// with accept. Single-click into the listbox fires LBN_SELCHANGE which
// the combobox relays as CBN_SELCHANGE without closing.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const VK_END = 0x23, VK_HOME = 0x24, VK_UP = 0x26, VK_DOWN = 0x28;
const VK_F4 = 0x73, VK_ESC = 0x1B, VK_RETURN = 0x0D;
const CB_ADDSTRING = 0x0143, CB_GETCOUNT = 0x0146, CB_GETCURSEL = 0x0147;
const CB_GETLBTEXT = 0x0148, CB_SETCURSEL = 0x014E, CB_RESETCONTENT = 0x014B;
const CB_GETDROPPEDSTATE = 0x0157, CB_SHOWDROPDOWN = 0x014F;
const WM_KEYDOWN = 0x0100, WM_LBUTTONDOWN = 0x0201, WM_COMMAND = 0x0111;
const FIELD_H = 21;
const CBS_DROPDOWNLIST = 3;

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });

  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread   = () => 0;
  base.host.create_event  = () => 0;
  base.host.set_event     = () => 0;
  base.host.reset_event   = () => 0;
  base.host.wait_single   = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  }

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
  const getText = () => {
    const dest = e.guest_alloc(64);
    e.combobox_get_text(cb, dest, 64);
    return readStr(dest);
  };

  const baselineSlots = e.wnd_count_used();

  // 200x100 combobox, CBS_DROPDOWNLIST. cy budgets the dropped area;
  // closed face is FIELD_H = 21 px.
  const cb = e.test_create_combobox(0, 0, 200, 100, CBS_DROPDOWNLIST);
  check('combobox hwnd allocated', cb !== 0, 'hwnd=0x' + cb.toString(16));

  // create allocates: parent + combobox + inner listbox (ctrl_create_child)
  const slotsAfterCreate = e.wnd_count_used();
  check('create added 3 slots (parent + combobox + inner listbox)',
    slotsAfterCreate === baselineSlots + 3,
    `${slotsAfterCreate} vs ${baselineSlots}+3`);

  const lb = e.combobox_get_lb_hwnd(cb);
  check('inner listbox hwnd exposed', lb !== 0, 'lb=0x' + lb.toString(16));

  // ---------------- Item storage (forwarded to listbox) ----------------
  const items = ['Up', 'Down', 'Left', 'Right', 'Fire'];
  const indices = items.map((s) => e.send_message(cb, CB_ADDSTRING, 0, writeStr(s)));
  check('CB_ADDSTRING returns sequential indices',
    indices.every((v, i) => v === i),
    'got ' + JSON.stringify(indices));

  check('CB_GETCOUNT matches inserts',
    e.send_message(cb, CB_GETCOUNT, 0, 0) === items.length);

  check('initial CB_GETCURSEL = -1',
    e.send_message(cb, CB_GETCURSEL, 0, 0) === -1);

  let textOk = true;
  for (let i = 0; i < items.length; i++) {
    const dest = e.guest_alloc(64);
    const n = e.send_message(cb, CB_GETLBTEXT, i, dest);
    const got = readStr(dest);
    if (got !== items[i] || n !== items[i].length) {
      textOk = false;
      console.log(`  FAIL item ${i}: got "${got}" n=${n}`);
    }
  }
  check('CB_GETLBTEXT round-trips all items', textOk);

  // CB_SETCURSEL → cur_sel mirrored, text propagated
  e.send_message(cb, CB_SETCURSEL, 2, 0);
  check('CB_SETCURSEL(2) → CB_GETCURSEL=2',
    e.send_message(cb, CB_GETCURSEL, 0, 0) === 2);
  check('combobox_get_cur_sel agrees',
    e.combobox_get_cur_sel(cb) === 2);
  check('combobox_get_text reflects selection',
    getText() === items[2], `got "${getText()}"`);

  // ---------------- Dropdown state machine ----------------
  check('initial is_dropped = 0', e.combobox_is_dropped(cb) === 0);
  check('initial CB_GETDROPPEDSTATE = 0',
    e.send_message(cb, CB_GETDROPPEDSTATE, 0, 0) === 0);

  // Click on field area (py < FIELD_H) → opens dropdown.
  e.send_message(cb, WM_LBUTTONDOWN, 0, (5 & 0xFFFF) | ((10 & 0xFFFF) << 16));
  check('field click opens dropdown', e.combobox_is_dropped(cb) === 1);
  check('CB_GETDROPPEDSTATE=1 after open',
    e.send_message(cb, CB_GETDROPPEDSTATE, 0, 0) === 1);

  // Click on listbox area (py >= FIELD_H) → forwarded to listbox.
  // Row 0 starts at lb-local y=0 (px=5, py=FIELD_H+5 → lb (5,5) → row 0).
  // listbox WM_LBUTTONDOWN sets cur_sel and fires LBN_SELCHANGE; combobox
  // syncs text + relays CBN_SELCHANGE but does NOT close (only LBN_DBLCLK closes).
  e.send_message(cb, CB_SETCURSEL, 2, 0);  // baseline
  e.send_message(cb, WM_LBUTTONDOWN, 0, (5 & 0xFFFF) | ((FIELD_H + 5) & 0xFFFF) << 16);
  check('listbox click selected row 0',
    e.combobox_get_cur_sel(cb) === 0 && getText() === items[0],
    `sel=${e.combobox_get_cur_sel(cb)} text="${getText()}"`);
  check('listbox single-click keeps dropdown open',
    e.combobox_is_dropped(cb) === 1);

  // Click outside listbox (px >= w) when dropped → cancel-close.
  e.send_message(cb, WM_LBUTTONDOWN, 0, (250 & 0xFFFF) | ((FIELD_H + 5) & 0xFFFF) << 16);
  check('out-of-bounds click closes dropdown',
    e.combobox_is_dropped(cb) === 0);

  // CB_SHOWDROPDOWN(1) opens, CB_SHOWDROPDOWN(0) closes.
  e.send_message(cb, CB_SHOWDROPDOWN, 1, 0);
  check('CB_SHOWDROPDOWN(1) opens', e.combobox_is_dropped(cb) === 1);
  e.send_message(cb, CB_SHOWDROPDOWN, 0, 0);
  check('CB_SHOWDROPDOWN(0) closes', e.combobox_is_dropped(cb) === 0);

  // F4 toggles.
  e.send_message(cb, WM_KEYDOWN, VK_F4, 0);
  check('F4 opens dropdown', e.combobox_is_dropped(cb) === 1);
  e.send_message(cb, WM_KEYDOWN, VK_F4, 0);
  check('F4 again closes (accept)', e.combobox_is_dropped(cb) === 0);

  // Esc while dropped → cancel-close. Enter while dropped → accept-close.
  e.send_message(cb, CB_SHOWDROPDOWN, 1, 0);
  e.send_message(cb, WM_KEYDOWN, VK_ESC, 0);
  check('VK_ESC closes', e.combobox_is_dropped(cb) === 0);
  e.send_message(cb, CB_SHOWDROPDOWN, 1, 0);
  e.send_message(cb, WM_KEYDOWN, VK_RETURN, 0);
  check('VK_RETURN closes', e.combobox_is_dropped(cb) === 0);

  // ---------------- Keyboard nav forwarded to listbox ----------------
  // Listbox clamps; it does NOT wrap. Verify VK_DOWN/UP/HOME/END.
  e.send_message(cb, CB_SETCURSEL, 0, 0);
  e.send_message(cb, WM_KEYDOWN, VK_DOWN, 0);
  check('VK_DOWN advances 0 → 1',
    e.combobox_get_cur_sel(cb) === 1 && getText() === items[1]);

  e.send_message(cb, WM_KEYDOWN, VK_DOWN, 0);
  e.send_message(cb, WM_KEYDOWN, VK_DOWN, 0);
  check('VK_DOWN twice more → 3',
    e.combobox_get_cur_sel(cb) === 3 && getText() === items[3]);

  // Listbox clamps at last (no wrap).
  e.send_message(cb, CB_SETCURSEL, items.length - 1, 0);
  e.send_message(cb, WM_KEYDOWN, VK_DOWN, 0);
  check('VK_DOWN at last clamps (no wrap)',
    e.combobox_get_cur_sel(cb) === items.length - 1
      && getText() === items[items.length - 1]);

  e.send_message(cb, CB_SETCURSEL, 3, 0);
  e.send_message(cb, WM_KEYDOWN, VK_UP, 0);
  check('VK_UP retreats 3 → 2',
    e.combobox_get_cur_sel(cb) === 2 && getText() === items[2]);

  e.send_message(cb, CB_SETCURSEL, 0, 0);
  e.send_message(cb, WM_KEYDOWN, VK_UP, 0);
  check('VK_UP at 0 clamps (no wrap)',
    e.combobox_get_cur_sel(cb) === 0 && getText() === items[0]);

  e.send_message(cb, CB_SETCURSEL, 2, 0);
  e.send_message(cb, WM_KEYDOWN, VK_HOME, 0);
  check('VK_HOME → 0',
    e.combobox_get_cur_sel(cb) === 0 && getText() === items[0]);

  e.send_message(cb, WM_KEYDOWN, VK_END, 0);
  check('VK_END → count-1',
    e.combobox_get_cur_sel(cb) === items.length - 1
      && getText() === items[items.length - 1]);

  // Unknown key (e.g. VK_SPACE 0x20) is a no-op for selection.
  e.send_message(cb, CB_SETCURSEL, 1, 0);
  e.send_message(cb, WM_KEYDOWN, 0x20, 0);
  check('unrelated key is a no-op', e.combobox_get_cur_sel(cb) === 1);

  // ---------------- Empty combobox: no crash on nav ----------------
  e.send_message(cb, CB_RESETCONTENT, 0, 0);
  check('CB_RESETCONTENT clears count',
    e.send_message(cb, CB_GETCOUNT, 0, 0) === 0);
  check('CB_RESETCONTENT clears cur_sel',
    e.send_message(cb, CB_GETCURSEL, 0, 0) === -1);
  e.send_message(cb, WM_KEYDOWN, VK_DOWN, 0);
  e.send_message(cb, WM_KEYDOWN, VK_UP, 0);
  // Click into listbox area (where there's no item) should not crash.
  e.send_message(cb, CB_SHOWDROPDOWN, 1, 0);
  e.send_message(cb, WM_LBUTTONDOWN, 0, (5 & 0xFFFF) | ((FIELD_H + 5) & 0xFFFF) << 16);
  check('empty combobox: nav leaves cur_sel = -1',
    e.combobox_get_cur_sel(cb) === -1);

  // ---------------- Tear down ----------------
  if (e.wnd_destroy_tree) e.wnd_destroy_tree(cb - 1);
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
