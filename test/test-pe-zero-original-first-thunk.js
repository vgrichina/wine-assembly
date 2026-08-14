#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');

function makePeWithFirstThunkLookup() {
  const bytes = Buffer.alloc(0x600);
  const pe = 0x80;
  const opt = pe + 24;
  const section = opt + 0xE0;

  bytes.writeUInt16LE(0x5A4D, 0);
  bytes.writeUInt32LE(pe, 0x3C);
  bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x014C, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(0xE0, pe + 20);
  bytes.writeUInt16LE(0x010F, pe + 22);

  bytes.writeUInt16LE(0x010B, opt);
  bytes.writeUInt32LE(0x400, opt + 4);
  bytes.writeUInt32LE(0x1000, opt + 16);
  bytes.writeUInt32LE(0x1000, opt + 20);
  bytes.writeUInt32LE(0x400000, opt + 28);
  bytes.writeUInt32LE(0x1000, opt + 32);
  bytes.writeUInt32LE(0x200, opt + 36);
  bytes.writeUInt32LE(0x2000, opt + 56);
  bytes.writeUInt32LE(0x200, opt + 60);
  bytes.writeUInt32LE(16, opt + 92);
  bytes.writeUInt32LE(0x1100, opt + 104); // import directory RVA
  bytes.writeUInt32LE(40, opt + 108);

  bytes.write('.text\0\0\0', section, 'ascii');
  bytes.writeUInt32LE(0x400, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x400, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x60000020, section + 36);

  // push 0; call dword [0x401140]; ret
  Buffer.from([0x6A, 0x00, 0xFF, 0x15, 0x40, 0x11, 0x40, 0x00, 0xC3])
    .copy(bytes, 0x200);
  bytes.writeUInt32LE(0, 0x300);       // OriginalFirstThunk intentionally absent
  bytes.writeUInt32LE(0x1180, 0x30C);  // DLL name RVA
  bytes.writeUInt32LE(0x1140, 0x310);  // FirstThunk doubles as lookup table
  bytes.writeUInt32LE(0x1190, 0x340);  // IMAGE_IMPORT_BY_NAME RVA
  bytes.write('kernel32.dll\0', 0x380, 'ascii');
  bytes.writeUInt16LE(0, 0x390);
  bytes.write('GetModuleHandleA\0', 0x392, 'ascii');
  return bytes;
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const memory = harness.memory;
  const pe = makePeWithFirstThunkLookup();
  new Uint8Array(memory.buffer).set(pe, wat.get_staging());
  assert.strictEqual(wat.load_pe(pe.length) >>> 0, 0x401000);

  const view = new DataView(memory.buffer);
  const iatWa = 0x12000 + 0x1140;
  const thunkGuest = wat.get_thunk_base() >>> 0;
  assert.strictEqual(view.getUint32(iatWa, true), thunkGuest,
    'FirstThunk lookup entry must be replaced with a host API thunk');

  const apiTable = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'api_table.json'), 'utf8'));
  const api = apiTable.find(entry => entry.name === 'GetModuleHandleA');
  assert(api);
  assert.strictEqual(view.getUint32(0x07112000, true), 0x1190,
    'thunk metadata should retain the IMAGE_IMPORT_BY_NAME RVA');
  assert.strictEqual(view.getUint32(0x07112004, true), api.id,
    'FirstThunk fallback should resolve the normal API ID');

  wat.call_func(0x401000, 0, 0, 0, 0);
  for (let i = 0; i < 20 && wat.get_eip(); i++) wat.run(1000);
  assert.strictEqual(wat.get_eip(), 0, 'imported API call should return to the harness');
  assert.strictEqual(wat.get_eax() >>> 0, 0x400000,
    'GetModuleHandleA(NULL) should execute through the repaired IAT');

  console.log('PASS  PE imports fall back to FirstThunk when OriginalFirstThunk is zero');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
