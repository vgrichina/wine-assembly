#!/usr/bin/env node
'use strict';

// SHBrowseForFolderA is a synchronous shell API, but its visible state is a
// classic modal TreeView. Exercise the dialog internals directly so this test
// can inspect lazy expansion, selection, PIDL/display-name writeback, and
// destruction without parking an x86 caller in the modal thunk.

const assert = require('assert');
const { bootRenderHarness, countUniqueColors, writePng } = require('./render-helper');
const RegionMap = require('../lib/region-map.generated.js');

const EXTRA_WAT = String.raw`
  (func (export "test_create_browse_dialog") (param $bi i32) (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_browse_dialog (local.get $dlg) (i32.const 0) (local.get $bi))
    (local.get $dlg))
  (func (export "test_browse_modal_finish") (param $dlg i32) (param $item i32) (result i32)
    (call $browse_modal_finish (local.get $dlg) (local.get $item)))
  (func (export "test_browse_selection_allowed") (param $dlg i32) (param $item i32) (result i32)
    (call $browse_selection_allowed (local.get $dlg) (local.get $item)))
  (func (export "test_shell_pidl_from_path") (param $path i32) (result i32)
    (call $shell_filesystem_pidl_from_path (local.get $path)))
  (func (export "test_shell_pidl_copy_path") (param $pidl i32) (param $path i32) (result i32)
    (call $shell_filesystem_pidl_copy_path (local.get $pidl) (local.get $path)))
  (func (export "test_tv_live_count") (result i32) (global.get $tv_count))
`;

const TVM_EXPAND = 0x1102;
const TVM_GETCOUNT = 0x1105;
const TVM_GETNEXTITEM = 0x110a;
const TVM_SELECTITEM = 0x110b;
const TVM_GETITEMA = 0x110c;
const TVGN_ROOT = 0;
const TVGN_NEXTVISIBLE = 6;
const TVGN_CARET = 9;

