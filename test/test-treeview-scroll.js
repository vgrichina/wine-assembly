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
const TVM_SELECTITEM = 0x110B;
const TVM_GETITEMA = 0x110C;
const TVM_SETITEMA = 0x110D;
const TVM_HITTEST = 0x1111;
const TVGN_FIRSTVISIBLE = 5;
const TVGN_NEXTVISIBLE = 6;
const TVGN_CARET = 9;
const TVE_COLLAPSE = 1;
const TVE_EXPAND = 2;
const TVN_ITEMEXPANDEDA = -406;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
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
  function insertItem(text, parent = 0, state = null, childrenHint = 0, itemParam = 0,
    image = null, selectedImage = null) {
    const g = e.guest_alloc(56);
    const p = wa(g);
    u8.fill(0, p, p + 56);
    dv.setUint32(p + 0, parent, true);
    let mask = 0x0001; // TVIF_TEXT
    if (itemParam) mask |= 0x0004; // TVIF_PARAM
    if (state !== null) mask |= 0x0008; // TVIF_STATE
    if (image !== null) mask |= 0x0002; // TVIF_IMAGE
    if (selectedImage !== null) mask |= 0x0020; // TVIF_SELECTEDIMAGE
    if (childrenHint) mask |= 0x0040; // TVIF_CHILDREN
    dv.setUint32(p + 8, mask, true);
    if (state !== null) {
      dv.setUint32(p + 16, state, true);
      dv.setUint32(p + 20, 0x20, true); // TVIS_EXPANDED
    }
    dv.setUint32(p + 24, writeStr(text), true);
    if (image !== null) dv.setInt32(p + 32, image, true);
    if (selectedImage !== null) dv.setInt32(p + 36, selectedImage, true);
    dv.setUint32(p + 40, childrenHint, true);
    dv.setUint32(p + 44, itemParam, true);
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
  for (let i = 0; i < 12; i++) {
    handles.push(insertItem(`Node ${i}`, 0, null, 0, 0,
      i === 0 ? 2 : null, i === 0 ? 3 : null));
  }
  check('TVM_INSERTITEMA returned handles', handles.every(Boolean));
  check('first inserted item becomes the native default caret',
    (e.send_message(tv, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0) === handles[0]);
  const imageItem = e.guest_alloc(40);
  const imageItemP = wa(imageItem);
  u8.fill(0, imageItemP, imageItemP + 40);
  dv.setUint32(imageItemP, 0x0022, true); // TVIF_IMAGE | TVIF_SELECTEDIMAGE
  dv.setUint32(imageItemP + 4, handles[0], true);
  check('TVM_GETITEMA returns normal and selected image indexes',
    e.send_message(tv, TVM_GETITEMA, 0, imageItem) === 1 &&
      dv.getInt32(imageItemP + 24, true) === 2 &&
      dv.getInt32(imageItemP + 28, true) === 3);
  dv.setInt32(imageItemP + 24, 4, true);
  dv.setInt32(imageItemP + 28, 5, true);
  check('TVM_SETITEMA updates both image indexes',
    e.send_message(tv, TVM_SETITEMA, 0, imageItem) === 1);
  dv.setInt32(imageItemP + 24, -1, true);
  dv.setInt32(imageItemP + 28, -1, true);
  check('TreeView image indexes round-trip after TVM_SETITEMA',
    e.send_message(tv, TVM_GETITEMA, 0, imageItem) === 1 &&
      dv.getInt32(imageItemP + 24, true) === 4 &&
      dv.getInt32(imageItemP + 28, true) === 5);
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

  const parent = insertItem('Collapsed parent', 0, 0, 1, 0x12345678);
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
  const textBuffer = e.guest_alloc(64);
  const textItem = e.guest_alloc(40);
  const textItemP = wa(textItem);
  u8.fill(0, textItemP, textItemP + 40);
  dv.setUint32(textItemP, 0x0001, true); // TVIF_TEXT
  dv.setUint32(textItemP + 4, parent, true);
  dv.setUint32(textItemP + 16, textBuffer, true);
  dv.setUint32(textItemP + 20, 64, true);
  check('TVM_GETITEMA copies item text into the caller buffer',
    e.send_message(tv, TVM_GETITEMA, 0, textItem) === 1 &&
      Buffer.from(u8.subarray(wa(textBuffer), wa(textBuffer) + 16))
        .toString('latin1').split('\0')[0] === 'Collapsed parent');
  const laterRoot = insertItem('Later root');
  const childA = insertItem('Child A', parent);
  const childB = insertItem('Child B', parent);
  check('collapsed parent hides both children', e.treeview_get_visible_count() === 14);
  check('TVGN_CHILD returns first hierarchical child',
    (e.send_message(tv, TVM_GETNEXTITEM, 4, parent) >>> 0) === childA);
  check('TVGN_PARENT returns hierarchical parent',
    (e.send_message(tv, TVM_GETNEXTITEM, 3, childB) >>> 0) === parent);
  const beforeExpandNotify = e.treeview_get_debug_expand_notify_count();
  check('TVM_EXPAND reveals both children',
    e.send_message(tv, TVM_EXPAND, TVE_EXPAND, parent) === 1 &&
      e.treeview_get_visible_count() === 16);
  const selectedChild = [childA, childB].find(handle => (handle & 0x0002) === 0);
  check('test has a selected child whose handle does not share TVIS_SELECTED bit',
    !!selectedChild, `childA=0x${childA.toString(16)} childB=0x${childB.toString(16)}`);
  check('selected-descendant scan treats handle and state as booleans',
    !!selectedChild &&
      e.send_message(tv, TVM_SELECTITEM, TVGN_CARET, selectedChild) === 1 &&
      e.treeview_has_selected_descendant(parent) === 1);
  e.send_message(tv, TVM_SELECTITEM, TVGN_CARET, parent);
  check('TVGN_NEXTVISIBLE follows depth-first tree order, not allocation order',
    (e.send_message(tv, TVM_GETNEXTITEM, TVGN_NEXTVISIBLE, parent) >>> 0) === childA &&
      (e.send_message(tv, TVM_GETNEXTITEM, TVGN_NEXTVISIBLE, childB) >>> 0) === laterRoot);
  check('TVM_EXPAND emits expanding/expanded notifications',
    e.treeview_get_debug_expand_notify_count() === beforeExpandNotify + 2 &&
      (e.treeview_get_debug_expand_notify_code() | 0) === TVN_ITEMEXPANDEDA &&
      e.treeview_get_debug_expand_notify_action() === TVE_EXPAND &&
      (e.treeview_get_debug_expand_notify_item() >>> 0) === parent &&
      e.treeview_get_debug_expand_notify_children() === 1);
  const beforeCollapseNotify = e.treeview_get_debug_expand_notify_count();
  check('TVM_EXPAND collapse hides both children again',
    e.send_message(tv, TVM_EXPAND, TVE_COLLAPSE, parent) === 1 &&
      e.treeview_get_visible_count() === 14);
  check('TVM_EXPAND collapse emits expanding/expanded notifications',
    e.treeview_get_debug_expand_notify_count() === beforeCollapseNotify + 2 &&
      (e.treeview_get_debug_expand_notify_code() | 0) === TVN_ITEMEXPANDEDA &&
      e.treeview_get_debug_expand_notify_action() === TVE_COLLAPSE &&
      (e.treeview_get_debug_expand_notify_item() >>> 0) === parent &&
      e.treeview_get_debug_expand_notify_children() === 1);

  // RegEdit depends on standard TreeView mouse semantics: merely crossing a
  // plus box must not expand it or move the caret. Expansion belongs to an
  // explicit plus-box click or a row double-click.
  const hoverChild = insertItem('Hover child', handles[0]);
  e.send_message(tv, WM_VSCROLL, 6, 0); // SB_TOP: make Node 0 the top row
  e.send_message(tv, TVM_EXPAND, TVE_COLLAPSE, handles[0]);
  const hoverCollapsedCount = e.treeview_get_visible_count();
  const caretBeforeHover = e.send_message(tv, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0;
  e.send_message(tv, WM_MOUSEMOVE, 0, makeLParam(8, 4));
  check('plain hover over a plus box does not expand or select its item',
    e.treeview_get_visible_count() === hoverCollapsedCount &&
      (e.send_message(tv, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0) === caretBeforeHover);

  e.send_message(tv, TVM_EXPAND, TVE_COLLAPSE, handles[0]);
  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(32, 4));
  check('single click on row text selects without expanding',
    (e.send_message(tv, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0) === handles[0] &&
      e.treeview_get_visible_count() === hoverCollapsedCount);
  e.send_message(tv, WM_LBUTTONDOWN, 1, makeLParam(8, 4));
  check('single click on the plus box expands the item',
    e.treeview_get_visible_count() === hoverCollapsedCount + 1 && hoverChild !== 0);
  e.send_message(tv, TVM_EXPAND, TVE_COLLAPSE, handles[0]);
  e.send_message(tv, WM_LBUTTONDBLCLK, 1, makeLParam(32, 4));
  check('double-click on row text expands the item',
    e.treeview_get_visible_count() === hoverCollapsedCount + 1);

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
