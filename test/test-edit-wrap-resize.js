#!/usr/bin/env node
// Direct WAT EDIT wrapping regression.
//
// A wrapped multiline edit's max scroll depends on current control geometry.
// After a resize that reduces the visual line count/max-scroll, WM_SIZE should
// clamp EditState.scroll_top immediately, before the next WM_PAINT.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { mountBundledFonts } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const WM_SIZE = 0x0005;
const WM_MOUSEWHEEL = 0x020A;
const EM_GETFIRSTVISIBLELINE = 0x00CE;

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_VSCROLL = 0x00200000;
const ES_MULTILINE = 0x0004;

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  // Wrapping is decided by $host_measure_text, and with no fonts in the VFS
  // every string measures 0 -- nothing is ever too wide, so the layout comes
  // back as one line no matter how narrow the control is. Must be after
  // createHostImports, which is what creates ctx.vfs.
  mountBundledFonts(ctx);
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
  ctx.exports = instance.exports;
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);

  const wa = g => g - e.get_image_base() + 0x12000;
  const writeStr = (s) => {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    return g;
  };

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass: !!pass, info });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? `  (${info})` : ''));
  }

  const text = [
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
    'kilo lima mike november oscar papa quebec romeo sierra tango',
    'uniform victor whiskey xray yankee zulu',
  ].join(' ');
  const style = WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE;
  const edit = e.test_create_edit(0, 0, 96, 40, style, writeStr(text));

  check('edit hwnd allocated', edit !== 0, `hwnd=0x${edit.toString(16)}`);
  check('initial text length matches', e.get_edit_text_len(edit) === text.length,
    `got ${e.get_edit_text_len(edit)} expected ${text.length}`);

  const narrowLines = e.test_edit_visual_line_count(edit);
  const narrowMax = e.test_edit_max_scroll(edit);
  check('narrow edit wraps into multiple visual lines', narrowLines >= 8,
    `lines=${narrowLines}`);
  check('narrow edit has scroll range', narrowMax > 0, `max=${narrowMax}`);

  const wheelDown = (-120 << 16);
  for (let i = 0; i < 12; i++) e.send_message(edit, WM_MOUSEWHEEL, wheelDown, 0);
  const scrolledTop = e.send_message(edit, EM_GETFIRSTVISIBLELINE, 0, 0);
  check('wheel scroll reaches narrow max', scrolledTop === narrowMax,
    `top=${scrolledTop} max=${narrowMax}`);

  e.ctrl_set_geom(edit, 0, 0, 280, 96);
  const staleBeforeSize = e.send_message(edit, EM_GETFIRSTVISIBLELINE, 0, 0);
  const wideLines = e.test_edit_visual_line_count(edit);
  const wideMax = e.test_edit_max_scroll(edit);
  check('wide resize reduces visual lines/max scroll', wideLines < narrowLines && wideMax < staleBeforeSize,
    `narrowLines=${narrowLines} wideLines=${wideLines} staleTop=${staleBeforeSize} wideMax=${wideMax}`);

  e.send_message(edit, WM_SIZE, 0, 280 | (96 << 16));
  const clampedTop = e.send_message(edit, EM_GETFIRSTVISIBLELINE, 0, 0);
  check('WM_SIZE clamps first visible line to resized max', clampedTop === wideMax,
    `top=${clampedTop} wideMax=${wideMax}`);

  console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed`);
  if (checks.some(c => !c.pass)) process.exit(1);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
