#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new WebAssembly.Memory({ initial: 2 });
const base = createHostImports({
  getMemory: () => memory.buffer,
  renderer: null,
  resourceJson: {},
});
const dv = new DataView(memory.buffer);
const dc = 0x200;
const face = 0x100;
for (const [i, ch] of Array.from('Times New Roman').entries()) {
  dv.setUint8(face + i, ch.charCodeAt(0));
}
dv.setUint8(face + 'Times New Roman'.length, 0);

// WordPad Print Preview establishes MM_ANISOTROPIC at 1058/16384, then
// scales the logical window by screen/printer DPI (96/300). The resulting
// device scale is about 0.202, so a 13px logical font becomes a 3px glyph.
dv.setInt32(dc + 36, 8, true);       // MM_ANISOTROPIC
dv.setInt32(dc + 48, 5242, true);    // 16384 * 96 / 300
dv.setInt32(dc + 52, 5242, true);
dv.setInt32(dc + 64, 1058, true);
dv.setInt32(dc + 68, 1058, true);
dv.setUint32(dc + 88, 0x410001, true);

const token = 0x1234;
assert.strictEqual(base.host.gdi_text_bind(
  token, dc, 0, 0, 0, 0, 0, -13, 400, 0, face), 1);
const mappedMetrics = base.host.get_text_metrics(token) >>> 0;
assert.strictEqual(mappedMetrics & 0xffff, 3,
  'anisotropic mapping must permit device glyphs below CreateFont\'s 8px input floor');

// Creation-time normalization is unchanged: malformed/tiny logical requests
// still produce a usable minimum-sized font when no mapping shrinks it.
dv.setInt32(dc + 48, 1, true);
dv.setInt32(dc + 52, 1, true);
dv.setInt32(dc + 64, 1, true);
dv.setInt32(dc + 68, 1, true);
dv.setUint32(dc + 88, 0x410002, true);
assert.strictEqual(base.host.gdi_text_bind(
  token, dc, 0, 0, 0, 0, 0, -2, 400, 0, face), 1);
assert.strictEqual(base.host.get_text_metrics(token) & 0xffff, 8,
  'CreateFont input normalization must retain its existing 8px floor');

console.log('PASS  anisotropic text mapping scales logical fonts into device pixels');
