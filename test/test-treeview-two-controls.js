#!/usr/bin/env node
'use strict';

// Two SysTreeView32 controls alive at the same time. Every item, the caret and
// the image list used to be process-wide state, which looks correct while an
// app only ever shows one tree and is plainly wrong when it shows two: Winamp
// opens its AVS editor on top of its preferences window, and the editor's tree
// painted the preferences tree's items and followed its selection.
//
// Nothing here is about drawing -- it asks each control what it contains and
// what its caret is, which is what the app asks before it paints.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const TVM_INSERTITEMA = 0x1100;
const TVM_GETCOUNT = 0x1105;
const TVM_GETIMAGELIST = 0x1108;
const TVM_SETIMAGELIST = 0x1109;
const TVM_GETNEXTITEM = 0x110a;
const TVM_SELECTITEM = 0x110b;
const TVGN_ROOT = 0;
const TVGN_NEXTVISIBLE = 6;
const TVGN_CARET = 9;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({});
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => (g - e.get_image_base() + 0x12000) >>> 0;

  function writeStr(s) {
    const g = e.guest_alloc(s.length + 1) >>> 0;
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    return g;
  }

  function insertItem(tv, text) {
    const g = e.guest_alloc(56) >>> 0;
    const p = wa(g);
    u8.fill(0, p, p + 56);
    dv.setUint32(p + 8, 0x0001, true); // TVIF_TEXT, root-level item
    dv.setUint32(p + 24, writeStr(text), true);
    return e.send_message(tv, TVM_INSERTITEMA, 0, g) >>> 0;
  }

  // Walk one control's items the way a paint pass does, in display order.
  function walk(tv) {
    const items = [];
    let h = e.send_message(tv, TVM_GETNEXTITEM, TVGN_ROOT, 0) >>> 0;
    while (h && items.length < 64) {
      items.push(h);
      h = e.send_message(tv, TVM_GETNEXTITEM, TVGN_NEXTVISIBLE, h) >>> 0;
    }
    return items;
  }

  const prefs = e.test_create_treeview(0, 0, 160, 68, 0) >>> 0;
  const editor = e.test_create_treeview(200, 0, 160, 68, 0) >>> 0;
  assert(prefs && editor && prefs !== editor, 'two distinct TreeViews exist');

  const prefsItems = ['Setup', 'Options', 'Plug-ins'].map(t => insertItem(prefs, t));
  const editorItems = ['Main', 'Render'].map(t => insertItem(editor, t));
  assert(prefsItems.every(Boolean) && editorItems.every(Boolean),
    'every insert produced a handle');

  assert.strictEqual(e.send_message(prefs, TVM_GETCOUNT, 0, 0) | 0, 3,
    'TVM_GETCOUNT counts the items of the control it was sent to');
  assert.strictEqual(e.send_message(editor, TVM_GETCOUNT, 0, 0) | 0, 2,
    'the second control reports only its own items');

  assert.deepStrictEqual(walk(prefs), prefsItems,
    'the first control enumerates its own items in insertion order');
  assert.deepStrictEqual(walk(editor), editorItems,
    'the second control enumerates its own items, not the first control\'s');

  // Win98 gives the first inserted item the caret, per control.
  assert.strictEqual(e.send_message(prefs, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0,
    prefsItems[0], 'the first control caret defaults to its own first item');
  assert.strictEqual(e.send_message(editor, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0,
    editorItems[0], 'the second control has its own default caret');

  // Selecting in one control must not move the other's caret.
  assert.strictEqual(
    e.send_message(editor, TVM_SELECTITEM, TVGN_CARET, editorItems[1]) | 0, 1,
    'selecting an item in the second control succeeds');
  assert.strictEqual(e.send_message(editor, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0,
    editorItems[1], 'the second control caret moved');
  assert.strictEqual(e.send_message(prefs, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0,
    prefsItems[0], 'the first control caret did not move');

  // An item's TVIS_SELECTED bit belongs to its own control too: the clear pass
  // that runs on select used to sweep the whole table.
  assert.strictEqual(
    e.send_message(prefs, TVM_SELECTITEM, TVGN_CARET, prefsItems[2]) | 0, 1,
    'selecting an item in the first control succeeds');
  assert.strictEqual(e.send_message(editor, TVM_GETNEXTITEM, TVGN_CARET, 0) >>> 0,
    editorItems[1], 'the second control kept its caret across the other select');

  // Image lists are per control as well.
  assert.strictEqual(e.send_message(prefs, TVM_SETIMAGELIST, 0, 0x1234) | 0, 0,
    'TVM_SETIMAGELIST returns the previous list, which was none');
  assert.strictEqual(e.send_message(prefs, TVM_GETIMAGELIST, 0, 0) >>> 0, 0x1234,
    'the control remembers the image list it was given');
  assert.strictEqual(e.send_message(editor, TVM_GETIMAGELIST, 0, 0) | 0, 0,
    'the other control still has no image list');

  console.log('PASS  two TreeViews keep their own items, caret and image list');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
