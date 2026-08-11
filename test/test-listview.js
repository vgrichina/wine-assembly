#!/usr/bin/env node
// Standalone SysListView32 regression. Loads the WAT module without a guest
// EXE, creates a native ListView, inserts report columns/items, then verifies
// item text, selection, hit-test, and shared vertical scrollbar behavior.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const LVM_GETITEMCOUNT = 0x1004;
const LVM_INSERTITEMA = 0x1007;
const LVM_DELETEALLITEMS = 0x1009;
const LVM_GETNEXTITEM = 0x100C;
const LVM_GETITEMRECT = 0x100E;
const LVM_HITTEST = 0x1012;
const LVM_ENSUREVISIBLE = 0x1013;
const LVM_SCROLL = 0x1014;
const LVM_GETCOLUMNA = 0x1019;
const LVM_SETCOLUMNA = 0x101A;
const LVM_INSERTCOLUMNA = 0x101B;
const LVM_GETCOLUMNWIDTH = 0x101D;
const LVM_GETTOPINDEX = 0x1027;
const LVM_GETCOUNTPERPAGE = 0x1028;
const LVM_SETITEMSTATE = 0x102B;
const LVM_GETITEMSTATE = 0x102C;
const LVM_GETITEMTEXTA = 0x102D;
const LVM_SETITEMTEXTA = 0x102E;
const LVM_GETSELECTEDCOUNT = 0x1032;
const LVM_GETSUBITEMRECT = 0x1038;
const WM_PAINT = 0x000F;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_MOUSEWHEEL = 0x020A;
const LVIF_TEXT = 0x0001;
const LVIF_STATE = 0x0008;
const LVIS_SELECTED = 0x0002;
const LVNI_SELECTED = 0x0002;
const LVIR_BOUNDS = 0x0000;
const LVIR_LABEL = 0x0002;
const LVCF_WIDTH = 0x0002;
const LVCF_TEXT = 0x0004;
const LVCF_SUBITEM = 0x0008;
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
  function readStr(g, max = 128) {
    const p = wa(g);
    let s = '';
    for (let i = 0; i < max && u8[p + i]; i++) s += String.fromCharCode(u8[p + i]);
    return s;
  }
  function makeLParam(x, y) {
    return (x & 0xFFFF) | ((y & 0xFFFF) << 16);
  }
  function insertColumn(idx, text, width) {
    const g = e.guest_alloc(32);
    const p = wa(g);
    u8.fill(0, p, p + 32);
    dv.setUint32(p + 0, LVCF_TEXT | LVCF_WIDTH, true);
    dv.setInt32(p + 8, width, true);
    dv.setUint32(p + 12, writeStr(text), true);
    return e.send_message(lv, LVM_INSERTCOLUMNA, idx, g);
  }
  function getColumn(idx) {
    const g = e.guest_alloc(32);
    const textG = e.guest_alloc(64);
    const p = wa(g);
    u8.fill(0, p, p + 32);
    dv.setUint32(p + 0, LVCF_TEXT | LVCF_WIDTH | LVCF_SUBITEM, true);
    dv.setUint32(p + 12, textG, true);
    dv.setInt32(p + 16, 64, true);
    const ok = e.send_message(lv, LVM_GETCOLUMNA, idx, g);
    return {
      ok,
      width: dv.getInt32(p + 8, true),
      text: readStr(textG, 64),
      subItem: dv.getInt32(p + 20, true),
    };
  }
  function setColumn(idx, text, width) {
    const g = e.guest_alloc(32);
    const p = wa(g);
    u8.fill(0, p, p + 32);
    dv.setUint32(p + 0, LVCF_TEXT | LVCF_WIDTH, true);
    dv.setInt32(p + 8, width, true);
    dv.setUint32(p + 12, writeStr(text), true);
    return e.send_message(lv, LVM_SETCOLUMNA, idx, g);
  }
  function insertItem(idx, text) {
    const g = e.guest_alloc(40);
    const p = wa(g);
    u8.fill(0, p, p + 40);
    dv.setUint32(p + 0, LVIF_TEXT, true);
    dv.setInt32(p + 4, idx, true);
    dv.setInt32(p + 8, 0, true);
    dv.setUint32(p + 20, writeStr(text), true);
    return e.send_message(lv, LVM_INSERTITEMA, 0, g);
  }
  function setSubitem(item, sub, text) {
    const g = e.guest_alloc(40);
    const p = wa(g);
    u8.fill(0, p, p + 40);
    dv.setInt32(p + 8, sub, true);
    dv.setUint32(p + 20, writeStr(text), true);
    return e.send_message(lv, LVM_SETITEMTEXTA, item, g);
  }
  function getItemText(item, sub) {
    const itemG = e.guest_alloc(40);
    const textG = e.guest_alloc(64);
    const p = wa(itemG);
    u8.fill(0, p, p + 40);
    dv.setInt32(p + 8, sub, true);
    dv.setUint32(p + 20, textG, true);
    dv.setInt32(p + 24, 64, true);
    const len = e.send_message(lv, LVM_GETITEMTEXTA, item, itemG);
    return { len, text: readStr(textG, 64) };
  }
  function getRect(msg, item, leftInput, topInput = 0) {
    const g = e.guest_alloc(16);
    const p = wa(g);
    u8.fill(0, p, p + 16);
    dv.setInt32(p + 0, leftInput, true);
    dv.setInt32(p + 4, topInput, true);
    const ok = e.send_message(lv, msg, item, g);
    return {
      ok,
      left: dv.getInt32(p + 0, true),
      top: dv.getInt32(p + 4, true),
      right: dv.getInt32(p + 8, true),
      bottom: dv.getInt32(p + 12, true),
    };
  }

  const baselineSlots = e.wnd_count_used();
  check('SysListView32 is protected from registered-class fallback', e.test_is_builtin_control_class(writeStr('SysListView32')) === 1);
  const lv = e.test_create_listview(0, 0, 220, 82, 1, 0x200);
  check('listview hwnd allocated', lv !== 0, 'hwnd=0x' + lv.toString(16));
  check('create added 2 slots (parent + listview)', e.wnd_count_used() === baselineSlots + 2);

  check('LVM_INSERTCOLUMNA Name returns 0', insertColumn(0, 'Name', 120) === 0);
  check('LVM_INSERTCOLUMNA Type returns 1', insertColumn(1, 'Type', 80) === 1);
  check('column count is 2', e.listview_get_column_count(lv) === 2);
  check('column width round-trips through message', e.send_message(lv, LVM_GETCOLUMNWIDTH, 0, 0) === 120);
  check('column width export agrees', e.listview_get_column_width(lv, 1) === 80);
  const col0 = getColumn(0);
  check('LVM_GETCOLUMNA returns stored first header', col0.ok === 1 && col0.width === 120 && col0.text === 'Name' && col0.subItem === 0, JSON.stringify(col0));
  check('LVM_SETCOLUMNA updates second header', setColumn(1, 'Kind', 90) === 1);
  const col1 = getColumn(1);
  check('LVM_GETCOLUMNA returns updated second header', col1.ok === 1 && col1.width === 90 && col1.text === 'Kind' && col1.subItem === 1, JSON.stringify(col1));
  check('LVM_GETCOLUMNWIDTH follows LVM_SETCOLUMNA', e.send_message(lv, LVM_GETCOLUMNWIDTH, 1, 0) === 90);

  for (let i = 0; i < 12; i++) {
    check(`LVM_INSERTITEMA row ${i}`, insertItem(i, `Value ${i}`) === i);
    check(`LVM_SETITEMTEXTA row ${i} subitem`, setSubitem(i, 1, i % 2 ? 'REG_DWORD' : 'REG_SZ') === 1);
  }
  check('LVM_GETITEMCOUNT is 12', e.send_message(lv, LVM_GETITEMCOUNT, 0, 0) === 12);
  check('count export is 12', e.listview_get_count(lv) === 12);

  const row5 = getItemText(5, 0);
  check('LVM_GETITEMTEXTA row text length', row5.len === 'Value 5'.length);
  check('LVM_GETITEMTEXTA row text value', row5.text === 'Value 5', row5.text);
  const row5Type = getItemText(5, 1);
  check('LVM_GETITEMTEXTA subitem text value', row5Type.text === 'REG_DWORD', row5Type.text);

  const exportBuf = e.guest_alloc(64);
  const exportLen = e.listview_get_item_text(lv, 4, 1, exportBuf, 64);
  check('listview_get_item_text export length', exportLen === 'REG_SZ'.length);
  check('listview_get_item_text export value', readStr(exportBuf, 64) === 'REG_SZ');

  check('visible row count is 4 with header', e.listview_get_visible_rows(lv) === 4);
  check('max scroll is 8 for 4-row viewport', e.listview_get_max_scroll(lv) === 8);
  check('initial top index is 0', e.send_message(lv, LVM_GETTOPINDEX, 0, 0) === 0);
  check('LVM_GETCOUNTPERPAGE is 4', e.send_message(lv, LVM_GETCOUNTPERPAGE, 0, 0) === 4);

  check('WM_PAINT handles populated listview', e.send_message(lv, WM_PAINT, 0, 0) === 0);

  e.send_message(lv, WM_MOUSEWHEEL, (-120 << 16), 0);
  check('mouse wheel scrolls down 3 rows', e.listview_get_top_index(lv) === 3);
  check('LVM_GETTOPINDEX follows wheel scroll', e.send_message(lv, LVM_GETTOPINDEX, 0, 0) === 3);

  const ht = e.guest_alloc(20);
  const htp = wa(ht);
  u8.fill(0, htp, htp + 20);
  dv.setInt32(htp + 0, 20, true);
  dv.setInt32(htp + 4, 20, true);
  check('LVM_HITTEST maps top row through scroll offset', e.send_message(lv, LVM_HITTEST, 0, ht) === 3);
  check('LVM_HITTEST writes scrolled iItem', dv.getInt32(htp + 12, true) === 3);
  dv.setInt32(htp + 0, 130, true);
  dv.setInt32(htp + 4, 20, true);
  check('LVM_HITTEST writes report subitem index', e.send_message(lv, LVM_HITTEST, 0, ht) === 3 && dv.getInt32(htp + 16, true) === 1);

  const itemRect = getRect(LVM_GETITEMRECT, 5, LVIR_BOUNDS);
  check('LVM_GETITEMRECT returns scrolled row bounds', itemRect.ok === 1 && itemRect.left === 0 && itemRect.top === 50 && itemRect.right === 204 && itemRect.bottom === 66, JSON.stringify(itemRect));
  const subRect = getRect(LVM_GETSUBITEMRECT, 5, LVIR_BOUNDS, 1);
  check('LVM_GETSUBITEMRECT returns second-column bounds', subRect.ok === 1 && subRect.left === 120 && subRect.top === 50 && subRect.right === 210 && subRect.bottom === 66, JSON.stringify(subRect));
  const subLabelRect = getRect(LVM_GETSUBITEMRECT, 5, LVIR_LABEL, 1);
  check('LVM_GETSUBITEMRECT honors label inset', subLabelRect.ok === 1 && subLabelRect.left === 124 && subLabelRect.top === 50 && subLabelRect.right === 210 && subLabelRect.bottom === 66, JSON.stringify(subLabelRect));

  e.send_message(lv, WM_LBUTTONDOWN, 1, makeLParam(20, 38));
  check('click on visible row 1 selects underlying row 4', e.listview_get_selected_index(lv) === 4);
  check('LVM_GETSELECTEDCOUNT reports one selected row', e.send_message(lv, LVM_GETSELECTEDCOUNT, 0, 0) === 1);
  check('LVM_GETNEXTITEM finds selected row', e.send_message(lv, LVM_GETNEXTITEM, 0xFFFFFFFF, LVNI_SELECTED) === 4);
  check('LVM_GETITEMSTATE reports selected bit', e.send_message(lv, LVM_GETITEMSTATE, 4, LVIS_SELECTED) === LVIS_SELECTED);

  const stateG = e.guest_alloc(40);
  const stateP = wa(stateG);
  u8.fill(0, stateP, stateP + 40);
  dv.setUint32(stateP + 0, LVIF_STATE, true);
  dv.setUint32(stateP + 12, LVIS_SELECTED, true);
  dv.setUint32(stateP + 16, LVIS_SELECTED, true);
  check('LVM_SETITEMSTATE can move selection', e.send_message(lv, LVM_SETITEMSTATE, 2, stateG) === 1);
  check('selection export follows LVM_SETITEMSTATE', e.listview_get_selected_index(lv) === 2);

  e.send_message(lv, WM_LBUTTONDOWN, 1, makeLParam(212, 76));
  e.send_message(lv, WM_LBUTTONUP, 0, makeLParam(212, 76));
  check('scrollbar down arrow advances one row', e.listview_get_top_index(lv) === 4);

  e.send_message(lv, WM_LBUTTONDOWN, 1, makeLParam(212, 22));
  e.send_message(lv, WM_LBUTTONUP, 0, makeLParam(212, 22));
  check('scrollbar page-up region moves up by viewport rows', e.listview_get_top_index(lv) === 0);

  e.send_message(lv, WM_VSCROLL, (6 << 16) | SB_THUMBTRACK, 0);
  check('WM_VSCROLL thumb track sets top index', e.listview_get_top_index(lv) === 6);

  e.send_message(lv, WM_LBUTTONDOWN, 1, makeLParam(212, 45));
  e.send_message(lv, WM_MOUSEMOVE, 1, makeLParam(212, 65));
  e.send_message(lv, WM_LBUTTONUP, 0, makeLParam(212, 65));
  check('scrollbar thumb drag changes top index', e.listview_get_top_index(lv) > 6);

  check('LVM_ENSUREVISIBLE scrolls target row into view', e.send_message(lv, LVM_ENSUREVISIBLE, 1, 0) === 1);
  check('top index follows LVM_ENSUREVISIBLE upward', e.listview_get_top_index(lv) === 1);

  check('LVM_SCROLL by one row changes top index', e.send_message(lv, LVM_SCROLL, 0, 16) === 1);
  check('top index follows LVM_SCROLL pixels', e.listview_get_top_index(lv) === 2);

  check('LVM_DELETEALLITEMS succeeds', e.send_message(lv, LVM_DELETEALLITEMS, 0, 0) === 1);
  check('LVM_DELETEALLITEMS clears count', e.listview_get_count(lv) === 0);
  check('LVM_DELETEALLITEMS clears selection', e.listview_get_selected_index(lv) === -1);

  if (e.wnd_destroy_tree) e.wnd_destroy_tree(lv - 1);
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
