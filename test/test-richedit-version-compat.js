#!/usr/bin/env node
// Bounded RichEdit 1.0/2.0 class and message compatibility regression.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const ES_MULTILINE = 0x0004;
const EM_GETSEL = 0x00B0;
const EM_SETSEL = 0x00B1;
const EM_LIMITTEXT = 0x00C5;
const EM_GETLIMITTEXT = 0x00D5;
const EM_EXGETSEL = 0x0434;
const EM_EXLIMITTEXT = 0x0435;
const EM_EXSETSEL = 0x0437;

async function main() {
  const wasm = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
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

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  ctx.exports = instance.exports;
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => g - e.get_image_base() + e.get_guest_base();

  function allocAscii(text) {
    const g = e.guest_alloc(text.length + 1);
    const w = wa(g);
    for (let i = 0; i < text.length; i++) u8[w + i] = text.charCodeAt(i);
    u8[w + text.length] = 0;
    return g;
  }

  let passed = 0;
  let failed = 0;
  function check(name, ok, detail = '') {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? 'PASS  ' : 'FAIL  '}${name}${detail ? `  (${detail})` : ''}`);
  }

  check('RICHEDIT identifies the RichEdit 1.0 contract',
    e.test_richedit_class_version(allocAscii('RICHEDIT')) === 1);
  check('RichEdit20A identifies the RichEdit 2.0 contract',
    e.test_richedit_class_version(allocAscii('RichEdit20A')) === 2);
  check('RichEdit20W identifies the RichEdit 2.0 Unicode class',
    e.test_richedit_class_version(allocAscii('RichEdit20W')) === 2);
  check('class matching is case-insensitive and rejects plain EDIT',
    e.test_richedit_class_version(allocAscii('richedit20a')) === 2 &&
    e.test_richedit_class_version(allocAscii('EDIT')) === 0);

  const style = WS_CHILD | WS_VISIBLE | ES_MULTILINE;
  const text = allocAscii('alpha beta gamma');
  const v1 = e.test_create_richedit(1, style, text);
  const v2 = e.test_create_richedit(2, style, text);

  check('both RichEdit generations start with the Win9x 32K input limit',
    e.send_message(v1, EM_GETLIMITTEXT, 0, 0) === 32767 &&
    e.send_message(v2, EM_GETLIMITTEXT, 0, 0) === 32767);

  e.send_message(v1, EM_SETSEL, 2, 8);
  const packed = e.send_message(v1, EM_GETSEL, 0, 0) >>> 0;
  check('RichEdit 1.0 retains shared EM_SETSEL/EM_GETSEL behavior',
    packed === ((8 << 16) | 2), `packed=0x${packed.toString(16)}`);

  const range = e.guest_alloc(8);
  e.guest_write32(range, 3);
  e.guest_write32(range + 4, 11);
  const setResult = e.send_message(v2, EM_EXSETSEL, 0, range);
  e.guest_write32(range, 0);
  e.guest_write32(range + 4, 0);
  e.send_message(v2, EM_EXGETSEL, 0, range);
  check('RichEdit 2.0 extended selection uses full-width CHARRANGE fields',
    setResult === 11 && e.guest_read32(range) === 3 && e.guest_read32(range + 4) === 11,
    `set=${setResult} range=${e.guest_read32(range)},${e.guest_read32(range + 4)}`);

  e.guest_write32(range, 1);
  e.guest_write32(range + 4, 4);
  const v1Extended = e.send_message(v1, EM_EXSETSEL, 0, range);
  const v1PackedAfter = e.send_message(v1, EM_GETSEL, 0, 0) >>> 0;
  check('RichEdit 1.0 leaves RichEdit 2.0 extended selection unsupported',
    v1Extended === 0 && v1PackedAfter === packed);

  e.send_message(v2, EM_EXLIMITTEXT, 0, 100000);
  check('RichEdit 2.0 EM_EXLIMITTEXT accepts limits above 64K',
    e.send_message(v2, EM_GETLIMITTEXT, 0, 0) === 100000);
  e.send_message(v2, EM_EXLIMITTEXT, 0, 0);
  check('RichEdit 2.0 zero extended limit resolves to the 64K default',
    e.send_message(v2, EM_GETLIMITTEXT, 0, 0) === 64000);
  e.send_message(v1, EM_LIMITTEXT, 0, 0);
  check('RichEdit 1.0 zero legacy limit resolves to the 64K default',
    e.send_message(v1, EM_GETLIMITTEXT, 0, 0) === 64000);

  console.log(`${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
