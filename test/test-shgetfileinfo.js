#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_make_api_thunk") (param $api_id i32) (result i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $THUNK_BASE)
      (i32.mul (global.get $num_thunks) (i32.const 8))))
    (i32.store (local.get $addr) (i32.const 0))
    (i32.store offset=4 (local.get $addr) (local.get $api_id))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    (call $update_thunk_end)
    (i32.add (i32.sub (local.get $addr) (global.get $GUEST_BASE))
             (global.get $image_base)))
`;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

async function main() {
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
    fs_get_file_attributes: (pathWA, wide) => {
      const view = new DataView(memory.buffer);
      let value = '';
      for (let p = pathWA >>> 0; ; p += wide ? 2 : 1) {
        const ch = wide ? view.getUint16(p, true) : view.getUint8(p);
        if (!ch) break;
        value += String.fromCharCode(ch);
      }
      if (value.includes('MISSING')) return -1;
      return value.endsWith('ARCHIVE') ? 0x10 : 0x20;
    },
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const writeAscii = value => {
    const out = alloc(value.length + 1);
    bytes.set(Buffer.from(`${value}\0`, 'latin1'), wa(out));
    return out;
  };
  const writeWide = value => {
    const out = alloc((value.length + 1) * 2);
    for (let i = 0; i < value.length; i++) dv.setUint16(wa(out) + i * 2, value.charCodeAt(i), true);
    dv.setUint16(wa(out) + value.length * 2, 0, true);
    return out;
  };
  const readAscii = guest => {
    let out = '';
    for (let p = wa(guest); bytes[p]; p++) out += String.fromCharCode(bytes[p]);
    return out;
  };
  const readWide = guest => {
    let out = '';
    for (let p = wa(guest); dv.getUint16(p, true); p += 2) out += String.fromCharCode(dv.getUint16(p, true));
    return out;
  };
  const makeCaller = name => {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} is registered`);
    const thunk = e.test_make_api_thunk(api.id) >>> 0;
    return args => {
      assert.strictEqual(args.length, api.nargs, `${name} argument count`);
      const code = [];
      for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg >>> 0));
      code.push(0xb8, ...u32(thunk), 0xff, 0xd0, 0xc2, 0x10, 0x00);
      const wrapper = alloc(code.length);
      bytes.set(code, wa(wrapper));
      e.call_func(wrapper, 0, 0, 0, 0);
      for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
      assert.strictEqual(e.get_eip(), 0, `${name} wrapper terminates`);
      return e.get_eax() >>> 0;
    };
  };

  const getA = makeCaller('SHGetFileInfoA');
  const getW = makeCaller('SHGetFileInfoW');
  const destroy = makeCaller('ImageList_Destroy');
  const SHGFI_SMALLICON = 0x0001;
  const SHGFI_OPENICON = 0x0002;
  const SHGFI_PIDL = 0x0008;
  const SHGFI_USEFILEATTRIBUTES = 0x0010;
  const SHGFI_DISPLAYNAME = 0x0200;
  const SHGFI_TYPENAME = 0x0400;
  const SHGFI_ATTRIBUTES = 0x0800;
  const SHGFI_SYSICONINDEX = 0x4000;
  const SHGFI_ATTR_SPECIFIED = 0x20000;
  const FILE_ATTRIBUTE_DIRECTORY = 0x10;
  const FILE_ATTRIBUTE_ARCHIVE = 0x20;
  const SFGAO_FOLDER = 1 << 29;
  const SFGAO_FILESYSTEM = 1 << 30;
  const SFGAO_FILE_CAPABILITIES = 0x177;
  const richFlags = SHGFI_SMALLICON | SHGFI_DISPLAYNAME |
    SHGFI_TYPENAME | SHGFI_ATTRIBUTES | SHGFI_SYSICONINDEX;

  const exeInfo = alloc(352);
  const smallList = getA([writeAscii('C:\\TOOLS\\APP.EXE'), FILE_ATTRIBUTE_ARCHIVE, exeInfo, 352, richFlags]);
  assert(smallList, 'SHGFI_SYSICONINDEX returns a real small image list');
  assert.strictEqual(e.guest_read32(exeInfo + 4) >>> 0, 3, 'EXE gets the application image index');
  assert.strictEqual(e.guest_read32(exeInfo + 8) >>> 0,
    (SFGAO_FILESYSTEM | SFGAO_FILE_CAPABILITIES) >>> 0,
    'SHGFI_ATTRIBUTES writes SFGAO flags rather than FILE_ATTRIBUTE flags');
  assert.strictEqual(readAscii(exeInfo + 12), 'APP.EXE', 'ANSI display name is the final path component');
  assert.strictEqual(readAscii(exeInfo + 272), 'Application', 'ANSI type name describes executables');
  assert.strictEqual(e.guest_read32(smallList) >>> 0, 16, 'small system list uses 16px cells');
  assert.strictEqual(e.guest_read32(smallList + 4) >>> 0, 16, 'small system list height is 16px');
  assert.strictEqual(e.guest_read32(smallList + 12) >>> 0, 5, 'system list exposes all shell classes');
  assert.strictEqual(e.guest_read32(smallList + 32) >>> 0, 0x4c4d4948, 'system list is a valid HIML wrapper');

  const bitmap = e.guest_read32(smallList + 16) >>> 0;
  assert(bitmap, 'system image list owns a bitmap strip');
  assert.strictEqual(e.test_gdi_object_width(bitmap) >>> 0, 80, 'small strip is five icons wide');
  assert.strictEqual(e.test_gdi_object_height(bitmap) >>> 0, 16, 'small strip has one icon row');
  const pixels = e.test_gdi_bitmap_storage(bitmap) >>> 0;
  assert(pixels, 'small strip has canonical WAT pixels');
  for (let icon = 0; icon < 5; icon++) {
    let opaque = 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if ((dv.getUint32(pixels + (y * 80 + icon * 16 + x) * 4, true) & 0xffffff) !== 0xff00ff) opaque++;
      }
    }
    assert(opaque >= 20, `system icon ${icon} has visible pixels`);
  }

  const fileInfo = alloc(352);
  assert.strictEqual(getA([writeAscii('C:\\README.TXT'), FILE_ATTRIBUTE_ARCHIVE,
    fileInfo, 352, richFlags]), smallList, 'small image-list identity is stable');
  assert.strictEqual(e.guest_read32(fileInfo + 4) >>> 0, 2, 'ordinary file gets the document index');
  assert.strictEqual(readAscii(fileInfo + 272), 'File', 'ordinary file type is File');

  const dirInfo = alloc(352);
  getA([writeAscii('C:\\ARCHIVE'), FILE_ATTRIBUTE_DIRECTORY, dirInfo, 352, richFlags]);
  assert.strictEqual(e.guest_read32(dirInfo + 4) >>> 0, 1, 'directory gets the closed-folder index');
  getA([writeAscii('C:\\ARCHIVE'), FILE_ATTRIBUTE_DIRECTORY, dirInfo, 352, richFlags | SHGFI_OPENICON]);
  assert.strictEqual(e.guest_read32(dirInfo + 4) >>> 0, 0, 'SHGFI_OPENICON gets the open-folder index');
  assert.strictEqual(readAscii(dirInfo + 272), 'File Folder', 'directory type is File Folder');
  e.guest_write32(dirInfo + 8, SFGAO_FOLDER | SFGAO_FILESYSTEM);
  getA([writeAscii('C:\\ARCHIVE'), 0, dirInfo, 352, richFlags | SHGFI_ATTR_SPECIFIED]);
  assert.strictEqual(e.guest_read32(dirInfo + 8) >>> 0, SFGAO_FOLDER | SFGAO_FILESYSTEM,
    'SHGFI_ATTR_SPECIFIED masks the returned SFGAO attributes');

  const largeInfo = alloc(352);
  const largeList = getA([writeAscii('C:\\README.TXT'), FILE_ATTRIBUTE_ARCHIVE,
    largeInfo, 352, SHGFI_USEFILEATTRIBUTES | SHGFI_SYSICONINDEX]);
  assert(largeList && largeList !== smallList, 'large and small system lists are distinct');
  assert.strictEqual(e.guest_read32(largeList) >>> 0, 32, 'large system list uses 32px cells');
  assert.strictEqual(destroy([smallList]), 0, 'shared system image lists cannot be destroyed');
  assert.strictEqual(getA([writeAscii('C:\\README.TXT'), FILE_ATTRIBUTE_ARCHIVE,
    fileInfo, 352, richFlags]), smallList, 'refused destruction preserves system-list identity');

  const wideInfo = alloc(692);
  assert.strictEqual(getW([writeWide('C:\\MEDIA\\PINBALL.MID'), FILE_ATTRIBUTE_ARCHIVE,
    wideInfo, 692, SHGFI_USEFILEATTRIBUTES | SHGFI_DISPLAYNAME | SHGFI_TYPENAME]), 1,
  'non-image-list Unicode query succeeds');
  assert.strictEqual(readWide(wideInfo + 12), 'PINBALL.MID', 'Unicode display name uses WCHAR layout');
  assert.strictEqual(readWide(wideInfo + 532), 'File', 'Unicode type name uses WCHAR layout');

  const pidl = alloc(12);
  const pidlWA = wa(pidl);
  dv.setUint16(pidlWA, 10, true);
  dv.setUint32(pidlWA + 2, 0x50564157, true); // WAVP
  dv.setUint32(pidlWA + 6, 0x11, true);       // CSIDL_DRIVES
  dv.setUint16(pidlWA + 10, 0, true);
  const pidlInfo = alloc(352);
  assert.strictEqual(getA([pidl, 0, pidlInfo, 352,
    SHGFI_PIDL | SHGFI_SMALLICON | SHGFI_DISPLAYNAME | SHGFI_SYSICONINDEX]), smallList,
  'PIDL query returns the same process small image list');
  assert.strictEqual(e.guest_read32(pidlInfo + 4) >>> 0, 4, 'CSIDL_DRIVES PIDL gets the drive index');
  assert.strictEqual(readAscii(pidlInfo + 12), 'My Computer', 'PIDL display name is decoded without treating it as a path');

  const filePidlPath = 'C:\\TOOLS\\APP.EXE';
  const filePidl = alloc(filePidlPath.length + 9);
  const filePidlWA = wa(filePidl);
  dv.setUint16(filePidlWA, filePidlPath.length + 7, true);
  dv.setUint32(filePidlWA + 2, 0x50464157, true); // WAFP
  bytes.set(Buffer.from(`${filePidlPath}\0`, 'latin1'), filePidlWA + 6);
  dv.setUint16(filePidlWA + filePidlPath.length + 7, 0, true);
  const widePidlInfo = alloc(692);
  assert(getW([filePidl, 0, widePidlInfo, 692,
    SHGFI_PIDL | SHGFI_DISPLAYNAME | SHGFI_TYPENAME]),
  'Unicode entry point accepts the encoding-neutral filesystem PIDL');
  assert.strictEqual(readWide(widePidlInfo + 12), 'APP.EXE',
    'W call widens the WAFP provider payload instead of reading it as UTF-16');
  assert.strictEqual(readWide(widePidlInfo + 532), 'Application',
    'W call classifies the ANSI provider payload before writing WCHAR type text');

  const shortInfo = alloc(32);
  bytes.fill(0xcd, wa(shortInfo), wa(shortInfo) + 32);
  assert.strictEqual(getA([writeAscii('C:\\LONGNAME.TXT'), FILE_ATTRIBUTE_ARCHIVE,
    shortInfo, 14, SHGFI_USEFILEATTRIBUTES | SHGFI_DISPLAYNAME]), 1,
  'short cbFileInfo remains a valid bounded query');
  assert.strictEqual(bytes[wa(shortInfo) + 12], 'L'.charCodeAt(0), 'one display-name byte fits');
  assert.strictEqual(bytes[wa(shortInfo) + 13], 0, 'short display-name field is terminated');
  assert.strictEqual(bytes[wa(shortInfo) + 14], 0xcd, 'SHGetFileInfo does not overrun cbFileInfo');

  assert.strictEqual(getA([writeAscii('C:\\MISSING.TXT'), 0, fileInfo, 352, SHGFI_DISPLAYNAME]), 0,
    'a missing path without SHGFI_USEFILEATTRIBUTES fails');
  assert.strictEqual(getA([writeAscii('C:\\README.TXT'), FILE_ATTRIBUTE_ARCHIVE, 0, 0, richFlags]), 0,
    'null SHFILEINFO fails safely');

  console.log('PASS SHGetFileInfo Win98 fields, PIDLs, stable system image lists, and bounded writes');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
