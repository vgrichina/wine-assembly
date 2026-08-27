#!/usr/bin/env node
'use strict';

// Brokered Worker imports yield to the browser between GDI primitives. A
// repaint requested by the erase at the start of WM_PAINT must wait until the
// guest slice has also drawn its text/content, matching cooperative execution.

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

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

  renderer.endWorkerGuestSlice();
  renderer.flushRepaint(true);
  assert.strictEqual(callbacks.length, 1,
    'slice boundary should publish one coalesced browser frame');
  callbacks.shift()();
  assert.strictEqual(repaints, 1,
    'completed Worker paint should composite exactly once');
  assert.strictEqual(renderer._repaintScheduled, false);

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
} finally {
  if (oldRaf === undefined) delete global.requestAnimationFrame;
  else global.requestAnimationFrame = oldRaf;
}

console.log('PASS Worker GDI repaint publishes only at completed slice boundaries');
