#!/usr/bin/env node

'use strict';

// The 60 Hz vertical-blank model and the park it drives.
//
// WHY THIS EXISTS
// IDirectDraw::WaitForVerticalBlank used to set EAX=0 and return, which is not
// "imprecise pacing": it changes what a game decides to do. DX-Ball times 32 of
// these calls at startup and will only use vsync — and only then take its Flip
// present path at all — if the total exceeds 400 ms (docs/re-notes/dxball.md).
// An instant return measures 0, so the game concluded the machine had no usable
// vsync, disabled Flip, and fell back to a busy-wait software limiter that
// burned 47 million spin iterations to produce the same frame rate.
//
// Two halves are checked, because they fail differently:
//
//  * The MODEL is pure arithmetic on a guest millisecond. It is exported
//    directly so a drifting boundary or a scanline that never reaches the
//    blanking interval is a failed assertion here rather than a game that
//    paces slightly wrong somewhere far away.
//
//  * The PARK is the part with sharp edges. A handler that yields must leave
//    the stdcall frame alone and raise $handler_set_eip, or $run's thunk-zone
//    auto-pop splices the call out entirely and the guest resumes past its own
//    WaitForVerticalBlank with the arguments still on the stack (the bug
//    $io_block and the CS park both carry a comment about). Check 4 is that
//    assertion, and check 5 is that the wait actually ENDS.
//
// The guest clock is supplied here (ctx.guestNowMs), so none of this depends on
// wall time and the whole file is deterministic.

const path = require('path');
const fs = require('fs');

const IMAGE_BASE = 0x400000;
const WASM = path.join(__dirname, '..', 'build', 'wine-assembly.wasm');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

async function boot() {
  const { createHostImports } = require('../lib/host-imports');
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const clock = { now: 0 };
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
    guestNowMs: () => clock.now,
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const stub of ['create_thread', 'exit_thread', 'terminate_thread', 'create_event',
    'set_event', 'reset_event', 'wait_single', 'wait_multiple']) base.host[stub] = () => 0;
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM), base);
  ctx.exports = instance.exports;
  instance.exports.init_thread(1, IMAGE_BASE, 0, 0, 0, 0, 0);
  return { e: instance.exports, clock };
}

