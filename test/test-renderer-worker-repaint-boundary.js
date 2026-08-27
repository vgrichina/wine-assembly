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
assert(beginPaintWat.includes('(call $host_paint_begin (local.get $arg0))'),
  'BeginPaint must open the browser publication transaction');
assert(endPaintWat.includes('(call $host_paint_end (local.get $arg0))'),
  'EndPaint must close the browser publication transaction');
assert(controlsWat.includes('(call $host_paint_begin (local.get $hwnd))') &&
  controlsWat.includes('(call $host_paint_end (local.get $hwnd))'),
  'WAT-native EDIT paint must bracket its fill and text as one publication');
assert(hostImports.includes('paint_begin: (hwnd) =>') &&
  hostImports.includes('paint_end: (hwnd) =>'),
  'host imports must forward paint transactions to the renderer');
assert(browserHost.includes("fetch('lib/host-import-sigs.generated.json?v=3')"),
  'Worker launch must cache-bust the signature table containing paint brackets');
assert(guestRpc.includes("'paint_begin',") && guestRpc.includes("'paint_end',"),
  'value-only paint brackets must not add two blocking RPCs per control paint');

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

  renderer.beginWorkerGuestSlice();
  renderer.scheduleRepaint();
  assert.strictEqual(callbacks.length, 0,
    'mid-slice GDI erase must not queue a browser frame');
  assert.strictEqual(renderer._workerRepaintDeferred, true);

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
