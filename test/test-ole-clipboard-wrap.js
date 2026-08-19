#!/usr/bin/env node
'use strict';

// OleGetClipboard is not allowed to fail just because no app called
// OleSetClipboard. Real OLE wraps whatever the Win32 clipboard holds in its own
// IDataObject and returns that, so a caller can always ask for clipboard
// contents through one interface. We used to answer CLIPBRD_E_CANT_OPEN, and a
// caller that gets a failure here goes looking for another way in.
//
// These checks go at the wrapper directly, because the interesting part is
// which formats survive the trip: a format the clipboard holds must come back
// out of the data object byte for byte, and it must come out of a *copy*, so
// that releasing the object cannot free a buffer the clipboard still owns.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const n of ['create_thread', 'exit_thread', 'create_event', 'set_event',
                   'reset_event', 'wait_single', 'wait_multiple']) base.host[n] = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  ctx.exports = wat;

  const cases = [];
  const check = (name, pass, detail) => cases.push({ name, pass, detail });

  const alloc = (bytes) => {
    const g = wat.guest_alloc(bytes.length) >>> 0;
    for (let i = 0; i < bytes.length; i++) wat.guest_write8(g + i, bytes[i]);
    return g;
  };
  const readBytes = (g, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(wat.guest_read8(g + i) & 0xFF);
    return out;
  };

  // An empty clipboard has nothing to wrap, and saying so is the one case where
  // returning no object is right.
  wat.clipboard_clear_all_data();
  check('an empty clipboard produces no data object',
    wat.test_ole_clipboard_wrap_win32() === 0);

  // CF_DIB — the format that matters, because pasting a bitmap is the path that
  // sent WordPad through a null vtable when this returned nothing. A real
  // BITMAPINFOHEADER, since the object's extent is read out of it.
  const DIB_W = 32, DIB_H = 24, DIB_STRIDE = DIB_W * 3;
  const dib = [];
  const push32 = (v) => dib.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF);
  const push16 = (v) => dib.push(v & 0xFF, (v >> 8) & 0xFF);
  push32(40); push32(DIB_W); push32(DIB_H); push16(1); push16(24);
  push32(0); push32(DIB_STRIDE * DIB_H); push32(0); push32(0); push32(0); push32(0);
  for (let y = 0; y < DIB_H; y++) {
    for (let x = 0; x < DIB_W; x++) {
      const red = (((x >> 3) + (y >> 3)) % 2) === 0;
      dib.push(red ? 0 : 255, 0, red ? 255 : 0);   // BGR
    }
  }
  const dibG = alloc(dib);
  const stored = wat.clipboard_store_binary_data(8, dibG) >>> 0;   // CF_DIB
  check('the clipboard accepted a CF_DIB payload', stored !== 0);

  const obj = wat.test_ole_clipboard_wrap_win32() >>> 0;
  check('a populated clipboard produces a data object', obj !== 0, `obj=0x${obj.toString(16)}`);

  if (obj) {
    const fe = wat.guest_alloc(20) >>> 0;
    const med = wat.guest_alloc(12) >>> 0;
    for (let i = 0; i < 20; i++) wat.guest_write8(fe + i, 0);
    for (let i = 0; i < 12; i++) wat.guest_write8(med + i, 0);
    wat.guest_write32(fe, 8);            // cfFormat = CF_DIB (dwAspect follows)
    wat.guest_write32(fe + 8, 1);        // DVASPECT_CONTENT
    wat.guest_write32(fe + 12, -1);      // lindex
    wat.guest_write32(fe + 16, 1);       // TYMED_HGLOBAL

    check('the object reports CF_DIB as available',
      wat.test_ole_data_query(obj, fe) === 0);

    const hr = wat.test_ole_data_get(obj, fe, med) >>> 0;
    check('GetData returns the CF_DIB medium', hr === 0, `hr=0x${hr.toString(16)}`);
    const handle = wat.guest_read32(med + 4) >>> 0;
    check('GetData produced an HGLOBAL', handle !== 0);
    if (handle) {
      check('the bytes survive the round trip',
        JSON.stringify(readBytes(handle, dib.length)) === JSON.stringify(dib));
      check('the object holds a copy, not the clipboard buffer itself',
        handle !== stored, `handle=0x${handle.toString(16)} clipboard=0x${stored.toString(16)}`);
    }
  }

  // What a container actually does with that wrapper: OleCreateFromData turns a
  // presentation-only source into a static object. That object has to end up
  // with two things or it is invisible -- the render slot OleDraw blits from,
  // and an extent, since nothing else can tell a server-less picture how big it
  // is. An object missing either draws nothing and serializes an empty \pict.
  {
    wat.clipboard_clear_all_data();
    const dibG2 = alloc(dib);
    wat.clipboard_store_binary_data(8, dibG2);
    const src = wat.test_ole_clipboard_wrap_win32() >>> 0;
    const stat = src ? wat.test_ole_static_from_data(src) >>> 0 : 0;
    check('a presentation-only source yields a static object', stat !== 0);
    if (stat) {
      const fresh = wat.test_ole_create_static_handler ? 0 : 0;
      const hr = wat.test_ole_static_load_cache(stat, src) >>> 0;
      check('loading the cache reports success', hr === 0, `hr=0x${hr.toString(16)}`);
      check('the static object has a render slot for OleDraw',
        wat.test_ole_static_render_dib(stat) !== 0);
      // 32 x 24 pixels at 96 dpi = 846 x 635 HIMETRIC.
      check('the extent comes from the bitmap header',
        wat.test_ole_static_extent(stat, 0) === 846 && wat.test_ole_static_extent(stat, 1) === 635,
        `cx=${wat.test_ole_static_extent(stat, 0)} cy=${wat.test_ole_static_extent(stat, 1)}`);
    }
  }

  // RTF as well: the same wrapper is what WordPad's Paste Special sees, and it
  // is a registered format rather than a predefined one.
  wat.clipboard_clear_all_data();
  const nameG = alloc(Array.from('Rich Text Format').map(c => c.charCodeAt(0)).concat([0]));
  wat.clipboard_register_format_a(nameG);
  const rtf = Array.from('{\\rtf1 hi}').map(c => c.charCodeAt(0));
  const rtfG = alloc(rtf.concat([0]));
  wat.clipboard_store_rtf_data(rtfG);
  const rtfObj = wat.test_ole_clipboard_wrap_win32() >>> 0;
  check('an RTF-only clipboard also wraps', rtfObj !== 0);

  let failed = 0;
  for (const c of cases) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else { failed++; console.log(`FAIL  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); }
  }
  console.log('');
  console.log(`${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
