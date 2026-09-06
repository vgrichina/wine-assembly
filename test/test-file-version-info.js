#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

function makeVersionBlob() {
  const blob = Buffer.alloc(92);
  blob.writeUInt16LE(blob.length, 0);
  blob.writeUInt16LE(52, 2);
  blob.writeUInt16LE(0, 4);
  const key = 'VS_VERSION_INFO\0';
  for (let i = 0; i < key.length; i++) blob.writeUInt16LE(key.charCodeAt(i), 6 + i * 2);
  blob.writeUInt32LE(0xFEEF04BD, 0x28);
  blob.writeUInt32LE(0x00010000, 0x2C);
  blob.writeUInt32LE(0x00050006, 0x30);
  blob.writeUInt32LE(0x00070008, 0x34);
  blob.writeUInt32LE(0x0009000A, 0x38);
  blob.writeUInt32LE(0x000B000C, 0x3C);
  return blob;
}

function makeVersionPe(blob) {
  const file = Buffer.alloc(0x400);
  file.writeUInt16LE(0x5A4D, 0);
  file.writeUInt32LE(0x80, 0x3C);
  file.writeUInt32LE(0x00004550, 0x80);
  file.writeUInt16LE(0x014C, 0x84);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(0xE0, 0x94);
  const opt = 0x98;
  file.writeUInt16LE(0x010B, opt);
  file.writeUInt32LE(3, opt + 92);
  file.writeUInt32LE(0x1000, opt + 112);
  file.writeUInt32LE(0x200, opt + 116);
  const section = 0x178;
  file.write('.rsrc\0\0\0', section, 'ascii');
  file.writeUInt32LE(0x200, section + 8);
  file.writeUInt32LE(0x1000, section + 12);
  file.writeUInt32LE(0x200, section + 16);
  file.writeUInt32LE(0x200, section + 20);
  const root = 0x200;
  file.writeUInt16LE(1, root + 14);
  file.writeUInt32LE(16, root + 16);
  file.writeUInt32LE(0x80000018, root + 20);
  file.writeUInt16LE(1, root + 0x18 + 14);
  file.writeUInt32LE(1, root + 0x18 + 16);
  file.writeUInt32LE(0x80000030, root + 0x18 + 20);
  file.writeUInt16LE(1, root + 0x30 + 14);
  file.writeUInt32LE(0x0409, root + 0x30 + 16);
  file.writeUInt32LE(0x48, root + 0x30 + 20);
  file.writeUInt32LE(0x1100, root + 0x48);
  file.writeUInt32LE(blob.length, root + 0x4C);
  blob.copy(file, 0x300);
  return file;
}

async function main() {
  const blob = makeVersionBlob();
  const pe = makeVersionPe(blob);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.terminate_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;
  ctx.vfs.files.set('c:\\windows\\temp\\version.dll', {
    data: new Uint8Array(pe), attrs: 0x20,
  });
  const bad = Buffer.from(pe);
  bad.writeUInt32LE(0x7FFFFFF0, 0x200 + 0x48);
  ctx.vfs.files.set('c:\\windows\\temp\\bad.dll', {
    data: new Uint8Array(bad), attrs: 0x20,
  });

  const { instance } = await WebAssembly.instantiate(compileSrcWasm(), imports);
  const e = instance.exports;
  ctx.exports = e;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();

  function writeAscii(value) {
    const gp = e.guest_alloc(value.length + 1);
    for (let i = 0; i < value.length; i++) u8[wa(gp) + i] = value.charCodeAt(i);
    u8[wa(gp) + value.length] = 0;
    return gp;
  }

  function writeWide(value) {
    const gp = e.guest_alloc((value.length + 1) * 2);
    for (let i = 0; i < value.length; i++) dv.setUint16(wa(gp) + i * 2, value.charCodeAt(i), true);
    dv.setUint16(wa(gp) + value.length * 2, 0, true);
    return gp;
  }

  const ansiPath = writeAscii('C:\\Windows\\Temp\\Version.dll');
  const widePath = writeWide('C:\\Windows\\Temp\\Version.dll');
  const handleOut = e.guest_alloc(4);
  dv.setUint32(wa(handleOut), 0xDEADBEEF, true);
  assert.strictEqual(e.test_call_GetFileVersionInfoSizeA(ansiPath, handleOut), blob.length);
  assert.strictEqual(dv.getUint32(wa(handleOut), true), 0);
  assert.strictEqual(e.test_call_GetFileVersionInfoSizeW(widePath, 0), blob.length);

  const full = e.guest_alloc(blob.length);
  assert.strictEqual(e.test_call_GetFileVersionInfoA(ansiPath, 0, blob.length, full), 1);
  assert.deepStrictEqual(Buffer.from(u8.subarray(wa(full), wa(full) + blob.length)), blob);

  const shortLen = blob.length - 7;
  const short = e.guest_alloc(blob.length + 4);
  u8.fill(0xA5, wa(short), wa(short) + blob.length + 4);
  assert.strictEqual(e.test_call_GetFileVersionInfoW(widePath, 0, shortLen, short), 1);
  assert.deepStrictEqual(Buffer.from(u8.subarray(wa(short), wa(short) + shortLen)), blob.subarray(0, shortLen));
  assert.deepStrictEqual(Array.from(u8.subarray(wa(short) + shortLen, wa(short) + blob.length + 4)),
    new Array(11).fill(0xA5));

  assert.strictEqual(e.test_call_GetFileVersionInfoSizeA(writeAscii('C:\\missing.dll'), 0), 0);
  assert.strictEqual(e.test_call_GetFileVersionInfoSizeA(writeAscii('C:\\Windows\\Temp\\bad.dll'), 0), 0);
  console.log('PASS file-backed GetFileVersionInfo A/W resource lookup');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
