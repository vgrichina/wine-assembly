#!/usr/bin/env node
'use strict';

// Brokered Worker imports yield to the browser between GDI primitives. A
// repaint requested by the erase at the start of WM_PAINT must wait until the
// guest slice has also drawn its text/content, matching cooperative execution.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Win98Renderer } = require('../lib/renderer');

const ROOT = path.resolve(__dirname, '..');
const beginPaintWat = fs.readFileSync(path.join(ROOT, 'src/09a-handlers.wat'), 'utf8');
const endPaintWat = fs.readFileSync(path.join(ROOT, 'src/09a4-handlers-gdi.wat'), 'utf8');
const controlsWat = fs.readFileSync(path.join(ROOT, 'src/09c3-controls.wat'), 'utf8');
const hostImports = fs.readFileSync(path.join(ROOT, 'lib/host-imports.js'), 'utf8');
const browserHost = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const guestRpc = fs.readFileSync(path.join(ROOT, 'lib/guest-rpc.js'), 'utf8');
const helpersWat = fs.readFileSync(path.join(ROOT, 'src/10-helpers.wat'), 'utf8');
assert(beginPaintWat.includes('(call $host_paint_begin (local.get $arg0))'),
  'BeginPaint must open the browser publication transaction');
assert(endPaintWat.includes('(call $host_paint_end (local.get $arg0))'),
  'EndPaint must close the browser publication transaction');
assert(controlsWat.includes('(call $host_paint_begin (local.get $hwnd))') &&
  controlsWat.includes('(call $host_paint_end (local.get $hwnd))'),
  'WAT-native EDIT paint must bracket its fill and text as one publication');
