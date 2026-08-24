#!/usr/bin/env node
'use strict';

// MSComDlg.CommonDialog is served by our own IDispatch stub, and VB6 drives it
// entirely through property puts. The bag used to retain integers only, so
// every string property (Filter, FileName, InitDir, DialogTitle) came back as
// DISP_E_TYPEMISMATCH — which VB reports as a hard "Type mismatch" runtime
// error, killing File > Open in every VB app. Cover the VARIANT shapes VB
// actually sends, plus the Filter translation the file dialog consumes.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_cd_alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (call $heap_alloc (local.get $n)))
    (call $zero_memory (call $g2w (local.get $p)) (local.get $n))
    (local.get $p))

  (func (export "test_cd_put") (param $slot i32) (param $variant i32) (result i32)
    (call $cd_prop_put (local.get $slot) (local.get $variant)))

  (func (export "test_cd_filter") (param $bstr i32) (result i32)
    (call $cd_filter_to_ofn (local.get $bstr)))

  (func (export "test_cd_bstr") (param $wide i32) (result i32)
    (call $ole_font_bstr_dup (local.get $wide)))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const g2w = guest => (guest - imageBase + guestBase) >>> 0;

  const wide = text => {
    const p = e.test_cd_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) {
      view.setUint16(g2w(p) + i * 2, text.charCodeAt(i), true);
    }
    view.setUint16(g2w(p) + text.length * 2, 0, true);
    return p;
  };
  const readWide = ptr => {
    let out = '';
    for (let i = 0; ; i++) {
      const c = view.getUint16(g2w(ptr) + i * 2, true);
      if (!c) return out;
      out += String.fromCharCode(c);
    }
  };
  const variant = (vt, value) => {
    const p = e.test_cd_alloc(16) >>> 0;
    view.setUint16(g2w(p), vt, true);
    view.setUint32(g2w(p) + 8, value >>> 0, true);
    return p;
  };
  const slot = () => e.test_cd_alloc(8) >>> 0;
  const slotVt = s => view.getUint32(g2w(s), true);
  const slotVal = s => view.getUint32(g2w(s) + 4, true) >>> 0;

  // The put that used to fail: a plain BSTR.
  let s = slot();
  assert.strictEqual(e.test_cd_put(s, variant(8, e.test_cd_bstr(wide('*.bmp')))), 0,
    'a BSTR property put is accepted');
  assert.strictEqual(slotVt(s), 8, 'the slot records VT_BSTR');
  assert.strictEqual(readWide(slotVal(s)), '*.bmp', 'the slot owns a copy of the string');

  // The slot owns its string, so a second put replaces it. The allocator hands
  // the freed block straight back, so re-using the same address is the proof
  // the old string was released rather than leaked.
  const firstBstr = slotVal(s);
  assert.strictEqual(e.test_cd_put(s, variant(8, e.test_cd_bstr(wide('*.jpg')))), 0,
    'a repeated BSTR put is accepted');
  assert.strictEqual(readWide(slotVal(s)), '*.jpg', 'the newest value wins');
  assert.strictEqual(slotVal(s), firstBstr, 'the previous string was freed, not leaked');

  // VB6 hands most property puts over as VT_VARIANT|VT_BYREF.
  s = slot();
  const inner = variant(8, e.test_cd_bstr(wide('C:\\pic.bmp')));
  assert.strictEqual(e.test_cd_put(s, variant(0x400c, inner)), 0,
    'a VT_VARIANT|VT_BYREF wrapper is unwrapped');
  assert.strictEqual(slotVt(s), 8, 'the wrapped type reaches the slot');
  assert.strictEqual(readWide(slotVal(s)), 'C:\\pic.bmp', 'the wrapped string reaches the slot');

  // Scalars keep working, with VT_BOOL normalised to the VARIANT_BOOL values.
  s = slot();
  assert.strictEqual(e.test_cd_put(s, variant(11, 1)), 0, 'VT_BOOL is accepted');
  assert.strictEqual(slotVal(s) | 0, -1, 'a true VT_BOOL is stored as -1');
  assert.strictEqual(e.test_cd_put(s, variant(3, 0x00ffffff)), 0, 'VT_I4 is accepted');
  assert.strictEqual(slotVal(s), 0x00ffffff, 'the Color property round-trips');

  // A SAFEARRAY has no single-dword form; that one really is a type mismatch.
  assert.strictEqual(e.test_cd_put(slot(), variant(0x2008, 0)) >>> 0, 0x80020005,
    'an array property put is still DISP_E_TYPEMISMATCH');

  // OPENFILENAME wants the pipe-separated Filter as NUL-separated pairs with a
  // double NUL at the end.
  const filter = e.test_cd_filter(e.test_cd_bstr(wide('Bitmaps|*.bmp|All|*.*'))) >>> 0;
  const raw = Array.from(bytes.slice(g2w(filter), g2w(filter) + 23));
  assert.deepStrictEqual(raw,
    [...Buffer.from('Bitmaps'), 0, ...Buffer.from('*.bmp'), 0,
     ...Buffer.from('All'), 0, ...Buffer.from('*.*'), 0, 0],
    'the Filter string becomes a double-NUL-terminated OPENFILENAME filter');

  console.log('PASS  CommonDialog retains the automation types VB6 actually puts');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
