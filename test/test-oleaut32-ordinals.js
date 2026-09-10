#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { bootRenderHarness } = require('./render-helper');

const memory = new WebAssembly.Memory({ initial: 1 });
const dllNameWA = 0x100;
new Uint8Array(memory.buffer).set(Buffer.from('OLEAUT32.dll\0', 'ascii'), dllNameWA);

const apiTable = [
  { id: 970, name: 'LoadTypeLib' },
  { id: 3315, name: 'SysAllocStringByteLen' },
  { id: 3316, name: 'SysStringByteLen' },
];
const { host } = createHostImports({
  getMemory: () => memory.buffer,
  renderer: null,
  resourceJson: {},
  apiTable,
});

const extraWat = String.raw`
  (func (export "test_system_ordinal") (param $dll i32) (param $ordinal i32) (result i32)
    (call $system_ordinal_api_id (local.get $dll) (local.get $ordinal)))
`;

(async () => {
  assert.strictEqual(host.resolve_ordinal(dllNameWA, 149), 3316,
    'host OLEAUT32 ordinal 149 resolves SysStringByteLen');
  assert.strictEqual(host.resolve_ordinal(dllNameWA, 150), 3315,
    'host OLEAUT32 ordinal 150 resolves SysAllocStringByteLen');
  assert.notStrictEqual(host.resolve_ordinal(dllNameWA, 150), 970,
    'host OLEAUT32 ordinal 150 must not masquerade as LoadTypeLib');
  assert.strictEqual(host.resolve_ordinal(dllNameWA, 151), -1,
    'unknown neighboring host OLEAUT32 ordinals remain fail-fast diagnostics');

  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const dllNameGA = 0x00403000;
  Buffer.from('OLEAUT32.dll\0', 'ascii').forEach((value, i) =>
    wat.guest_write8(dllNameGA + i, value));
  assert.strictEqual(wat.test_system_ordinal(dllNameGA, 149), 3316,
    'guest DLL resolver maps ordinal 149 to SysStringByteLen');
  assert.strictEqual(wat.test_system_ordinal(dllNameGA, 150), 3315,
    'guest DLL resolver maps ordinal 150 to SysAllocStringByteLen');
  assert.strictEqual(wat.test_system_ordinal(dllNameGA, 151), -1,
    'guest DLL resolver leaves unknown neighboring ordinals to the host fallback');

  console.log('PASS  OLEAUT32 byte-length BSTR ordinals do not resolve as LoadTypeLib');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
