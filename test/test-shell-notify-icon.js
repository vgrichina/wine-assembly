#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const RegionMap = require('../lib/region-map.generated.js');

const EXTRA_WAT = String.raw`
  (func (export "test_notify_make_window") (param $hwnd i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CTRL_NATIVE)))

  (func (export "test_shell_notify") (param $action i32) (param $nid i32)
      (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_Shell_NotifyIconA
      (local.get $action) (local.get $nid)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

function unpack(value) {
  return { result: Number(value & 0xffffffffn), esp: Number(value >> 32n) };
}

(async () => {
  const { exports: e, memory, renderer } = await bootRenderHarness({ extraWat: EXTRA_WAT });
  const dv = new DataView(memory.buffer);
  const u8 = new Uint8Array(memory.buffer);
  const wa = guest => RegionMap.g2w(guest >>> 0, e.get_image_base());
  const alloc = size => e.guest_alloc(size) >>> 0;
  const hwnd = 0x1234;
  e.test_notify_make_window(hwnd);

  function makeNid({ id = 7, flags = 7, callback = 0x500, hIcon = 0x60001,
    tip = 'WinRAR archive manager', size = 88 } = {}) {
    const guest = alloc(Math.max(88, size));
    const p = wa(guest);
    u8.fill(0, p, p + Math.max(88, size));
    dv.setUint32(p, size, true);
    dv.setUint32(p + 4, hwnd, true);
    dv.setUint32(p + 8, id, true);
    dv.setUint32(p + 12, flags, true);
    dv.setUint32(p + 16, callback, true);
    dv.setUint32(p + 20, hIcon, true);
    for (let i = 0; i < Math.min(63, tip.length); i++) u8[p + 24 + i] = tip.charCodeAt(i);
    return guest;
  }

  const nid = makeNid();
  assert.deepStrictEqual(unpack(e.test_shell_notify(0, nid)),
    { result: 1, esp: 0x0030000c }, 'NIM_ADD succeeds and pops two arguments');
  assert.strictEqual(e.test_shell_notify(0, nid) & 0xffffffffn, 0n,
    'NIM_ADD rejects a duplicate (hWnd,uID)');
  assert.strictEqual(renderer._notifyIcons.size, 1);
  let icon = [...renderer._notifyIcons.values()][0].get(`${hwnd}:7`);
  assert(icon);
  assert.strictEqual(icon.tip, 'WinRAR archive manager');
  assert.strictEqual(icon.callbackMessage, 0x500);
  assert.strictEqual(icon.hIcon, 0x60001);

  const modify = makeNid({ flags: 4, callback: 0x999, hIcon: 0xdead,
    tip: 'Updated tooltip' });
  assert.strictEqual(e.test_shell_notify(1, modify) & 0xffffffffn, 1n);
  icon = [...renderer._notifyIcons.values()][0].get(`${hwnd}:7`);
  assert.strictEqual(icon.tip, 'Updated tooltip', 'NIF_TIP changes the copied tooltip');
  assert.strictEqual(icon.callbackMessage, 0x500, 'fields absent from uFlags remain unchanged');
  assert.strictEqual(icon.hIcon, 0x60001);

  const area = {
    children: [], innerHTML: '',
    appendChild(child) { this.children.push(child); },
  };
  const oldDocument = global.document;
  global.document = {
    getElementById(id) { return id === 'notify-icons' ? area : null; },
    createElement(tag) {
      return {
        tag, children: [],
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this[name] = value; },
      };
    },
  };
  try {
    renderer.updateNotificationArea();
    assert.strictEqual(area.children.length, 1);
    const button = area.children[0];
    assert.strictEqual(button.title, 'Updated tooltip');
    button.ondblclick();
    assert.deepStrictEqual(renderer.inputQueue.pop(), {
      type: 'notify', hwnd, msg: 0x500, wParam: 7, lParam: 0x0203,
    }, 'double-click is delivered through the app callback message');
    button.onmousedown({ button: 2 });
    button.onmouseup({ button: 2 });
    assert.strictEqual(renderer.inputQueue.shift().lParam, 0x0204);
    assert.strictEqual(renderer.inputQueue.shift().lParam, 0x0205);
  } finally {
    global.document = oldDocument;
  }

  assert.strictEqual(e.test_shell_notify(2, nid) & 0xffffffffn, 1n,
    'NIM_DELETE removes the matching icon');
  assert.strictEqual(renderer._notifyIcons.size, 0);
  assert.strictEqual(e.test_shell_notify(2, nid) & 0xffffffffn, 0n,
    'deleting an absent icon fails');
  assert.strictEqual(e.test_shell_notify(3, nid) & 0xffffffffn, 0n,
    'post-Win98 notification commands are not silently accepted');
  assert.strictEqual(e.test_shell_notify(0, makeNid({ size: 24 })) & 0xffffffffn, 0n,
    'undersized NOTIFYICONDATA is rejected');

  console.log('PASS  Shell_NotifyIconA owns Win98 notification-area state and callbacks');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