(async () => {
  const harness = await bootRenderHarness({ extraWat: EXTRA_WAT });
  const { exports: e, memory, hostCtx, renderer, canvas } = harness;
  const vfs = hostCtx.vfs;
  // Keep the render harness's bundled Win98 fonts mounted; clearing the VFS
  // here would turn a functional dialog into a misleading textless capture.
  for (const dir of [
    'c:', 'c:\\', 'c:\\Games', 'c:\\Games\\Classics',
    'c:\\My Documents', 'd:', 'd:\\',
  ]) vfs.dirs.add(dir.toLowerCase());

  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => RegionMap.g2w(g >>> 0, e.get_image_base());
  const alloc = n => e.guest_alloc(n) >>> 0;

  function writeString(text) {
    const g = alloc(text.length + 1);
    const p = wa(g);
    for (let i = 0; i < text.length; i++) u8[p + i] = text.charCodeAt(i);
    u8[p + text.length] = 0;
    return g;
  }

  function readString(g, limit = 260) {
    let out = '';
    const p = wa(g);
    for (let i = 0; i < limit && u8[p + i]; i++) out += String.fromCharCode(u8[p + i]);
    return out;
  }

  function makeBrowseInfo({ root = 0, flags = 1, title = 'Choose a destination folder' } = {}) {
    const bi = alloc(32);
    const p = wa(bi);
    u8.fill(0, p, p + 32);
    const display = alloc(260);
    u8.fill(0xcc, wa(display), wa(display) + 260);
    dv.setUint32(p + 4, root >>> 0, true);
    dv.setUint32(p + 8, display, true);
    dv.setUint32(p + 12, writeString(title), true);
    dv.setUint32(p + 16, flags >>> 0, true);
    dv.setUint32(p + 28, 0xdeadbeef, true);
    return { bi, display };
  }

  function findChildById(parent, id) {
    for (let slot = 0; slot < 256; slot++) {
      const hwnd = e.wnd_slot_hwnd(slot) >>> 0;
      if (hwnd && (e.wnd_get_parent(hwnd) >>> 0) === (parent >>> 0) &&
          (e.ctrl_get_id(hwnd) >>> 0) === (id >>> 0)) return hwnd;
    }
    return 0;
  }

  function countRegionColors(x, y, w, h) {
    const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      colors.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
    }
    return colors.size;
  }

  function readItem(tree, item) {
    const tvitem = alloc(40);
    const text = alloc(260);
    const p = wa(tvitem);
    u8.fill(0, p, p + 40);
    dv.setUint32(p, 0x5, true); // TVIF_TEXT | TVIF_PARAM
    dv.setUint32(p + 4, item >>> 0, true);
    dv.setUint32(p + 16, text, true);
    dv.setInt32(p + 20, 260, true);
    assert.strictEqual(e.send_message(tree, TVM_GETITEMA, 0, tvitem) | 0, 1);
    return { item: item >>> 0, text: readString(text), data: dv.getUint32(p + 36, true) };
  }

  function visibleItems(tree) {
    const out = [];
    let item = e.send_message(tree, TVM_GETNEXTITEM, TVGN_ROOT, 0) >>> 0;
    while (item && out.length < 512) {
      out.push(readItem(tree, item));
      item = e.send_message(tree, TVM_GETNEXTITEM, TVGN_NEXTVISIBLE, item) >>> 0;
    }
    return out;
  }

  const { bi, display } = makeBrowseInfo();
  const dlg = e.test_create_browse_dialog(bi) >>> 0;
  const tree = findChildById(dlg, 0x470);
  const ok = findChildById(dlg, 1);
  const cancel = findChildById(dlg, 2);
  assert(dlg && tree, 'folder picker and TreeView were created');
  assert(ok && cancel, 'classic IDOK and IDCANCEL buttons were created');
  assert.strictEqual(renderer.windows[dlg].title, 'Browse for Folder');

  let items = visibleItems(tree);
  assert.deepStrictEqual(items.slice(0, 3).map(x => x.text),
    ['Desktop', 'My Documents', 'My Computer']);
  assert(items.some(x => x.text === 'C:\\'), 'C: is exposed under My Computer');
  assert(items.some(x => x.text === 'D:\\'), 'D: is exposed under My Computer');
  assert(items.some(x => x.text === 'Network Neighborhood'), 'classic namespace root is present');
  const desktop = items.find(x => x.text === 'Desktop');
  assert.strictEqual(e.test_browse_selection_allowed(dlg, desktop.item) | 0, 0,
    'BIF_RETURNONLYFSDIRS rejects a virtual Desktop selection');

  const driveC = items.find(x => x.text === 'C:\\');
  assert.strictEqual(e.send_message(tree, TVM_EXPAND, 2, driveC.item) | 0, 1,
    'expanding C: materializes its VFS directories');
  items = visibleItems(tree);
  const games = items.find(x => x.text.toLowerCase() === 'games');
  assert(games, `C:\\Games appears after lazy expansion: ${JSON.stringify(items.map(x => x.text))}`);
  assert.strictEqual(e.send_message(tree, TVM_EXPAND, 2, games.item) | 0, 1,
    'expanding Games materializes nested directories');
  items = visibleItems(tree);
  const classics = items.find(x => x.text.toLowerCase() === 'classics');
  assert(classics, 'C:\\Games\\Classics appears in the folder tree');
  assert.strictEqual(e.send_message(tree, TVM_SELECTITEM, TVGN_CARET, classics.item) | 0, 1);
  assert.strictEqual(e.send_message(tree, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0, classics.item);

  renderer.repaint();
  assert(countUniqueColors(canvas) >= 8, 'classic picker paints a nonblank Win98 dialog');
  const win = renderer.windows[dlg];
  assert(countRegionColors(win.x + 10, win.y + 30, 300, 30) > 1,
    'instruction text is painted during the initial exposure pass');
  assert(countRegionColors(win.x + 140, win.y + 260, 165, 32) > 2,
    'OK and Cancel are painted during the initial exposure pass');
  console.log('wrote ' + writePng(canvas, 'shbrowseforfolder.png'));

  const pidl = e.test_browse_modal_finish(dlg, classics.item) >>> 0;
  assert(pidl, 'OK returns an allocated PIDL');
  assert.strictEqual(readString(display).toLowerCase(), 'classics',
    'pszDisplayName receives the selected display name');
  assert.strictEqual(dv.getUint32(wa(bi) + 28, true), 0, 'iImage receives a shell image index');
  const selectedPath = alloc(260);
  assert.strictEqual(e.test_shell_pidl_copy_path(pidl, selectedPath) | 0, 1);
  assert.strictEqual(readString(selectedPath).toLowerCase(), 'c:\\games\\classics');
  e.wnd_destroy_tree(dlg);
  assert.strictEqual(e.test_tv_live_count() | 0, 0,
    'destroying the picker releases copied TreeView items and view state');

  // A filesystem pidlRoot constrains the tree to that root rather than
  // rebuilding Desktop/My Computer above it.
  const gamesPath = writeString('C:\\Games');
  const gamesRoot = e.test_shell_pidl_from_path(gamesPath) >>> 0;
  const rooted = makeBrowseInfo({ root: gamesRoot });
  const dlg2 = e.test_create_browse_dialog(rooted.bi) >>> 0;
  const tree2 = findChildById(dlg2, 0x470);
  const rootedItems = visibleItems(tree2);
  assert.strictEqual(rootedItems[0].text, 'C:\\Games');
  assert(!rootedItems.some(x => x.text === 'Desktop' || x.text === 'My Computer'));
  const rootedResult = e.test_browse_modal_finish(dlg2, rootedItems[0].item) >>> 0;
  assert(rootedResult);
  const rootedPath = alloc(260);
  assert.strictEqual(e.test_shell_pidl_copy_path(rootedResult, rootedPath) | 0, 1);
  assert.strictEqual(readString(rootedPath).toLowerCase(), 'c:\\games');
  e.wnd_destroy_tree(dlg2);
  assert.strictEqual(e.test_tv_live_count() | 0, 0,
    'a second open/close cycle leaves no TreeView state behind');

  console.log('PASS  SHBrowseForFolderA classic tree, PIDL writeback, root semantics, and cleanup');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