async function main() {
  const { e, clock } = await boot();

  // ---- 1. the boundary grid -------------------------------------------
  // Sixty boundaries per second, each strictly ahead of `now`, and never
  // repeating — a boundary that equalled `now` would let a wait complete
  // without waiting at all, which is the old bug in a new place.
  const boundary = ms => e.test_vblank_next_boundary(ms) >>> 0;
  let strictlyAhead = true, monotone = true, prev = -1;
  const seen = new Set();
  for (let ms = 0; ms < 2000; ms++) {
    const b = boundary(ms);
    if (b <= ms) strictlyAhead = false;
    if (b < prev) monotone = false;
    prev = b;
    if (b <= 1000) seen.add(b);
  }
  check('every boundary is strictly ahead of now', strictlyAhead);
  check('boundaries never go backwards as now advances', monotone);
  // 0 is not a boundary any `now` waits for (the first is 17), so the first
  // second holds 60 of them: 17, 34, 50 ... 1000.
  check('60 vertical blanks per guest second', seen.size === 60, `got ${seen.size}`);

  // A wait started at any point inside a period is under one period long.
  let worst = 0;
  for (let ms = 0; ms < 5000; ms++) worst = Math.max(worst, boundary(ms) - ms);
  check('no wait is longer than one 60 Hz period', worst <= 17, `worst=${worst}ms`);

  // ---- 2. scanline and blanking status agree ---------------------------
  // GetScanLine and GetVerticalBlankStatus are two views of one phase, so an
  // app that polls both can never be told contradictory things.
  let contradiction = false, maxLine = -1, minLine = 1e9, inBlank = 0;
  for (let ms = 0; ms < 1000; ms++) {
    const line = e.test_vblank_scanline(ms) >>> 0;
    const vb = e.test_vblank_in_blank(ms) >>> 0;
    if ((line >= 480) !== !!vb) contradiction = true;
    if (line > maxLine) maxLine = line;
    if (line < minLine) minLine = line;
    if (vb) inBlank++;
  }
  check('in-blank is exactly "scanline past the visible area"', !contradiction);
  check('the scanline sweeps the whole visible frame',
    minLine === 0 && maxLine >= 480 && maxLine < 525, `min=${minLine} max=${maxLine}`);
  // A real VGA frame is ~8% blanking. Both a status stuck TRUE (the old
  // behaviour: "spin until not vblank" never returns) and one stuck FALSE
  // ("spin until vblank" never returns) are outside this band.
  check('the blanking interval is a believable share of the frame',
    inBlank > 30 && inBlank < 150, `${inBlank}/1000 ms`);

  // ---- 3. the guest-clock park (the headless model) ---------------------
  const PARKED = 1, FRAME_INTACT = 2, NO_AUTOPOP = 4, DD_OK = 8, POPPED = 16;
  e.test_vblank_reset();
  clock.now = 100;                       // next boundary is 117
  let bits = e.test_vblank_wait_once() >>> 0;
  check('a wait before the boundary parks on yield_reason 13',
    (bits & PARKED) !== 0, `bits=${bits}`);
  check('the parked call leaves its stdcall frame on the stack',
    (bits & FRAME_INTACT) !== 0, `bits=${bits}`);
  check('the parked call opts out of the thunk-zone auto-pop',
    (bits & NO_AUTOPOP) !== 0, `bits=${bits}`);

  clock.now = 110;                       // still short of 117
  bits = e.test_vblank_wait_once() >>> 0;
  check('it stays parked while the boundary is still ahead',
    (bits & PARKED) !== 0, `bits=${bits}`);
  check('the deadline it published is the boundary it named',
    (e.get_vblank_deadline_ms() >>> 0) === 117, `${e.get_vblank_deadline_ms() >>> 0}`);

  clock.now = 117;                       // the boundary arrives
  bits = e.test_vblank_wait_once() >>> 0;
  check('the wait completes once the guest clock reaches the boundary',
    (bits & PARKED) === 0, `bits=${bits}`);
  check('it returns DD_OK', (bits & DD_OK) !== 0, `bits=${bits}`);
  check('it pops the 3-argument stdcall frame', (bits & POPPED) !== 0, `bits=${bits}`);
  check('the park is disarmed for the next call',
    (e.get_vblank_wait_active() >>> 0) === 0);

  // ---- 4. the host-driven park (the browser model) ----------------------
  // In the browser the display, not the guest clock, ends the wait: host.js
  // bumps this from a requestAnimationFrame callback. The clock is deliberately
  // held still here, so a wait that ended would have to have ended on the tick.
  e.test_vblank_reset();
  clock.now = 200;
  bits = e.test_vblank_wait_once() >>> 0;
  check('a host-driven wait parks first', (bits & PARKED) !== 0, `bits=${bits}`);
  e.vblank_tick();
  bits = e.test_vblank_wait_once() >>> 0;
  check('a display tick ends the wait with the guest clock unmoved',
    (bits & PARKED) === 0 && (bits & DD_OK) !== 0, `bits=${bits}`);

  // One tick releases one wait, not every future one — otherwise a game that
  // waits twice per frame would run at double speed.
  bits = e.test_vblank_wait_once() >>> 0;
  check('the next wait parks again rather than riding the same tick',
    (bits & PARKED) !== 0, `bits=${bits}`);

  // ---- 5. the no-rAF escape hatch --------------------------------------
  // A hidden tab gets no animation frames at all. An audible app still runs,
  // and must not park forever on a vblank that will never be delivered.
  clock.now = 200 + 17 + 51;
  bits = e.test_vblank_wait_once() >>> 0;
  check('a host-driven wait still gives up if no display tick ever arrives',
    (bits & PARKED) === 0 && (bits & DD_OK) !== 0, `bits=${bits}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
