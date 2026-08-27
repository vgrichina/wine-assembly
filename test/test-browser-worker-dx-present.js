#!/usr/bin/env node
'use strict';

// The browser's guest-main Worker loop has its own slice boundary. DirectDraw
// writes happen in shared memory, but uploading that shared primary to the
// renderer remains main-thread work. Missing this one call left _dxDirty set
// indefinitely: AoE II accepted Single Player and created its EDIT child while
// the browser kept displaying the old menu frame.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const start = source.indexOf('_runThreaded(stepsPerSlice)');
const end = source.indexOf('// Schedule the next guest slice.', start);
assert(start >= 0 && end > start, 'host.js should contain the browser Worker run loop');

const loop = source.slice(start, end);
const rendezvous = loop.indexOf('await Promise.all([self.guestWorker.slice(steps, sync), runThreads()])');
const present = loop.indexOf('self._presentDxIfDirty()', rendezvous);
const composite = loop.indexOf('self.renderer.flushRepaint(true)', rendezvous);

assert(rendezvous >= 0, 'Worker loop should await its guest slice rendezvous');
assert(present > rendezvous,
  'Worker slice boundary must upload DirectDraw surfaces dirtied by guest RPC');
assert(composite > present,
  'Worker DirectDraw upload must happen before the renderer composites the frame');

console.log('PASS browser Worker slice uploads dirty DirectDraw frames before compositing');
