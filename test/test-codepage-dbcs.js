#!/usr/bin/env node
// Codepage / DBCS lead-byte regression tests for MBCS string navigation.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const wa = gp => gp - e.get_image_base() + 0x12000;

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

  const s = e.guest_alloc(8);
  u8.set([0x81, 0x40, 0x41, 0], wa(s));

  check('default ANSI codepage is CP1252', e.get_ansi_code_page() === 1252);
  check('CP1252 has no DBCS lead byte at 0x81', e.test_is_dbcs_lead_byte(0x81) === 0);
  check('CP1252 _mbsinc advances one byte', e.test_mbsinc(s) === s + 1);

  e.set_ansi_code_page(932);
  check('set ANSI codepage to CP932', e.get_ansi_code_page() === 932);
  check('CP932 lead byte 0x81 recognized', e.test_is_dbcs_lead_byte(0x81) === 1);
  check('CP932 non-lead byte 0xA0 rejected', e.test_is_dbcs_lead_byte(0xA0) === 0);
  check('CP932 _mbsinc skips lead+trail pair', e.test_mbsinc(s) === s + 2);
  check('CP932 _mbsinc advances one byte on ASCII', e.test_mbsinc(s + 2) === s + 3);

  u8.set([0x81, 0x00], wa(s));
  check('CP932 _mbsinc does not skip over terminator', e.test_mbsinc(s) === s + 1);

  e.set_ansi_code_page(936);
  check('set ANSI codepage to CP936', e.get_ansi_code_page() === 936);
  check('CP936 lead byte 0xFE recognized', e.test_is_dbcs_lead_byte(0xFE) === 1);

  e.set_ansi_code_page(99999);
  check('unsupported codepage is ignored', e.get_ansi_code_page() === 936);

  console.log(`--- codepage-dbcs: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
