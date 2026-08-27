#!/usr/bin/env node
// RichEdit EM_STREAMIN regression, including the compatibility direct-cookie
// shape and the RTF-to-visible-text projection used by Win9x-era dialogs.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EM_STREAMIN = 0x0449;
const SF_TEXT = 0x0001;
const SF_RTF = 0x0002;

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
  const wa = g => g - e.get_image_base() + e.get_guest_base();

  function allocAscii(text) {
    const g = e.guest_alloc(text.length + 1);
    const w = wa(g);
    for (let i = 0; i < text.length; i++) u8[w + i] = text.charCodeAt(i);
    u8[w + text.length] = 0;
    return g;
  }

  function readText(hwnd) {
    const len = e.get_edit_text_len(hwnd);
    const out = e.guest_alloc(len + 1);
    e.get_edit_text(hwnd, out, len + 1);
    return Buffer.from(u8.subarray(wa(out), wa(out) + len)).toString('latin1');
  }

  function streamDirect(hwnd, flags, text) {
    const source = allocAscii(text);
    const stream = e.guest_alloc(12);
    e.guest_write32(stream, source);
    e.guest_write32(stream + 4, 0);
    e.guest_write32(stream + 8, 0);
    return e.send_message(hwnd, EM_STREAMIN, flags, stream);
  }

  function streamCallback(hwnd, text) {
    const source = allocAscii(text);
    const cookie = e.guest_alloc(12);
    e.guest_write32(cookie, source);
    e.guest_write32(cookie + 4, text.length);
    e.guest_write32(cookie + 8, 0);

    // stdcall EDITSTREAM callback: copy cookie->source once, publish pcb,
    // then report EOF on the second invocation. The interpreter's zero return
    // address is sufficient for this bounded nested call in the unit harness.
    const codeBytes = Buffer.from([
      0x56, 0x57,                         // push esi; push edi
      0x8b, 0x54, 0x24, 0x0c,             // mov edx,[esp+12] (cookie)
      0x83, 0x7a, 0x08, 0x00,             // cmp dword [edx+8],0
      0x75, 0x22,                         // jne eof
      0x8b, 0x32,                         // mov esi,[edx]
      0x8b, 0x4a, 0x04,                   // mov ecx,[edx+4]
      0x8b, 0x7c, 0x24, 0x10,             // mov edi,[esp+16] (buffer)
      0xf3, 0xa4,                         // rep movsb
      0x8b, 0x42, 0x04,                   // mov eax,[edx+4]
      0xc7, 0x42, 0x08, 1, 0, 0, 0,       // mov dword [edx+8],1
      0x8b, 0x54, 0x24, 0x18,             // mov edx,[esp+24] (pcb)
      0x89, 0x02,                         // mov [edx],eax
      0x31, 0xc0, 0x5f, 0x5e,             // xor eax,eax; pop edi; pop esi
      0xc2, 0x10, 0x00,                   // ret 16
      0x8b, 0x54, 0x24, 0x18,             // eof: mov edx,[esp+24]
      0xc7, 0x02, 0, 0, 0, 0,             // mov dword [edx],0
      0x31, 0xc0, 0x5f, 0x5e,             // xor eax,eax; pop edi; pop esi
      0xc2, 0x10, 0x00,                   // ret 16
    ]);
    const callback = e.guest_alloc(codeBytes.length);
    u8.set(codeBytes, wa(callback));
    const stack = e.guest_alloc(8192);
    e.set_esp(stack + 8192 - 16);

    const stream = e.guest_alloc(12);
    e.guest_write32(stream, cookie);
    e.guest_write32(stream + 4, 0);
    e.guest_write32(stream + 8, callback);
    const result = e.send_message(hwnd, EM_STREAMIN, SF_TEXT, stream);
    return { result, error: e.guest_read32(stream + 4), callsCompleted: e.guest_read32(cookie + 8) };
  }

  let passed = 0;
  let failed = 0;
  function check(name, ok, detail = '') {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? 'PASS  ' : 'FAIL  '}${name}${detail ? `  (${detail})` : ''}`);
  }

  const style = 0x50000004; // WS_CHILD | WS_VISIBLE | ES_MULTILINE
  const edit = e.test_create_richedit(1, style, 0);
  const plainLen = streamDirect(edit, SF_TEXT, 'plain stream text');
  check('direct-cookie SF_TEXT populates the control',
    plainLen === 17 && readText(edit) === 'plain stream text',
    `len=${plainLen} text=${JSON.stringify(readText(edit))}`);

  const callbackResult = streamCallback(edit, 'callback stream text');
  check('documented EDITSTREAM callback populates the control',
    callbackResult.result === 20 && callbackResult.error === 0 &&
      callbackResult.callsCompleted === 1 && readText(edit) === 'callback stream text',
    `${JSON.stringify(callbackResult)} text=${JSON.stringify(readText(edit))}`);

  const bareRtfLen = streamDirect(edit, SF_RTF, 'bare visible');
  check('SF_RTF retains bare visible bytes',
    bareRtfLen === 12 && readText(edit) === 'bare visible',
    `len=${bareRtfLen} text=${JSON.stringify(readText(edit))}`);

  const minimalRtfLen = streamDirect(edit, SF_RTF, '{\\rtf1 Visible}');
  check('SF_RTF retains text after the document header',
    readText(edit).includes('Visible'),
    `len=${minimalRtfLen} text=${JSON.stringify(readText(edit))}`);

  const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Visible \\'ae text\\par Second line}";
  const rtfLen = streamDirect(edit, SF_RTF, rtf);
  const projected = readText(edit);
  check('SF_RTF projects visible document text',
    projected.includes('Visible ® text') && projected.includes('Second line'),
    `len=${rtfLen} text=${JSON.stringify(projected)}`);
  check('SF_RTF drops formatting destinations',
    !projected.includes('fonttbl') && !projected.includes('Arial'),
    JSON.stringify(projected));

  console.log(`${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
