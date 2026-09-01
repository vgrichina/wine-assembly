#!/usr/bin/env node
'use strict';

// An app that was never clicked must still be able to take a keystroke.
//
// WHY: USER gives the focus to the window it activates, and the app's runtime
// passes it on to whichever control owns the content. We deliver the startup
// activation messages but recorded no focus window for them, so
// `get_focus_hwnd()` stayed 0 until a mouse press landed on a child and
// `_setInputFocus` wrote one. With focus 0 the keyboard is routed to main_hwnd
// (lib/host-window.js `inputEventHwnd`) -- the top-level frame -- and a frame
// whose gameplay lives in a child control does nothing at all with an arrow.
//
// On a desktop that never showed: you click the window before you play.
// The on-screen dpad (lib/touch-controls.js) is the first input device with no
// click in it, and Rodent's Revenge answered every arrow with a still board:
// the VB1 form is 0x10001, and the 276x276 picture control that IS the board
// is 0x10005. Measured before the fix, headless and in the browser alike:
// 0 of 307200 pixels changed across two arrow presses.
//
// The seed is deliberately narrow, and these are the four cases that define
// it: seed only when nothing holds the focus, and only when ONE child covers
// at least half the client area -- "this window's content is that control".

const assert = require('assert');
const { installInputHandlers } = require('../lib/renderer-input');
const { inputEventHwnd } = require('../lib/host-window');

const MAIN = 0x10001;

// Rodent's proportions: a 292x350 frame, a 4px border, a 26px caption, and a
// 276x276 board child sitting under a status strip.
function rodentExports(overrides) {
  const geometry = Object.assign({
    focus: 0,
    childAt: 0x10005,
    childW: 276,
    childH: 276,
  }, overrides || {});
  const calls = [];
  const exports = {
    _calls: calls,
    _geometry: geometry,
    get_focus_hwnd: () => geometry.focus | 0,
    set_focus_hwnd: (hwnd) => { geometry.focus = hwnd | 0; calls.push(['set_focus_hwnd', hwnd]); },
    set_focus: (hwnd) => { calls.push(['set_focus', hwnd]); },
    wnd_window_screen_x: () => 0,
    wnd_window_screen_y: () => 0,
    wnd_screen_w: (hwnd) => (hwnd === MAIN ? 292 : geometry.childW),
    wnd_screen_h: (hwnd) => (hwnd === MAIN ? 350 : geometry.childH),
    wnd_client_screen_x: () => 4,
    wnd_client_screen_y: () => 30,
    wnd_child_from_point_deep: () => geometry.childAt | 0,
    wnd_get_style_export: () => 0,
  };
  return exports;
}

class RendererProbe {
  constructor(exports) {
    this.inputQueue = [];
    this.wasm = { exports };
    this.mainWasm = this.wasm;
    this.windows = {
      [MAIN]: { hwnd: MAIN, visible: true, isChild: false, wasm: this.wasm, zOrder: 1 },
    };
    this._exited = false;
  }
  _compareTopLevelZ(a, b) { return (a.zOrder || 0) - (b.zOrder || 0); }
  scheduleRepaint() {}
  repaint() {}
  invalidate() {}
}
installInputHandlers(RendererProbe);

// 1. The case from the bug report: nothing holds the focus and one child owns
//    the client area, so the arrow goes to that child.
{
  const exports = rodentExports();
  const renderer = new RendererProbe(exports);
  renderer.handleKeyDown(0x26, { code: 'ArrowUp' });
  assert.strictEqual(exports.get_focus_hwnd(), 0x10005,
    'a key with no focus anywhere should seed the client-filling child');
  const event = renderer.takeInput();
  assert(event, 'the key is still queued as a normal input event');
  assert.strictEqual(inputEventHwnd(event, exports), 0x10005,
    'and the shared routing rule now delivers WM_KEYDOWN to that child');
}

// 2. A frame whose children are furniture -- a toolbar, a status strip -- is
//    NOT a frame whose content is one control. Those apps keep the old
//    main_hwnd routing, which is what they have always handled keys with.
{
  const exports = rodentExports({ childW: 276, childH: 40 });
  const renderer = new RendererProbe(exports);
  renderer.handleKeyDown(0x26, { code: 'ArrowUp' });
  assert.strictEqual(exports.get_focus_hwnd(), 0,
    'a child covering a fraction of the client must not steal the keyboard');
  assert.strictEqual(inputEventHwnd(renderer.takeInput(), exports), 0,
    'routing falls back to main_hwnd exactly as before');
}

// 3. A window that already handed the focus somewhere keeps it. The seed is a
//    substitute for an activation we never performed, never an override.
{
  const exports = rodentExports({ focus: 0x10009 });
  const renderer = new RendererProbe(exports);
  renderer.handleKeyDown(0x26, { code: 'ArrowUp' });
  assert.strictEqual(exports.get_focus_hwnd(), 0x10009,
    'an existing focus window must survive a keystroke');
  assert.deepStrictEqual(exports._calls, [],
    'and no focus transition should be published at all');
}

// 4. A single-window game -- Pinball -- has no child to seed, and must be left
//    on main_hwnd rather than handed some stray hwnd.
{
  const exports = rodentExports({ childAt: 0 });
  const renderer = new RendererProbe(exports);
  renderer.handleKeyDown(0x5A, { code: 'KeyZ' });
  assert.strictEqual(exports.get_focus_hwnd(), 0,
    'a window with no children keeps focus 0 and the main_hwnd fallback');
}

// 5. A disabled child cannot take the focus in Windows and must not take it
//    here: WS_DISABLED is bit 27. Spelled as a shift rather than the hex
//    literal because 0x08000000 also happens to be $VIRTUAL_BACKING_BASE, and
//    tools/region-census.js reads a bare eight-digit address in a JS test as a
//    copy of the memory map (docs/watx-region-safety-design.md). This is a
//    Win32 window style, not an address.
{
  const exports = rodentExports();
  const WS_DISABLED = 1 << 27;
  exports.wnd_get_style_export = () => WS_DISABLED;
  const renderer = new RendererProbe(exports);
  renderer.handleKeyDown(0x26, { code: 'ArrowUp' });
  assert.strictEqual(exports.get_focus_hwnd(), 0,
    'a disabled child must not be seeded with the focus');
}

console.log('PASS  a first keystroke seeds the focus USER would have given the app');
