#!/usr/bin/env node
// Standalone SysTreeView32 scroll regression. Loads the WAT module without a
// guest EXE, creates a native TreeView, inserts rows, then verifies that wheel,
// scrollbar arrows/page/thumb, TVGN_FIRSTVISIBLE, hit-test, and selection all
// use the same first-visible row.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const TVM_INSERTITEMA = 0x1100;
const TVM_EXPAND = 0x1102;
const TVM_GETCOUNT = 0x1105;
const TVM_GETNEXTITEM = 0x110A;
const TVM_GETITEMA = 0x110C;
const TVM_HITTEST = 0x1111;
const TVGN_FIRSTVISIBLE = 5;
const TVGN_CARET = 9;
const TVE_COLLAPSE = 1;
const TVE_EXPAND = 2;
const TVN_ITEMEXPANDEDA = -406;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_MOUSEWHEEL = 0x020A;
const SB_THUMBTRACK = 5;

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
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
  ctx.exports = instance.exports;
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => g - e.get_image_base() + 0x12000;

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  }
  function writeStr(s) {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    return g;
  }
  function insertItem(text, parent = 0, state = null, childrenHint = 0) {
    const g = e.guest_alloc(56);
    const p = wa(g);
    u8.fill(0, p, p + 56);
    dv.setUint32(p + 0, parent, true);
    let mask = 0x0001; // TVIF_TEXT
    if (state !== null) mask |= 0x0008; // TVIF_STATE
    if (childrenHint) mask |= 0x0040; // TVIF_CHILDREN
    dv.setUint32(p + 8, mask, true);
    if (state !== null) {
      dv.setUint32(p + 16, state, true);
      dv.setUint32(p + 20, 0x20, true); // TVIS_EXPANDED
    }
    dv.setUint32(p + 24, writeStr(text), true);
    dv.setUint32(p + 40, childrenHint, true);
    return e.send_message(tv, TVM_INSERTITEMA, 0, g) >>> 0;
  }
  function makeLParam(x, y) {
    return (x & 0xFFFF) | ((y & 0xFFFF) << 16);
  }
  function firstVisibleHandle() {
    return e.send_message(tv, TVM_GETNEXTITEM, TVGN_FIRSTVISIBLE, 0) >>> 0;
  }

  const baselineSlots = e.wnd_count_used();
  const tv = e.test_create_treeview(0, 0, 160, 68, 0);
  check('treeview hwnd allocated', tv !== 0, 'hwnd=0x' + tv.toString(16));
  check('create added 2 slots (parent + treeview)', e.wnd_count_used() === baselineSlots + 2);

  const handles = [];
  for (let i = 0; i < 12; i++) handles.push(insertItem(`Node ${i}`));
  check('TVM_INSERTITEMA returned handles', handles.every(Boolean));
  check('TVM_GETCOUNT is 12', e.send_message(tv, TVM_GETCOUNT, 0, 0) === 12);
  check('visible count is 12', e.treeview_get_visible_count() === 12);
  check('max scroll is 8 for 4-row viewport', e.treeview_get_max_scroll(tv) === 8);
  check('initial first visible is first item', firstVisibleHandle() === handles[0]);

  e.send_message(tv, WM_MOUSEWHEEL, (-120 << 16), 0);
  check('mouse wheel scrolls down 3 rows', e.treeview_get_first_visible_row() === 3);
  check('TVGN_FIRSTVISIBLE follows wheel scroll', firstVisibleHandle() === handles[3]);

  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(152, 60));
  e.send_message(tv, WM_LBUTTONUP, 0, makeLParam(152, 60));
  check('scrollbar down arrow advances one row', e.treeview_get_first_visible_row() === 4);

  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(152, 22));
  e.send_message(tv, WM_LBUTTONUP, 0, makeLParam(152, 22));
  check('scrollbar page-up region moves up by viewport rows', e.treeview_get_first_visible_row() === 0);

  e.send_message(tv, WM_VSCROLL, (6 << 16) | SB_THUMBTRACK, 0);
  check('WM_VSCROLL thumb track sets first visible row', e.treeview_get_first_visible_row() === 6);

  const ht = e.guest_alloc(16);
  const htp = wa(ht);
  u8.fill(0, htp, htp + 16);
  dv.setInt32(htp + 0, 20, true);
  dv.setInt32(htp + 4, 4, true);
  check('TVM_HITTEST maps top row through scroll offset',
    (e.send_message(tv, TVM_HITTEST, 0, ht) >>> 0) === handles[6]);
  check('TVM_HITTEST writes scrolled hItem', dv.getUint32(htp + 12, true) === handles[6]);

  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(20, 20));
  check('click on visible row 1 selects underlying row 7',
    (e.send_message(tv, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0) === handles[7]);

  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(152, 43));
  e.send_message(tv, WM_MOUSEMOVE, 1, makeLParam(152, 61));
  e.send_message(tv, WM_LBUTTONUP, 0, makeLParam(152, 61));
  check('scrollbar thumb drag changes first visible row', e.treeview_get_first_visible_row() > 6);

  const parent = insertItem('Collapsed parent', 0, 0, 1);
  const parentItem = e.guest_alloc(40);
  const parentItemP = wa(parentItem);
  u8.fill(0, parentItemP, parentItemP + 40);
  dv.setUint32(parentItemP, 0x0040, true); // TVIF_CHILDREN
  dv.setUint32(parentItemP + 4, parent, true);
  const getParentItem = e.send_message(tv, TVM_GETITEMA, 0, parentItem);
  const parentChildren = dv.getUint32(parentItemP + 32, true);
  check('TVIF_CHILDREN hint is preserved before lazy children are inserted',
    getParentItem === 1 && parentChildren === 1,
    `ret=${getParentItem} cChildren=${parentChildren}`);
  const childA = insertItem('Child A', parent);
  const childB = insertItem('Child B', parent);
  check('collapsed parent hides both children', e.treeview_get_visible_count() === 13);
  check('TVGN_CHILD returns first hierarchical child',
    (e.send_message(tv, TVM_GETNEXTITEM, 4, parent) >>> 0) === childA);
  check('TVGN_PARENT returns hierarchical parent',
    (e.send_message(tv, TVM_GETNEXTITEM, 3, childB) >>> 0) === parent);
  const beforeExpandNotify = e.treeview_get_debug_expand_notify_count();
  check('TVM_EXPAND reveals both children',
    e.send_message(tv, TVM_EXPAND, TVE_EXPAND, parent) === 1 &&
      e.treeview_get_visible_count() === 15);
  check('TVM_EXPAND emits expanding/expanded notifications',
    e.treeview_get_debug_expand_notify_count() === beforeExpandNotify + 2 &&
      (e.treeview_get_debug_expand_notify_code() | 0) === TVN_ITEMEXPANDEDA &&
      e.treeview_get_debug_expand_notify_action() === TVE_EXPAND &&
      (e.treeview_get_debug_expand_notify_item() >>> 0) === parent &&
      e.treeview_get_debug_expand_notify_children() === 1);
  const beforeCollapseNotify = e.treeview_get_debug_expand_notify_count();
  check('TVM_EXPAND collapse hides both children again',
    e.send_message(tv, TVM_EXPAND, TVE_COLLAPSE, parent) === 1 &&
      e.treeview_get_visible_count() === 13);
  check('TVM_EXPAND collapse emits expanding/expanded notifications',
    e.treeview_get_debug_expand_notify_count() === beforeCollapseNotify + 2 &&
      (e.treeview_get_debug_expand_notify_code() | 0) === TVN_ITEMEXPANDEDA &&
      e.treeview_get_debug_expand_notify_action() === TVE_COLLAPSE &&
      (e.treeview_get_debug_expand_notify_item() >>> 0) === parent &&
      e.treeview_get_debug_expand_notify_children() === 1);

  if (e.wnd_destroy_tree) e.wnd_destroy_tree(tv - 1);
  check('slot count returns to baseline after destroy', e.wnd_count_used() === baselineSlots);

  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