const modalPump = controlsWat.match(/\(func \$modal_pump_step[\s\S]*?\n  \)/);
assert(modalPump && /\(drop \(call \$wat_wndproc_dispatch[\s\S]*?\n\s*\(call \$host_invalidate \(local\.get \$hwnd\)\)/
  .test(modalPump[0]),
  'modal native-control paint completion must request a canonical composite');
assert(hostImports.includes('paint_begin: (hwnd) =>') &&
  hostImports.includes('paint_end: (hwnd) =>'),
  'host imports must forward paint transactions to the renderer');
assert(browserHost.includes("fetch('lib/host-import-sigs.generated.json?v=8')"),
  'Worker launch must cache-bust the signature table containing paint brackets');
assert(guestRpc.includes("'paint_begin',") && guestRpc.includes("'paint_end',"),
  'value-only paint brackets must not add two blocking RPCs per control paint');
const uncoverBody = helpersWat.match(/\(func \$wnd_uncover_parent[\s\S]*?\n  \)/);
assert(uncoverBody && uncoverBody[0].includes('(call $update_invalidate_rect (local.get $parent)'),
  'hiding a child invalidates only its exposed parent rectangle');

const callbacks = [];
const oldRaf = global.requestAnimationFrame;
global.requestAnimationFrame = callback => {
  callbacks.push(callback);
  return callbacks.length;
};

try {
  const ctx = { imageSmoothingEnabled: true };
  const canvas = { width: 8, height: 8, getContext: () => ctx };
  const renderer = new Win98Renderer(canvas);
  renderer._isNode = false;
  let repaints = 0;
  renderer.repaint = () => { repaints++; };

  // Cooperative execution blocks the browser only until its block budget is
  // exhausted. A BeginPaint/EndPaint pair can cross that boundary just as it
  // can cross Worker slices, so it must keep the queued rAF private too.
  renderer.beginWorkerGdiPaint(0x10001);
  renderer.scheduleRepaint();
  assert.strictEqual(callbacks.length, 0,
    'cooperative BeginPaint must hold a frame that spans slices');
  renderer.flushRepaint(true);
  assert.strictEqual(repaints, 0,
    'cooperative slice boundary must not publish inside BeginPaint');
  renderer.endWorkerGdiPaint(0x10001);
  assert.strictEqual(callbacks.length, 1,
    'cooperative EndPaint should queue the completed transaction');
  callbacks.shift()();
  assert.strictEqual(repaints, 1,
    'completed cooperative paint should composite exactly once');
  repaints = 0;

  // A synchronous modal loop can begin inside its owner's WM_PAINT and wait
  // there indefinitely for user input. The nested loop suspends the outer
  // transaction so both what the owner drew before MessageBox and the
  // separately completed dialog can become visible.
  const ownerCanvas = { _waFlushCanonicalSurface: () => { ownerCanvas.flushes++; }, flushes: 0 };
  const dialogCanvas = { _waFlushCanonicalSurface: () => { dialogCanvas.flushes++; }, flushes: 0 };
  const owner = { hwnd: 0x10020, visible: true, isChild: false,
    _backCanvas: ownerCanvas };
  const dialog = { hwnd: 0x10021, visible: true, isDialog: true,
    isChild: false, ownerHwnd: owner.hwnd, clientPainted: true,
    _backCanvas: dialogCanvas };
  renderer.windows[owner.hwnd] = owner;
  renderer.windows[dialog.hwnd] = dialog;
  renderer.beginWorkerGdiPaint(owner.hwnd);
  assert.strictEqual(renderer._workerPublicationHeld(), false,
    'a painted modal dialog must not wait forever for its owner EndPaint');
  renderer._flushCanonicalCanvas(ownerCanvas);
  renderer._flushCanonicalCanvas(dialogCanvas);
  assert.strictEqual(ownerCanvas.flushes, 1,
    'a nested modal loop must publish what its owner already drew');
  assert.strictEqual(dialogCanvas.flushes, 1,
    'the completed modal surface may publish independently');
  renderer.beginWorkerGdiPaint(dialog.hwnd);
  assert.strictEqual(renderer._workerPublicationHeld(), true,
    'a dialog inside its own BeginPaint remains private');
  renderer.endWorkerGdiPaint(dialog.hwnd);
  renderer.endWorkerGdiPaint(owner.hwnd);
  delete renderer.windows[dialog.hwnd];
  delete renderer.windows[owner.hwnd];

  // A saved parent snapshot already repairs the pixels exposed by hiding a
  // child. WAT queues the clipped repaint; JS must not widen it to the entire
  // top-level tree and erase unrelated menu controls.
  const parent = { hwnd: 0x10010, visible: true, isChild: false, zOrder: 1 };
  const child = { hwnd: 0x10011, visible: true, isChild: true,
    parentHwnd: parent.hwnd, zOrder: 2 };
  renderer.windows[parent.hwnd] = parent;
  renderer.windows[child.hwnd] = child;
  let fullTreeInvalidations = 0;
  renderer.restoreParentUnderChild = () => true;
  renderer.invalidateVisibleTree = () => { fullTreeInvalidations++; };
  renderer.showWindow(child.hwnd, 0);
  assert.strictEqual(fullTreeInvalidations, 0,
    'snapshot-backed child hide must preserve unrelated parent pixels');
  callbacks.length = 0;
  renderer._repaintScheduled = false;
  renderer._repaintRaf = null;

  renderer.beginWorkerGuestSlice();
  renderer.scheduleRepaint();
  assert.strictEqual(callbacks.length, 0,
    'mid-slice GDI erase must not queue a browser frame');
  assert.strictEqual(renderer._workerRepaintDeferred, true);

  // ShowWindow, SetWindowPos, and several input paths request an immediate
  // repaint instead of going through scheduleRepaint. Half-Life repeatedly
  // toggles its launcher children while painting the menu, so a direct call
  // must obey the same complete-slice publication boundary.
  Win98Renderer.prototype.repaint.call(renderer);
  assert.strictEqual(repaints, 0,
    'direct repaint during a Worker slice must not expose partial menu pixels');
  assert.strictEqual(renderer._repaintScheduled, true,
    'blocked direct repaint remains scheduled for the safe slice boundary');

  renderer.beginWorkerGdiPaint(0x10002);
  renderer.endWorkerGuestSlice();
  renderer._workerLastCompositeAt = performance.now();
  renderer.flushRepaint(true);
  assert.strictEqual(callbacks.length, 0,
    'slice boundary inside BeginPaint/EndPaint must not publish the erase');

  // The next slice draws the field contents, but the paint transaction is
  // still open. A second boundary must keep the complete-looking intermediate
  // canvas private until EndPaint validates it.
  renderer.beginWorkerGuestSlice();
  renderer.scheduleRepaint();
  renderer.endWorkerGuestSlice();
  renderer.flushRepaint(true);
  assert.strictEqual(callbacks.length, 0,
    'a spanning WM_PAINT stays private across every intermediate boundary');

  renderer.beginWorkerGuestSlice();
  renderer.endWorkerGdiPaint(0x10002);
  renderer.endWorkerGuestSlice();
  renderer.flushRepaint(true);
  assert.strictEqual(callbacks.length, 1,
    'EndPaint boundary should publish one coalesced browser frame');
  callbacks.shift()();
  assert.strictEqual(repaints, 1,
    'completed Worker paint should composite exactly once');
  assert.strictEqual(renderer._repaintScheduled, false);
  assert.strictEqual(renderer._workerGdiPaintDepth, 0);

  // A frame queued before the next slice can become due while the Worker is
  // active. Its callback must defer rather than expose another partial paint.
  renderer.scheduleRepaint();
  assert.strictEqual(callbacks.length, 1);
  renderer.beginWorkerGuestSlice();
  callbacks.shift()();
  assert.strictEqual(repaints, 1,
    'rAF becoming due during a Worker slice must not repaint');
  renderer.endWorkerGuestSlice();
  renderer.flushRepaint(true);
  assert.strictEqual(callbacks.length, 1);
  callbacks.shift()();
  assert.strictEqual(repaints, 2);

  // If the browser's queued rAF repeatedly loses the race to the next Worker
  // slice, a due frame must still publish at the safe boundary. Rate limiting
  // keeps this from becoming one full composite per guest slice.
  renderer.beginWorkerGuestSlice();
  renderer.scheduleRepaint();
  renderer.endWorkerGuestSlice();
  renderer._workerLastCompositeAt = performance.now() - 20;
  renderer.flushRepaint(true);
  assert.strictEqual(repaints, 3,
    'a due frame must publish synchronously at the completed slice boundary');
} finally {
  if (oldRaf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = oldRaf;
}

console.log('PASS Worker GDI repaint publishes only at completed slice boundaries');
