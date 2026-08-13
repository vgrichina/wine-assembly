#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, create_event: () => 0,
    set_event: () => 0, reset_event: () => 0, wait_single: () => 0,
    wait_multiple: () => 0, com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  e.init_dx_com_thunks();
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const alloc = n => e.guest_alloc(n) >>> 0;
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  // FORMATETC: cfFormat=CF_DIB, dwAspect=DVASPECT_CONTENT, lindex=-1,
  // tymed=TYMED_HGLOBAL. STGMEDIUM contains an owned binary HGLOBAL copy.
  const format = alloc(20);
  dv.setUint16(wa(format), 8, true);
  dv.setUint32(wa(format) + 8, 1, true);
  dv.setInt32(wa(format) + 12, -1, true);
  dv.setUint32(wa(format) + 16, 1, true);
  const dib = alloc(48);
  for (let i = 0; i < 48; i++) u8[wa(dib) + i] = (i * 17 + 3) & 0xff;
  const medium = alloc(12);
  dv.setUint32(wa(medium), 1, true);
  dv.setUint32(wa(medium) + 4, dib, true);

  const object = e.test_ole_create_data_object(format, medium) >>> 0;
  check('creates an IDataObject with copied CF_DIB HGLOBAL data', object !== 0);
  u8[wa(dib)] = 0xee;

  check('QueryGetData accepts matching CF_DIB/TYMED_HGLOBAL', e.test_ole_data_query(object, format) === 0);
  const wrong = alloc(20);
  u8.set(u8.slice(wa(format), wa(format) + 20), wa(wrong));
  dv.setUint16(wa(wrong), 1, true);
  check('QueryGetData rejects a mismatched clipboard format', (e.test_ole_data_query(object, wrong) >>> 0) === 0x80040064);

  const out = alloc(12);
  const getHr = e.test_ole_data_get(object, format, out) >>> 0;
  const outHandle = dv.getUint32(wa(out) + 4, true);
  check('GetData returns an independently owned HGLOBAL', getHr === 0 && outHandle !== 0 && outHandle !== dib);
  check('GetData preserves opaque DIB bytes', u8[wa(outHandle)] === 3 && u8[wa(outHandle) + 47] === ((47 * 17 + 3) & 0xff));
  e.test_ole_release_medium(out);
  check('ReleaseStgMedium clears released medium fields',
    dv.getUint32(wa(out), true) === 0 && dv.getUint32(wa(out) + 4, true) === 0 && dv.getUint32(wa(out) + 8, true) === 0);

  // GetClipboardData handles are borrowed from USER. RichEdit may place one
  // in an fRelease STGMEDIUM while constructing a static object. Releasing
  // that wrapper must not free the still-current USER clipboard value.
  const clipboardHandle = e.clipboard_store_binary_data(8, dib) >>> 0;
  const borrowed = alloc(12);
  dv.setUint32(wa(borrowed), 1, true);
  dv.setUint32(wa(borrowed) + 4, clipboardHandle, true);
  e.test_ole_release_medium(borrowed);
  check('ReleaseStgMedium preserves a borrowed CF_DIB clipboard handle',
    e.clipboard_get_data_handle(8) === clipboardHandle && u8[wa(clipboardHandle)] === 0xee);
  e.clipboard_clear_all_data();
  const heapBeforeClipboardCycles = e.get_heap_ptr() >>> 0;
  for (let i = 0; i < 128; i++) {
    e.clipboard_store_binary_data(8, dib);
    e.clipboard_clear_all_data();
  }
  const heapAfterClipboardCycles = e.get_heap_ptr() >>> 0;
  check('clearing an unused binary clipboard snapshot releases its backing',
    e.clipboard_get_data_handle(8) === 0 &&
    heapAfterClipboardCycles - heapBeforeClipboardCycles <= 64,
    `heap growth=${heapAfterClipboardCycles - heapBeforeClipboardCycles}`);

  e.test_ole_set_clipboard(object);
  check('Ole clipboard holds a reference after the caller releases', e.test_ole_release(object) === 1);
  const current = e.test_ole_get_clipboard() >>> 0;
  check('OleGetClipboard returns the current IDataObject with AddRef', current === object && e.test_ole_release(current) === 1);
  e.test_ole_set_clipboard(0);

  const stream = e.test_ole_create_stream(0, 0) >>> 0;
  const streamFormat = alloc(20);
  dv.setUint16(wa(streamFormat), 0xc001, true);
  dv.setUint32(wa(streamFormat) + 8, 1, true);
  dv.setInt32(wa(streamFormat) + 12, -1, true);
  dv.setUint32(wa(streamFormat) + 16, 4, true); // TYMED_ISTREAM
  const streamMedium = alloc(12);
  dv.setUint32(wa(streamMedium), 4, true);
  dv.setUint32(wa(streamMedium) + 4, stream, true);
  const streamObject = e.test_ole_create_data_object(streamFormat, streamMedium) >>> 0;
  const streamRefBeforeCallerRelease = dv.getUint32(wa(stream) + 4, true);
  const streamAfterCallerRelease = e.test_ole_release(stream);
  check('TYMED_ISTREAM media AddRefs the stream', streamObject !== 0 && streamAfterCallerRelease === 1,
    `stream=0x${stream.toString(16)} object=0x${streamObject.toString(16)} before=${streamRefBeforeCallerRelease} after=${streamAfterCallerRelease}`);
  check('releasing IDataObject releases its owned stream reference', e.test_ole_release(streamObject) === 0);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
