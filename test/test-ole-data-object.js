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
  u8.fill(0, wa(format), wa(format) + 20);
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
  // in an fRelease STGMEDIUM while constructing a static object, then retain
  // that presentation after EmptyClipboard. Releasing the wrapper must not
  // free or reuse the clipboard snapshot out from under the document object.
  const clipboardHandle = e.clipboard_store_binary_data(8, dib) >>> 0;
  const borrowed = alloc(12);
  dv.setUint32(wa(borrowed), 1, true);
  dv.setUint32(wa(borrowed) + 4, clipboardHandle, true);
  e.test_ole_release_medium(borrowed);
  check('ReleaseStgMedium preserves a borrowed CF_DIB clipboard handle',
    e.clipboard_get_data_handle(8) === clipboardHandle && u8[wa(clipboardHandle)] === 0xee);
  e.clipboard_clear_all_data();
  check('clearing clipboard metadata preserves a retained RichEdit DIB presentation',
    e.clipboard_get_data_handle(8) === 0 && u8[wa(clipboardHandle)] === 0xee);

  e.test_ole_set_clipboard(object);
  check('Ole clipboard holds a reference after the caller releases', e.test_ole_release(object) === 1);
  const current = e.test_ole_get_clipboard() >>> 0;
  check('OleGetClipboard returns the current IDataObject with AddRef', current === object && e.test_ole_release(current) === 1);
  e.test_ole_set_clipboard(0);

  const stream = e.test_ole_create_stream(0, 0) >>> 0;
  const streamFormat = alloc(20);
  u8.fill(0, wa(streamFormat), wa(streamFormat) + 20);
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

  const makeFormat = (id, tymed = 1) => {
    const value = alloc(20);
    u8.fill(0, wa(value), wa(value) + 20);
    dv.setUint16(wa(value), id, true);
    dv.setUint32(wa(value) + 8, 1, true);
    dv.setInt32(wa(value) + 12, -1, true);
    dv.setUint32(wa(value) + 16, tymed, true);
    return value;
  };
  const makeHglobalMedium = bytes => {
    const handle = alloc(bytes.length);
    u8.set(bytes, wa(handle));
    const value = alloc(12);
    u8.fill(0, wa(value), wa(value) + 12);
    dv.setUint32(wa(value), 1, true);
    dv.setUint32(wa(value) + 4, handle, true);
    return { value, handle };
  };
  const multi = e.test_ole_create_data_object(format, medium) >>> 0;
  const unicodeFormat = makeFormat(13);
  const targetDevice = alloc(8);
  dv.setUint32(wa(targetDevice), 8, true);
  dv.setUint32(wa(targetDevice) + 4, 0x11223344, true);
  dv.setUint32(wa(unicodeFormat) + 4, targetDevice, true);
  const unicode = makeHglobalMedium(Uint8Array.from([72, 0, 105, 0, 0, 0]));
  check('IDataObject SetData appends an independently owned second format',
    e.test_ole_data_set(multi, unicodeFormat, unicode.value, 0) === 0 &&
    e.test_ole_data_count(multi) === 2 && e.test_ole_data_query(multi, unicodeFormat) === 0);
  dv.setUint32(wa(targetDevice) + 4, 0xdeadbeef, true);
  u8[wa(unicode.handle)] = 0xff;
  const unicodeOut = alloc(12);
  check('multi-format GetData returns the selected independent payload',
    e.test_ole_data_get(multi, unicodeFormat, unicodeOut) === 0 &&
    u8[wa(dv.getUint32(wa(unicodeOut) + 4, true))] === 72);
  e.test_ole_release_medium(unicodeOut);

  const replacement = makeHglobalMedium(Uint8Array.from([66, 0, 0, 0]));
  check('SetData replaces a matching format without adding a duplicate',
    e.test_ole_data_set(multi, unicodeFormat, replacement.value, 0) === 0 &&
    e.test_ole_data_count(multi) === 2 &&
    (() => {
      const result = alloc(12);
      const ok = e.test_ole_data_get(multi, unicodeFormat, result) === 0 &&
        u8[wa(dv.getUint32(wa(result) + 4, true))] === 66;
      e.test_ole_release_medium(result);
      return ok;
    })());

  const textFormat = makeFormat(1);
  const text = makeHglobalMedium(Uint8Array.from([65, 0]));
  check('SetData fRelease transfers medium ownership and clears the caller medium',
    e.test_ole_data_set(multi, textFormat, text.value, 1) === 0 &&
    e.test_ole_data_count(multi) === 3 &&
    dv.getUint32(wa(text.value), true) === 0 && dv.getUint32(wa(text.value) + 4, true) === 0);

  const formatEnum = e.test_ole_create_format_enum(multi) >>> 0;
  const extraFormat = makeFormat(0xc123);
  const extra = makeHglobalMedium(Uint8Array.from([1, 2, 3]));
  e.test_ole_data_set(multi, extraFormat, extra.value, 0);
  const formats = alloc(20 * 4);
  const fetched = alloc(4);
  const enumHr = e.test_ole_format_enum_next(formatEnum, 4, formats, fetched) >>> 0;
  const enumerated = [];
  for (let i = 0; i < dv.getUint32(wa(fetched), true); i++) {
    const item = formats + i * 20;
    enumerated.push({ id: dv.getUint16(wa(item), true), ptd: dv.getUint32(wa(item) + 4, true) >>> 0 });
  }
  const enumUnicode = enumerated.find(item => item.id === 13);
  dv.setUint32(wa(targetDevice) + 4, 0xcafebabe, true);
  check('IEnumFORMATETC is a stable multi-format snapshot after object mutation',
    enumHr === 1 && enumerated.length === 3 && !enumerated.some(item => item.id === 0xc123));
  check('IEnumFORMATETC snapshot deep-copies DVTARGETDEVICE data',
    enumUnicode?.ptd && enumUnicode.ptd !== targetDevice &&
    dv.getUint32(wa(enumUnicode.ptd) + 4, true) === 0xdeadbeef);
  for (let i = 0; i < enumerated.length; i++) e.test_ole_format_free(formats + i * 20);

  e.test_ole_format_enum_reset(formatEnum);
  check('IEnumFORMATETC Reset and Skip report exact cursor movement',
    e.test_ole_format_enum_skip(formatEnum, 1) === 0);
  const enumClone = e.test_ole_clone_format_enum(formatEnum) >>> 0;
  const oneFormat = alloc(20);
  const cloneFormat = alloc(20);
  const originalNext = e.test_ole_format_enum_next(formatEnum, 1, oneFormat, 0) >>> 0;
  const cloneNext = e.test_ole_format_enum_next(enumClone, 1, cloneFormat, 0) >>> 0;
  check('IEnumFORMATETC Clone preserves an independent cursor and format ownership',
    enumClone !== 0 && originalNext === 0 && cloneNext === 0 &&
    dv.getUint16(wa(oneFormat), true) === dv.getUint16(wa(cloneFormat), true));
  e.test_ole_format_free(oneFormat);
  e.test_ole_format_free(cloneFormat);
  check('cloned format cursors advance independently',
    e.test_ole_format_enum_skip(formatEnum, 1) === 0 &&
    e.test_ole_format_enum_next(formatEnum, 1, oneFormat, 0) === 1 &&
    e.test_ole_format_enum_next(enumClone, 1, cloneFormat, 0) === 0);
  e.test_ole_format_free(cloneFormat);
  e.test_ole_release(enumClone);
  e.test_ole_release(formatEnum);
  e.test_ole_release(multi);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
