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

const LVM_GETBKCOLOR = 0x1000;
const LVM_SETBKCOLOR = 0x1001;
const LVM_GETITEMCOUNT = 0x1004;
const LVM_GETITEMA = 0x1005;
const LVM_SETITEMA = 0x1006;
const LVM_INSERTITEMA = 0x1007;
const LVM_DELETEITEM = 0x1008;
const LVM_DELETEALLITEMS = 0x1009;
const LVM_GETNEXTITEM = 0x100C;
const LVM_GETITEMRECT = 0x100E;
const LVM_HITTEST = 0x1012;
const LVM_ENSUREVISIBLE = 0x1013;
const LVM_SCROLL = 0x1014;
const LVM_GETCOLUMNA = 0x1019;
const LVM_SETCOLUMNA = 0x101A;
const LVM_INSERTCOLUMNA = 0x101B;
const LVM_DELETECOLUMN = 0x101C;
const LVM_GETCOLUMNWIDTH = 0x101D;
const LVM_GETHEADER = 0x101F;
const LVM_GETTOPINDEX = 0x1027;
const LVM_GETCOUNTPERPAGE = 0x1028;
const LVM_SETITEMSTATE = 0x102B;
const LVM_GETITEMSTATE = 0x102C;
const LVM_GETITEMTEXTA = 0x102D;
const LVM_SETITEMTEXTA = 0x102E;
const LVM_GETIMAGELIST = 0x1002;
const LVM_SETIMAGELIST = 0x1003;
const LVM_SETITEMPOSITION = 0x100F;
const LVM_GETITEMPOSITION = 0x1010;
const LVM_GETSTRINGWIDTHA = 0x1011;
const LVM_REDRAWITEMS = 0x1015;
const LVM_FINDITEMA = 0x100D;
const LVM_GETVIEWRECT = 0x1022;
const LVM_GETTEXTCOLOR = 0x1023;
const LVM_SETTEXTCOLOR = 0x1024;
const LVM_GETTEXTBKCOLOR = 0x1025;
const LVM_SETTEXTBKCOLOR = 0x1026;
const LVM_GETORIGIN = 0x1029;
const LVM_UPDATE = 0x102A;
const LVM_GETSELECTEDCOUNT = 0x1032;
const LVM_GETITEMSPACING = 0x1033;
const LVM_GETSUBITEMRECT = 0x1038;
const WM_PAINT = 0x000F;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const WM_MOUSEWHEEL = 0x020A;
const LVIF_TEXT = 0x0001;
const LVIF_IMAGE = 0x0002;
const LVIF_PARAM = 0x0004;
const LVIF_STATE = 0x0008;
const LVFI_PARAM = 0x0001;
const LVFI_STRING = 0x0002;
const LVFI_PARTIAL = 0x0008;
const LVIS_SELECTED = 0x0002;
const LVNI_SELECTED = 0x0002;
const LVIR_BOUNDS = 0x0000;
const LVIR_LABEL = 0x0002;
const LVCF_WIDTH = 0x0002;
const LVCF_TEXT = 0x0004;
const LVCF_SUBITEM = 0x0008;
const SB_THUMBTRACK = 5;
const NM_CLICK = -2;
const LVN_ITEMCHANGED = -101;
const HDM_GETITEMCOUNT = 0x1200;
const HDM_GETITEMA = 0x1203;
const HDM_SETITEMA = 0x1204;
const HDM_LAYOUT = 0x1205;
const HDM_HITTEST = 0x1206;
const HDM_GETITEMRECT = 0x1207;
const HDM_ORDERTOINDEX = 0x120F;
const HDM_GETORDERARRAY = 0x1211;
const HDM_SETORDERARRAY = 0x1212;
const HDI_WIDTH = 0x0001;
const HDI_TEXT = 0x0002;
const HDI_FORMAT = 0x0004;
const HDI_ORDER = 0x0080;
const HHT_ONHEADER = 0x0002;
const CLR_NONE = 0xFFFFFFFF;
const CUSTOM_BK = 0x0000E8D8;
const CUSTOM_TEXT = 0x000020A0;
const CUSTOM_TEXT_BK = 0x0000D0F0;
const IMAGE_MASK = 0x00C0C0C0;

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
  const gdiTrace = {
    solidBrushColors: [],
    fillBrushColors: [],
    textColors: [],
    bkColors: [],
    bkModes: [],
    transparentBlts: [],
  };
  const brushColors = new Map();
  const resetGdiTrace = () => {
    gdiTrace.solidBrushColors.length = 0;
    gdiTrace.fillBrushColors.length = 0;
    gdiTrace.textColors.length = 0;
    gdiTrace.bkColors.length = 0;
    gdiTrace.bkModes.length = 0;
    gdiTrace.transparentBlts.length = 0;
  };
  const originalCreateSolidBrush = base.host.gdi_create_solid_brush;
  base.host.gdi_create_solid_brush = color => {
    const handle = originalCreateSolidBrush(color);
    gdiTrace.solidBrushColors.push(color >>> 0);
    brushColors.set(handle >>> 0, color >>> 0);
    return handle;
  };
  const originalFillRect = base.host.gdi_fill_rect;
  base.host.gdi_fill_rect = (hdc, left, top, right, bottom, hbrush) => {
    const brush = hbrush >>> 0;
    gdiTrace.fillBrushColors.push(brushColors.has(brush) ? brushColors.get(brush) : brush);
    return originalFillRect(hdc, left, top, right, bottom, hbrush);
  };
  const originalSetTextColor = base.host.gdi_set_text_color;
  base.host.gdi_set_text_color = (hdc, color) => {
    gdiTrace.textColors.push(color >>> 0);
    return originalSetTextColor(hdc, color);
  };
  const originalSetBkColor = base.host.gdi_set_bk_color;
  base.host.gdi_set_bk_color = (hdc, color) => {
    gdiTrace.bkColors.push(color >>> 0);
    return originalSetBkColor(hdc, color);
  };
  const originalSetBkMode = base.host.gdi_set_bk_mode;
  base.host.gdi_set_bk_mode = (hdc, mode) => {
    gdiTrace.bkModes.push(mode);
    return originalSetBkMode(hdc, mode);
  };
  const originalTransparentBlt = base.host.gdi_transparent_blt;
  base.host.gdi_transparent_blt = (dstDC, x, y, w, h, srcDC, sx, sy, key) => {
    gdiTrace.transparentBlts.push({
      dstDC: dstDC >>> 0,
      x, y, w, h,
      srcDC: srcDC >>> 0,
      sx, sy,
      key: key >>> 0,
    });
    return originalTransparentBlt(dstDC, x, y, w, h, srcDC, sx, sy, key);
  };

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
  function makeColorStripBitmap() {
    const width = 32;
    const height = 16;
    const bpp = 24;
    const rowBytes = Math.ceil((width * bpp) / 16) * 2;
    const bitsG = e.guest_alloc(rowBytes * height);
    const bits = wa(bitsG);
    u8.fill(0, bits, bits + rowBytes * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 192;
        let g = 192;
        let b = 192;
        if (x < 16 && x >= 3 && x < 13 && y >= 3 && y < 13) {
          r = 220; g = 20; b = 20;
        } else if (x >= 16 && x >= 19 && x < 29 && y >= 3 && y < 13) {
          r = 20; g = 160; b = 30;
        }
        const p = bits + y * rowBytes + x * 3;
        u8[p + 0] = b;
        u8[p + 1] = g;
        u8[p + 2] = r;
      }
    }
    return base.host.gdi_create_bitmap(width, height, bpp, bits);
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
  function getHeaderItem(header, idx) {
    const g = e.guest_alloc(48);
    const textG = e.guest_alloc(64);
    const p = wa(g);
    u8.fill(0, p, p + 48);
    dv.setUint32(p + 0, HDI_TEXT | HDI_WIDTH | HDI_FORMAT | HDI_ORDER, true);
    dv.setUint32(p + 8, textG, true);
    dv.setInt32(p + 16, 64, true);
    const ok = e.send_message(header, HDM_GETITEMA, idx, g);
    return {
      ok,
      width: dv.getInt32(p + 4, true),
      text: readStr(textG, 64),
      fmt: dv.getInt32(p + 20, true),
      order: dv.getInt32(p + 32, true),
    };
  }
  function setHeaderItem(header, idx, text, width, order = idx) {
    const g = e.guest_alloc(48);
    const p = wa(g);
    u8.fill(0, p, p + 48);
    dv.setUint32(p + 0, HDI_TEXT | HDI_WIDTH | HDI_ORDER, true);
    dv.setInt32(p + 4, width, true);
    dv.setUint32(p + 8, writeStr(text), true);
    dv.setInt32(p + 16, text.length + 1, true);
    dv.setInt32(p + 32, order, true);
    return e.send_message(header, HDM_SETITEMA, idx, g);
  }
  function headerLayout(header, left, top, right, bottom) {
    const rectG = e.guest_alloc(16);
    const rectP = wa(rectG);
    u8.fill(0, rectP, rectP + 16);
    dv.setInt32(rectP + 0, left, true);
    dv.setInt32(rectP + 4, top, true);
    dv.setInt32(rectP + 8, right, true);
    dv.setInt32(rectP + 12, bottom, true);
    const wpG = e.guest_alloc(28);
    const wpP = wa(wpG);
    u8.fill(0, wpP, wpP + 28);
    const layoutG = e.guest_alloc(8);
    const layoutP = wa(layoutG);
    dv.setUint32(layoutP + 0, rectG, true);
    dv.setUint32(layoutP + 4, wpG, true);
    const ok = e.send_message(header, HDM_LAYOUT, 0, layoutG);
    return {
      ok,
      rect: {
        left: dv.getInt32(rectP + 0, true),
        top: dv.getInt32(rectP + 4, true),
        right: dv.getInt32(rectP + 8, true),
        bottom: dv.getInt32(rectP + 12, true),
      },
      wp: {
        hwnd: dv.getUint32(wpP + 0, true),
        insertAfter: dv.getUint32(wpP + 4, true),
        x: dv.getInt32(wpP + 8, true),
        y: dv.getInt32(wpP + 12, true),
        cx: dv.getInt32(wpP + 16, true),
        cy: dv.getInt32(wpP + 20, true),
        flags: dv.getUint32(wpP + 24, true),
      },
    };
  }
  function headerOrderArray(header, setValues = null) {
    const g = e.guest_alloc(8);
    const p = wa(g);
    if (setValues) {
      for (let i = 0; i < setValues.length; i++) dv.setInt32(p + i * 4, setValues[i], true);
      return {
        ok: e.send_message(header, HDM_SETORDERARRAY, setValues.length, g),
        values: setValues,
      };
    }
    u8.fill(0xCC, p, p + 8);
    const ok = e.send_message(header, HDM_GETORDERARRAY, 2, g);
    return {
      ok,
      values: [dv.getInt32(p + 0, true), dv.getInt32(p + 4, true)],
    };
  }
  function headerHit(header, x, y) {
    const g = e.guest_alloc(16);
    const p = wa(g);
    u8.fill(0, p, p + 16);
    dv.setInt32(p + 0, x, true);
    dv.setInt32(p + 4, y, true);
    const item = e.send_message(header, HDM_HITTEST, 0, g);
    return {
      item,
      flags: dv.getInt32(p + 8, true),
      storedItem: dv.getInt32(p + 12, true),
    };
  }
  function insertItem(idx, text, image = 0, lParam = 0) {
    const g = e.guest_alloc(40);
    const p = wa(g);
    u8.fill(0, p, p + 40);
    dv.setUint32(p + 0, LVIF_TEXT | LVIF_IMAGE | LVIF_PARAM, true);
    dv.setInt32(p + 4, idx, true);
    dv.setInt32(p + 8, 0, true);
    dv.setUint32(p + 20, writeStr(text), true);
    dv.setInt32(p + 28, image, true);
    dv.setUint32(p + 36, lParam >>> 0, true);
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
  function setItemMeta(item, image, lParam) {
    const g = e.guest_alloc(40);
    const p = wa(g);
    u8.fill(0, p, p + 40);
    dv.setUint32(p + 0, LVIF_IMAGE | LVIF_PARAM, true);
    dv.setInt32(p + 4, item, true);
    dv.setInt32(p + 28, image, true);
    dv.setUint32(p + 36, lParam >>> 0, true);
    return e.send_message(lv, LVM_SETITEMA, 0, g);
  }
  function getItemMeta(item) {
    const g = e.guest_alloc(40);
    const p = wa(g);
    u8.fill(0, p, p + 40);
    dv.setUint32(p + 0, LVIF_IMAGE | LVIF_PARAM | LVIF_STATE, true);
    dv.setInt32(p + 4, item, true);
    const len = e.send_message(lv, LVM_GETITEMA, 0, g);
    return {
      len,
      image: dv.getInt32(p + 28, true),
      lParam: dv.getUint32(p + 36, true),
      state: dv.getUint32(p + 12, true),
    };
  }
  function findItem(start, flags, text = '', lParam = 0) {
    const g = e.guest_alloc(24);
    const p = wa(g);
    u8.fill(0, p, p + 24);
    dv.setUint32(p + 0, flags, true);
    if (text) dv.setUint32(p + 4, writeStr(text), true);
    dv.setUint32(p + 8, lParam >>> 0, true);
    return e.send_message(lv, LVM_FINDITEMA, start, g);
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
  function getPoint(msg, item) {
    const g = e.guest_alloc(8);
    const p = wa(g);
    u8.fill(0, p, p + 8);
    const ok = e.send_message(lv, msg, item, g);
    return {
      ok,
      x: dv.getInt32(p + 0, true),
      y: dv.getInt32(p + 4, true),
    };
  }

  const baselineSlots = e.wnd_count_used();
  check('SysListView32 is protected from registered-class fallback', e.test_is_builtin_control_class(writeStr('SysListView32')) === 1);
  const lv = e.test_create_listview(0, 0, 220, 82, 1, 0x200);
  check('listview hwnd allocated', lv !== 0, 'hwnd=0x' + lv.toString(16));
  check('create added 2 slots (parent + listview)', e.wnd_count_used() === baselineSlots + 2);
  check('initial LVM_GETIMAGELIST is empty', e.send_message(lv, LVM_GETIMAGELIST, 1, 0) === 0);
  check('LVM_SETIMAGELIST stores small image-list handle', e.send_message(lv, LVM_SETIMAGELIST, 1, 0x1234501) === 0);
  check('LVM_GETIMAGELIST returns assigned handle', e.send_message(lv, LVM_GETIMAGELIST, 1, 0) === 0x1234501);
  check('LVM_SETIMAGELIST returns previous handle', e.send_message(lv, LVM_SETIMAGELIST, 1, 0x1234502) === 0x1234501);
  const imageStrip = makeColorStripBitmap();
  const imageList = e.test_create_imagelist(16, 16, imageStrip, 2, IMAGE_MASK);
  check('test image-list helper returns a bounded handle', imageList !== 0);
  check('LVM_SETIMAGELIST accepts bounded image-list handle', e.send_message(lv, LVM_SETIMAGELIST, 1, imageList) === 0x1234502);
  check('LVM_GETIMAGELIST returns bounded image-list handle', e.send_message(lv, LVM_GETIMAGELIST, 1, 0) === imageList);
  check('initial LVM_GETBKCOLOR is COLOR_WINDOW white', e.send_message(lv, LVM_GETBKCOLOR, 0, 0) === 0x00FFFFFF);
  check('initial LVM_GETTEXTCOLOR is black', e.send_message(lv, LVM_GETTEXTCOLOR, 0, 0) === 0);
  check('initial LVM_GETTEXTBKCOLOR is white', e.send_message(lv, LVM_GETTEXTBKCOLOR, 0, 0) === 0x00FFFFFF);
  check('LVM_SETBKCOLOR returns previous background color', e.send_message(lv, LVM_SETBKCOLOR, 0, CUSTOM_BK) === 0x00FFFFFF);
  check('LVM_GETBKCOLOR returns stored background color', e.send_message(lv, LVM_GETBKCOLOR, 0, 0) === CUSTOM_BK);
  check('LVM_SETTEXTCOLOR returns previous text color', e.send_message(lv, LVM_SETTEXTCOLOR, 0, CUSTOM_TEXT) === 0);
  check('LVM_GETTEXTCOLOR returns stored text color', e.send_message(lv, LVM_GETTEXTCOLOR, 0, 0) === CUSTOM_TEXT);
  check('LVM_SETTEXTBKCOLOR returns previous text background', e.send_message(lv, LVM_SETTEXTBKCOLOR, 0, CUSTOM_TEXT_BK) === 0x00FFFFFF);
  check('LVM_GETTEXTBKCOLOR returns stored text background', e.send_message(lv, LVM_GETTEXTBKCOLOR, 0, 0) === CUSTOM_TEXT_BK);

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
  const header = e.send_message(lv, LVM_GETHEADER, 0, 0);
  check('LVM_GETHEADER returns pseudo-header handle', header === lv, 'header=0x' + header.toString(16));
  check('HDM_GETITEMCOUNT follows report columns', e.send_message(header, HDM_GETITEMCOUNT, 0, 0) === 2);
  const hd1 = getHeaderItem(header, 1);
  check('HDM_GETITEMA returns updated header item', hd1.ok === 1 && hd1.width === 90 && hd1.text === 'Kind' && hd1.fmt === 0 && hd1.order === 1, JSON.stringify(hd1));
  check('HDM_SETITEMA updates second header item', setHeaderItem(header, 1, 'Class', 96) === 1);
  const hd1Set = getHeaderItem(header, 1);
  check('HDM_GETITEMA returns header item set through HDM_SETITEMA', hd1Set.ok === 1 && hd1Set.width === 96 && hd1Set.text === 'Class' && hd1Set.order === 1, JSON.stringify(hd1Set));
  check('LVM_GETCOLUMNA follows HDM_SETITEMA width/text', (() => {
    const c = getColumn(1);
    return c.ok === 1 && c.width === 96 && c.text === 'Class';
  })());
  check('HDM_SETITEMA rejects non-identity order in pseudo-header', setHeaderItem(header, 1, 'BadOrder', 96, 0) === 0);
  const layout = headerLayout(header, 10, 20, 220, 120);
  check('HDM_LAYOUT returns header WINDOWPOS and shrinks client rect',
    layout.ok === 1 &&
      layout.rect.left === 10 && layout.rect.top === 38 && layout.rect.right === 220 && layout.rect.bottom === 120 &&
      layout.wp.hwnd === header && layout.wp.x === 10 && layout.wp.y === 20 &&
      layout.wp.cx === 210 && layout.wp.cy === 18 && (layout.wp.flags & 0x0014) === 0x0014,
    JSON.stringify(layout));
  check('HDM_ORDERTOINDEX is identity order', e.send_message(header, HDM_ORDERTOINDEX, 1, 0) === 1);
  const order = headerOrderArray(header);
  check('HDM_GETORDERARRAY returns identity order', order.ok === 1 && order.values[0] === 0 && order.values[1] === 1, JSON.stringify(order));
  check('HDM_SETORDERARRAY accepts identity order', headerOrderArray(header, [0, 1]).ok === 1);
  check('HDM_SETORDERARRAY rejects non-identity order', headerOrderArray(header, [1, 0]).ok === 0);
  const hdRect = getRect(HDM_GETITEMRECT, 1, 0);
  check('HDM_GETITEMRECT returns report header cell bounds', hdRect.ok === 1 && hdRect.left === 120 && hdRect.top === 0 && hdRect.right === 216 && hdRect.bottom === 18, JSON.stringify(hdRect));
  const hdHit = headerHit(header, 130, 5);
  check('HDM_HITTEST maps x coordinate to header item', hdHit.item === 1 && hdHit.flags === HHT_ONHEADER && hdHit.storedItem === 1, JSON.stringify(hdHit));

  for (let i = 0; i < 12; i++) {
    check(`LVM_INSERTITEMA row ${i}`, insertItem(i, `Value ${i}`, i + 10, 0xCAFE0000 + i) === i);
    check(`LVM_SETITEMTEXTA row ${i} subitem`, setSubitem(i, 1, i % 2 ? 'REG_DWORD' : 'REG_SZ') === 1);
  }
  check('LVM_GETITEMCOUNT is 12', e.send_message(lv, LVM_GETITEMCOUNT, 0, 0) === 12);
  check('count export is 12', e.listview_get_count(lv) === 12);
  check('LVM_GETSTRINGWIDTHA returns bounded text width', e.send_message(lv, LVM_GETSTRINGWIDTHA, 0, writeStr('abc')) === 26);
  check('LVM_FINDITEMA finds exact text case-insensitively', findItem(-1, LVFI_STRING, 'value 5') === 5);
  check('LVM_FINDITEMA honors partial text match', findItem(-1, LVFI_STRING | LVFI_PARTIAL, 'Val') === 0);
  check('LVM_FINDITEMA starts after supplied index', findItem(5, LVFI_STRING | LVFI_PARTIAL, 'Value') === 6);
  check('LVM_FINDITEMA finds lParam', findItem(-1, LVFI_PARAM, '', 0xCAFE0004) === 4);
  check('LVM_FINDITEMA reports not found', findItem(-1, LVFI_STRING, 'missing') === -1);

  const row5 = getItemText(5, 0);
  check('LVM_GETITEMTEXTA row text length', row5.len === 'Value 5'.length);
  check('LVM_GETITEMTEXTA row text value', row5.text === 'Value 5', row5.text);
  const row5Type = getItemText(5, 1);
  check('LVM_GETITEMTEXTA subitem text value', row5Type.text === 'REG_DWORD', row5Type.text);
  const row5Meta = getItemMeta(5);
  check('LVM_GETITEMA returns inserted image/lParam', row5Meta.image === 15 && row5Meta.lParam === 0xCAFE0005, JSON.stringify(row5Meta));
  check('LVM_SETITEMA updates image/lParam', setItemMeta(5, 77, 0x1234ABCD) === 1);
  const row5MetaUpdated = getItemMeta(5);
  check('LVM_GETITEMA returns updated image/lParam', row5MetaUpdated.image === 77 && row5MetaUpdated.lParam === 0x1234ABCD, JSON.stringify(row5MetaUpdated));
  check('LVM_SETITEMA updates a visible row to in-range image', setItemMeta(0, 1, 0xCAFE0000) === 1);
  const row0MetaUpdated = getItemMeta(0);
  check('LVM_GETITEMA returns in-range image metadata', row0MetaUpdated.image === 1 && row0MetaUpdated.lParam === 0xCAFE0000, JSON.stringify(row0MetaUpdated));

  const exportBuf = e.guest_alloc(64);
  const exportLen = e.listview_get_item_text(lv, 4, 1, exportBuf, 64);
  check('listview_get_item_text export length', exportLen === 'REG_SZ'.length);
  check('listview_get_item_text export value', readStr(exportBuf, 64) === 'REG_SZ');

  check('visible row count is 4 with header', e.listview_get_visible_rows(lv) === 4);
  check('max scroll is 8 for 4-row viewport', e.listview_get_max_scroll(lv) === 8);
  check('initial top index is 0', e.send_message(lv, LVM_GETTOPINDEX, 0, 0) === 0);
  check('LVM_GETCOUNTPERPAGE is 4', e.send_message(lv, LVM_GETCOUNTPERPAGE, 0, 0) === 4);

  resetGdiTrace();
  check('WM_PAINT handles populated listview', e.send_message(lv, WM_PAINT, 0, 0) === 0);
  check('WM_PAINT uses ListView custom background color', gdiTrace.solidBrushColors.includes(CUSTOM_BK), JSON.stringify(gdiTrace.solidBrushColors));
  check('WM_PAINT uses ListView custom text color', gdiTrace.textColors.includes(CUSTOM_TEXT), JSON.stringify(gdiTrace.textColors));
  check('WM_PAINT uses ListView custom text background color', gdiTrace.bkColors.includes(CUSTOM_TEXT_BK), JSON.stringify(gdiTrace.bkColors));
  check('WM_PAINT paints opaque row text background when text-bk is set', gdiTrace.bkModes.includes(2), JSON.stringify(gdiTrace.bkModes));
  check('WM_PAINT draws in-range report image from image-list strip',
    gdiTrace.transparentBlts.some(b => b.w === 16 && b.h === 16 && b.sx === 16 && b.sy === 0 && b.key === IMAGE_MASK),
    JSON.stringify(gdiTrace.transparentBlts));
  check('LVM_SETTEXTBKCOLOR accepts CLR_NONE', e.send_message(lv, LVM_SETTEXTBKCOLOR, 0, CLR_NONE) === CUSTOM_TEXT_BK);
  check('LVM_GETTEXTBKCOLOR returns CLR_NONE', (e.send_message(lv, LVM_GETTEXTBKCOLOR, 0, 0) >>> 0) === CLR_NONE);
  resetGdiTrace();
  check('WM_PAINT handles CLR_NONE text background', e.send_message(lv, WM_PAINT, 0, 0) === 0);
  check('CLR_NONE row paint leaves row text transparent', gdiTrace.textColors.includes(CUSTOM_TEXT) && !gdiTrace.bkColors.includes(CUSTOM_TEXT_BK), JSON.stringify(gdiTrace));

  e.send_message(lv, WM_MOUSEWHEEL, (-120 << 16), 0);
  check('mouse wheel scrolls down 3 rows', e.listview_get_top_index(lv) === 3);
  check('LVM_GETTOPINDEX follows wheel scroll', e.send_message(lv, LVM_GETTOPINDEX, 0, 0) === 3);
  const pos5 = getPoint(LVM_GETITEMPOSITION, 5);
  check('LVM_GETITEMPOSITION returns scrolled report y', pos5.ok === 1 && pos5.x === 0 && pos5.y === 50, JSON.stringify(pos5));
  check('LVM_SETITEMPOSITION is accepted as report no-op', e.send_message(lv, LVM_SETITEMPOSITION, 5, makeLParam(33, 44)) === 1);
  const origin = getPoint(LVM_GETORIGIN, 0);
  check('LVM_GETORIGIN reflects top-index scroll', origin.ok === 1 && origin.x === 0 && origin.y === -48, JSON.stringify(origin));
  const viewRect = getRect(LVM_GETVIEWRECT, 0, 0);
  check('LVM_GETVIEWRECT returns report content bounds', viewRect.ok === 1 && viewRect.left === 0 && viewRect.top === 0 && viewRect.right === 216 && viewRect.bottom === 210, JSON.stringify(viewRect));
  check('LVM_GETITEMSPACING returns report spacing', e.send_message(lv, LVM_GETITEMSPACING, 0, 0) === ((16 << 16) | 120));
  check('LVM_UPDATE accepts valid item', e.send_message(lv, LVM_UPDATE, 5, 0) === 1);
  check('LVM_REDRAWITEMS accepts visible range', e.send_message(lv, LVM_REDRAWITEMS, 0, 3) === 1);

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
  check('LVM_GETSUBITEMRECT returns second-column bounds', subRect.ok === 1 && subRect.left === 120 && subRect.top === 50 && subRect.right === 216 && subRect.bottom === 66, JSON.stringify(subRect));
  const subLabelRect = getRect(LVM_GETSUBITEMRECT, 5, LVIR_LABEL, 1);
  check('LVM_GETSUBITEMRECT honors label inset', subLabelRect.ok === 1 && subLabelRect.left === 124 && subLabelRect.top === 50 && subLabelRect.right === 216 && subLabelRect.bottom === 66, JSON.stringify(subLabelRect));

  const notifyBeforeClick = e.listview_get_debug_notify_count();
  e.send_message(lv, WM_LBUTTONDOWN, 1, makeLParam(20, 38));
  check('click on visible row 1 selects underlying row 4', e.listview_get_selected_index(lv) === 4);
  check('row selection sends LVN_ITEMCHANGED', e.listview_get_debug_notify_count() >= notifyBeforeClick + 2 &&
    e.listview_get_debug_notify_code() === LVN_ITEMCHANGED &&
    e.listview_get_debug_notify_item() === 4 &&
    e.listview_get_debug_notify_old_state() === 0 &&
    e.listview_get_debug_notify_new_state() === LVIS_SELECTED);
  e.send_message(lv, WM_LBUTTONUP, 0, makeLParam(20, 38));
  check('row click release sends NM_CLICK', e.listview_get_debug_notify_code() === NM_CLICK);
  check('LVM_GETSELECTEDCOUNT reports one selected row', e.send_message(lv, LVM_GETSELECTEDCOUNT, 0, 0) === 1);
  check('LVM_GETNEXTITEM finds selected row', e.send_message(lv, LVM_GETNEXTITEM, 0xFFFFFFFF, LVNI_SELECTED) === 4);
  check('LVM_GETITEMSTATE reports selected bit', e.send_message(lv, LVM_GETITEMSTATE, 4, LVIS_SELECTED) === LVIS_SELECTED);

  const stateG = e.guest_alloc(40);
  const stateP = wa(stateG);
  u8.fill(0, stateP, stateP + 40);
  dv.setUint32(stateP + 0, LVIF_STATE, true);
  dv.setUint32(stateP + 12, LVIS_SELECTED, true);
  dv.setUint32(stateP + 16, LVIS_SELECTED, true);
  const notifyBeforeState = e.listview_get_debug_notify_count();
  check('LVM_SETITEMSTATE can move selection', e.send_message(lv, LVM_SETITEMSTATE, 2, stateG) === 1);
  check('selection export follows LVM_SETITEMSTATE', e.listview_get_selected_index(lv) === 2);
  check('LVM_SETITEMSTATE sends selected-item LVN_ITEMCHANGED', e.listview_get_debug_notify_count() >= notifyBeforeState + 3 &&
    e.listview_get_debug_notify_code() === LVN_ITEMCHANGED &&
    e.listview_get_debug_notify_item() === 2 &&
    e.listview_get_debug_notify_old_state() === 0 &&
    e.listview_get_debug_notify_new_state() === LVIS_SELECTED);

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

  check('LVM_DELETEITEM removes selected row', e.send_message(lv, LVM_DELETEITEM, 2, 0) === 1);
  check('LVM_DELETEITEM decrements item count', e.listview_get_count(lv) === 11);
  check('LVM_DELETEITEM clears deleted selection', e.listview_get_selected_index(lv) === -1);
  const shiftedRow = getItemText(2, 0);
  check('LVM_DELETEITEM shifts following row text', shiftedRow.text === 'Value 3', shiftedRow.text);

  check('LVM_DELETECOLUMN removes second report column', e.send_message(lv, LVM_DELETECOLUMN, 1, 0) === 1);
  check('column count follows LVM_DELETECOLUMN', e.listview_get_column_count(lv) === 1);
  check('HDM_GETITEMCOUNT follows LVM_DELETECOLUMN', e.send_message(header, HDM_GETITEMCOUNT, 0, 0) === 1);
  check('LVM_GETCOLUMNWIDTH rejects deleted column', e.send_message(lv, LVM_GETCOLUMNWIDTH, 1, 0) === 0);

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
