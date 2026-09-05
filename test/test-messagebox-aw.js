#!/usr/bin/env node
'use strict';

// MessageBoxW used to carry a second copy of MessageBoxA's modal construction.
// Exercise the shared core through both ABI spellings and prove that the Wide
// entry narrows its text before the host sees it, while the dialog keeps its
// own caption copy after the temporary narrow buffer is freed.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_MessageBoxA") (param $text i32) (param $caption i32) (result i32)
    (global.set $esp (i32.const 0x00120000))
    (call $gs32 (global.get $esp) (i32.const 0x00401000))
    (call $handle_MessageBoxA (i32.const 0) (local.get $text) (local.get $caption)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $modal_dlg_hwnd))

  (func (export "test_MessageBoxW") (param $text i32) (param $caption i32) (result i32)
    (global.set $esp (i32.const 0x00120000))
    (call $gs32 (global.get $esp) (i32.const 0x00401000))
    (call $handle_MessageBoxW (i32.const 0) (local.get $text) (local.get $caption)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $modal_dlg_hwnd))

  (func (export "test_MessageBox_done")
    (call $modal_done (i32.const 1)))
`;

(async () => {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  let observed = null;
  const readA = wa => {
    if (!wa) return '';
    const bytes = new Uint8Array(memory.buffer);
    let out = '';
    for (let p = wa; bytes[p]; p++) out += String.fromCharCode(bytes[p]);
    return out;
  };
  const harness = await bootRenderHarness({
    extraWat,
    memory,
    extraHostOverrides: {
      message_box(owner, textWa, captionWa, type) {
        observed = { owner, text: readA(textWa), caption: readA(captionWa), type };
        return 1;
      },
    },
  });
  const e = harness.exports;
  const allocA = text => {
    const p = e.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) e.guest_write8(p + i, text.charCodeAt(i));
    e.guest_write8(p + text.length, 0);
    return p;
  };
  const allocW = text => {
    const p = e.guest_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) e.guest_write16(p + i * 2, text.charCodeAt(i));
    e.guest_write16(p + text.length * 2, 0);
    return p;
  };

  const wideText = allocW('Wide body');
  const wideCaption = allocW('Wide caption');
  const wideHwnd = e.test_MessageBoxW(wideText, wideCaption) >>> 0;
  assert(wideHwnd, 'MessageBoxW should create a modal dialog');
  assert.deepStrictEqual(observed,
    { owner: 0, text: 'Wide body', caption: 'Wide caption', type: 0 },
    'MessageBoxW narrows both UTF-16 strings for the shared ANSI renderer');
  assert.strictEqual(harness.renderer.windows[wideHwnd].title, 'Wide caption',
    'the registered dialog receives the narrowed caption');
  const retainedWa = e.get_window_title_ptr(wideHwnd) >>> 0;
  assert.strictEqual(readA(retainedWa), 'Wide caption',
    'the WAT title table retains its own copy after temporary buffers are freed');
  e.test_MessageBox_done();

  observed = null;
  const ansiHwnd = e.test_MessageBoxA(allocA('ANSI body'), allocA('ANSI caption')) >>> 0;
  assert(ansiHwnd, 'MessageBoxA should still create a modal dialog through the shared core');
  assert.deepStrictEqual(observed,
    { owner: 0, text: 'ANSI body', caption: 'ANSI caption', type: 0 },
    'MessageBoxA preserves its ANSI text and caption');
  assert.strictEqual(harness.renderer.windows[ansiHwnd].title, 'ANSI caption',
    'MessageBoxA and MessageBoxW register the same dialog shape');
  e.test_MessageBox_done();

  console.log('PASS  MessageBoxA/W share one modal implementation');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
