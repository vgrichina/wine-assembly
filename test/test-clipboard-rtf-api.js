#!/usr/bin/env node
// Low-level regression coverage for non-OLE Rich Text Format clipboard support.
// Tests the shared WAT helpers used by RegisterClipboardFormatA/W,
// SetClipboardData/GetClipboardData, IsClipboardFormatAvailable, and
// CountClipboardFormats.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();

  let pass = 0;
  let fail = 0;
  function check(name, ok, detail = '') {
    if (ok) {
      pass++;
      console.log('PASS  ' + name);
    } else {
      fail++;
      console.log('FAIL  ' + name + (detail ? '  ' + detail : ''));
    }
  }

  function writeAscii(s) {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i) & 0xff;
    u8[p + s.length] = 0;
    return g;
  }

  function writeWide(s) {
    const g = e.guest_alloc((s.length + 1) * 2);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) dv.setUint16(p + i * 2, s.charCodeAt(i), true);
    dv.setUint16(p + s.length * 2, 0, true);
    return g;
  }

  function readAscii(g, max = 1024) {
    const p = wa(g);
    let s = '';
    for (let i = 0; i < max; i++) {
      const ch = u8[p + i];
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  e.clipboard_clear_all_data();

  const rtfNameA = writeAscii('Rich Text Format');
  const rtfNameW = writeWide('Rich Text Format');
  const htmlNameA = writeAscii('HTML Format');
  const fmtA = e.clipboard_register_format_a(rtfNameA) >>> 0;
  const fmtW = e.clipboard_register_format_w(rtfNameW) >>> 0;
  const fmtAgain = e.clipboard_get_rtf_format_id() >>> 0;
  const htmlFmt = e.clipboard_register_format_a(htmlNameA) >>> 0;

  check('RegisterClipboardFormatA returns registered RTF id', fmtA >= 0xc000, `0x${fmtA.toString(16)}`);
  check('RegisterClipboardFormatW returns the same RTF id', fmtW === fmtA, `A=0x${fmtA.toString(16)} W=0x${fmtW.toString(16)}`);
  check('RTF id remains stable after repeated lookup', fmtAgain === fmtA, `again=0x${fmtAgain.toString(16)}`);
  check('other registered formats receive a distinct id', htmlFmt !== fmtA && htmlFmt >= 0xc000, `html=0x${htmlFmt.toString(16)}`);
  check('empty clipboard has no advertised formats', e.clipboard_count_formats() === 0);
  check('empty clipboard has no RTF availability', e.clipboard_is_format_available(fmtA) === 0);

  const rtfText = '{\\rtf1\\ansi api\\par smoke}';
  const rtfData = writeAscii(rtfText);
  const stored = e.clipboard_store_rtf_data(rtfData) >>> 0;
  const handle = e.clipboard_get_data_handle(fmtA) >>> 0;

  check('SetClipboardData-style RTF store succeeds', stored !== 0);
  check('CountClipboardFormats counts the RTF format', e.clipboard_count_formats() === 1);
  check('IsClipboardFormatAvailable reports RTF', e.clipboard_is_format_available(fmtA) === 1);
  check('GetClipboardData returns the stored RTF handle', handle !== 0 && handle === stored,
    `stored=0x${stored.toString(16)} handle=0x${handle.toString(16)}`);
  check('GetClipboardData RTF bytes round-trip', readAscii(handle) === rtfText, readAscii(handle));

  e.clipboard_clear_all_data();
  check('EmptyClipboard clears RTF availability', e.clipboard_is_format_available(fmtA) === 0);
  check('EmptyClipboard clears format count', e.clipboard_count_formats() === 0);

  console.log('');
  console.log(`${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
