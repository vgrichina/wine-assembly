'use strict';

// The live driver, without a browser.
//
// tools/toyvm/live.js is the only part of the emulator whose caller is a page,
// and the two things it has to get right cannot be seen from run-dos.js: it
// must hand the thread back between chunks rather than running a program to
// completion, and a keystroke has to reach a guest that reads the keyboard as
// hardware as well as one that asks the BIOS.
//
// Both are testable here. `requestAnimationFrame` and a canvas are a dozen
// lines of stub, and what comes out the other end is pixels -- so this asserts
// on the pixels: a program that prints runs to its exit and its text is on the
// surface the page would paint.

const assert = require('assert');

const { LiveRun, scancodeFor, hasTailCalls, pickVariant } = require('../tools/toyvm/live');

// The dispatch shell the page will ask for, and the probe that chooses it.
//
// This exists because both ways of getting it wrong are SILENT. A probe that
// wrongly says no costs every visitor the 10% the tail-call shell is worth and
// nothing anywhere reports it. A probe that wrongly says yes fails to compile
// the whole module on a Safari older than 18.2, and from the page that looks
// exactly like a Run button that does nothing -- which is how it was found.
//
// Node has had wasm tail calls since v12 behind a flag and on by default since
// v22, so on any node that can run this file the answer must be true. If it is
// false here, the hand-encoded probe module is malformed, not the engine.
function checkVariantProbe() {
  assert.strictEqual(hasTailCalls(), true,
    'the tail-call probe module says this node has no tail calls, which it does'
    + ' -- the hand-encoded bytes in live.js are malformed, and every browser'
    + ' would silently fall back to the slower `calls` shell');
  assert.strictEqual(pickVariant(), 'tailcall',
    'an engine with tail calls must get the tailcall shell');
}

// A .COM that prints and exits, hand-assembled so the test needs no corpus.
function helloCom() {
  const msg = 'LIVE$';
  return Uint8Array.from([
    0xB4, 0x09,                     // mov ah, 9
    0xBA, 0x09, 0x01,               // mov dx, 0x109  (message, PSP-relative)
    0xCD, 0x21,                     // int 21h
    0xCD, 0x20,                     // int 20h
    ...[...msg].map(c => c.charCodeAt(0)),
  ]);
}

// A .COM that waits for a key through the BIOS, then exits. INT 16h AH=00 is
// the call that blocks, which is what makes it the interesting case: the run
// has to stop, stay stopped, and resume when a key arrives.
function waitCom() {
  return Uint8Array.from([
    0xB4, 0x00,                     // mov ah, 0
    0xCD, 0x16,                     // int 16h   (wait for a key)
    0xCD, 0x20,                     // int 20h
  ]);
}

// A canvas that records what was put on it.
function fakeCanvas() {
  const cv = {
    width: 0, height: 0, last: null, paints: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (d) => { cv.last = d; cv.paints++; },
    }),
    focus() {},
  };
  return cv;
}

// A frame clock that runs on the microtask queue, so a test can await the run
// finishing instead of polling a timer.
function installFrameClock() {
  const pending = [];
  global.requestAnimationFrame = (fn) => { pending.push(fn); return pending.length; };
  global.cancelAnimationFrame = () => {};
  if (!global.performance) global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
  return {
    // Run frames until nothing more is scheduled, or the cap trips -- a cap
    // rather than a while(true) so a regression is a failed assertion with a
    // number in it rather than a test run that never returns.
    drain(max = 400) {
      let n = 0;
      while (pending.length && n < max) { pending.shift()(); n++; }
      return n;
    },
    get queued() { return pending.length; },
  };
}

async function main() {
  checkVariantProbe();
  const clock = installFrameClock();

  // --- scancodes ----------------------------------------------------------
  // The table is hand-written, so the three shapes it covers are each checked
  // once: a named key, a letter, a digit.
  assert.strictEqual(scancodeFor('Escape'), 0x01, 'Escape is scancode 1');
  assert.strictEqual(scancodeFor('a'), 0x1E, 'a is scancode 1Eh');
  assert.strictEqual(scancodeFor('1'), 0x02, '1 is scancode 2');

  // --- a program that runs to completion ----------------------------------
  const canvas = fakeCanvas();
  const states = [];
  const run = new LiveRun({
    canvas,
    exe: 'hello.com',
    files: { 'hello.com': helloCom() },
    onStatus: (s) => states.push(s.state),
    // A whole frame of budget: this program is nine instructions and the point
    // is the chunking, not the pacing.
    msPerFrame: 16,
  });
  await run.start();
  clock.drain();

  assert.ok(run.machine.exited, 'the program never reached its exit');
  assert.ok(states.includes('exited'), `no exit was reported; states were ${states.join(',')}`);
  assert.ok(canvas.paints > 0, 'nothing was ever painted to the canvas');
  assert.strictEqual(canvas.width, 80 * 8, `text mode painted at ${canvas.width}px wide`);

  // The text is on the surface. Reading it back off the RGBA rather than off
  // the console proves the paint path itself works -- a console that has the
  // characters and a canvas that stays black is exactly the failure a page
  // would show.
  const painted = canvas.last.data;
  let lit = 0;
  for (let i = 0; i < painted.length; i += 4) if (painted[i] || painted[i + 1] || painted[i + 2]) lit++;
  assert.ok(lit > 20, `the painted frame is blank (${lit} lit pixels)`);

  const { conText } = require('../tools/toyvm/framebuffer');
  const conTextOf = (r) => conText(r.machine.con);
  assert.ok(conText(run.machine.con).includes('LIVE'),
    `the program's output is missing: ${JSON.stringify(conText(run.machine.con))}`);

  // --- the same program, on the shell an old Safari gets ------------------
  // The `calls` fallback is dead code on every engine that runs this suite, so
  // without forcing it nothing would ever compile it and a typo in the shell
  // name would surface only on a machine none of us has.
  const canvasC = fakeCanvas();
  const fallback = new LiveRun({
    canvas: canvasC,
    exe: 'hello.com',
    files: { 'hello.com': helloCom() },
    variant: 'calls',
    msPerFrame: 16,
  });
  await fallback.start();
  clock.drain();
  assert.ok(fallback.machine.exited,
    'the `calls` shell -- what a Safari without wasm tail calls gets -- never reached the exit');
  assert.ok(conTextOf(fallback).includes('LIVE'),
    `the fallback shell ran but printed nothing: ${JSON.stringify(conTextOf(fallback))}`);

  // --- a program that waits for a key -------------------------------------
  const canvas2 = fakeCanvas();
  const states2 = [];
  const waiter = new LiveRun({
    canvas: canvas2,
    exe: 'wait.com',
    files: { 'wait.com': waitCom() },
    onStatus: (s) => states2.push(s.state),
    msPerFrame: 16,
  });
  await waiter.start();
  clock.drain();

  assert.ok(!waiter.machine.exited, 'the program exited without ever getting a key');
  assert.ok(states2.includes('waiting'),
    `the wait was not reported; states were ${states2.join(',')}`);
  assert.strictEqual(clock.queued, 0, 'a blocked program is still burning frames');

  // A key from the page. Both halves go in -- the BIOS queue and the port --
  // and this program reads the BIOS one.
  waiter.key({ key: 'a' });
  clock.drain();
  assert.ok(waiter.machine.exited,
    'the key did not reach the guest: it is still waiting after the keypress');

  console.log(`PASS test-toyvm-live: printed and exited in ${canvas.paints} painted frame(s), `
    + 'and a blocked program resumed on a keypress');
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
