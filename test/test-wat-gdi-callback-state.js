#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const base = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;

  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  const ca = wat.guest_alloc(24) >>> 0;
  const out = wat.guest_alloc(24) >>> 0;
  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = 0x12000;
  const view = new DataView(memory.buffer);
  const read16 = ga => view.getUint16(guestBase + (ga - imageBase), true);
  assert.strictEqual(wat.test_call_GetColorAdjustment(hdc, out), 1);
  assert.strictEqual(read16(out), 24);
  assert.strictEqual(read16(out + 6), 10000);
  assert.strictEqual(read16(out + 14), 10000);

  wat.guest_write16(ca, 24);
  wat.guest_write16(ca + 2, 1);      // CA_NEGATIVE
  wat.guest_write16(ca + 4, 1);      // ILLUMINANT_DEVICE_DEFAULT
  wat.guest_write16(ca + 6, 12000);
  wat.guest_write16(ca + 8, 11000);
  wat.guest_write16(ca + 10, 10000);
  wat.guest_write16(ca + 12, 1000);
  wat.guest_write16(ca + 14, 9000);
  wat.guest_write16(ca + 16, -25);
  wat.guest_write16(ca + 18, 30);
  wat.guest_write16(ca + 20, 40);
  wat.guest_write16(ca + 22, -10);
  assert.strictEqual(wat.test_call_SetColorAdjustment(hdc, ca), 1);
  assert.strictEqual(wat.test_call_GetColorAdjustment(hdc, out), 1);
  for (let i = 0; i < 24; i += 2) {
    assert.strictEqual(read16(out + i), read16(ca + i),
      `COLORADJUSTMENT word ${i / 2} must round-trip`);
  }
  wat.guest_write16(ca + 16, 101);
  assert.strictEqual(wat.test_call_SetColorAdjustment(hdc, ca), 0,
    'out-of-range contrast must fail without changing state');
  assert.strictEqual(wat.test_call_GetColorAdjustment(hdc, out), 1);
  assert.strictEqual(read16(out + 16), (-25) & 0xffff);
  assert.strictEqual(wat.test_call_SetColorAdjustment(hdc, 0), 0);
  assert.strictEqual(wat.test_call_GetColorAdjustment(hdc, 0), 0);
  assert.strictEqual(wat.test_call_DeleteDC(hdc), 1);

  const apiTable = JSON.parse(fs.readFileSync(path.join(root, 'src', 'api_table.json'), 'utf8'));
  assert.strictEqual(apiTable.find(api => api.name === 'LineDDA').nargs, 6,
    'LineDDA thunk metadata must include LPARAM');
  assert(apiTable.some(api => api.name === 'GetColorAdjustment' && api.nargs === 2));

  // Loading any PE initializes the standard continuation-thunk block. The
  // callback itself is tiny guest x86 code that records (x,y) pairs through
  // LPARAM and returns with the required stdcall `ret 12`.
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length));
  const callback = wat.guest_alloc(64) >>> 0;
  const points = wat.guest_alloc(4 + 8 * 16) >>> 0;
  const callbackWa = 0x12000 + (callback - (wat.get_image_base() >>> 0));
  const callbackCode = [
    0x8b, 0x44, 0x24, 0x0c,       // mov eax,[esp+12] (LPARAM)
    0x8b, 0x08,                   // mov ecx,[eax] (count)
    0x8b, 0x54, 0x24, 0x04,       // mov edx,[esp+4] (x)
    0x89, 0x54, 0xc8, 0x04,       // mov [eax+ecx*8+4],edx
    0x8b, 0x54, 0x24, 0x08,       // mov edx,[esp+8] (y)
    0x89, 0x54, 0xc8, 0x08,       // mov [eax+ecx*8+8],edx
    0xff, 0x00,                   // inc dword [eax]
    0xc2, 0x0c, 0x00,             // ret 12
  ];
  new Uint8Array(memory.buffer).set(callbackCode, callbackWa);
  wat.guest_write32(points, 0);
  assert(wat.test_start_LineDDA(1, 2, 6, 5, callback, points));
  for (let i = 0; i < 100 && wat.get_eip(); i++) wat.run(1000);
  assert.strictEqual(wat.get_eip(), 0, 'LineDDA callback continuation must terminate');
  assert.strictEqual(wat.guest_read32(points), 5, 'endpoint is excluded');
  assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => [
    wat.guest_read32(points + 4 + i * 8),
    wat.guest_read32(points + 8 + i * 8),
  ]), [[1, 2], [2, 3], [3, 3], [4, 4], [5, 4]]);

  console.log('PASS  LineDDA executes guest callbacks and per-DC color adjustment is canonical');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
