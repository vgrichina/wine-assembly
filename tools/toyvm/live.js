'use strict';

// A DOS program running in a page, at a canvas, with a person at the keyboard.
//
// The sweep's job is to photograph a program; this one's job is to let someone
// watch it and press a key. That is a different set of decisions, and only
// those decisions live here -- the guest cycle is dos-loop.js and the pixels
// are framebuffer.js, both shared with the headless driver, so the page cannot
// drift into being a second emulator.
//
// Three things are true in a browser that are not true headless, and they are
// what this file is about:
//
//   The thread is the page's. A slice that runs to completion freezes the tab,
//   so work is chunked against a wall-clock budget per animation frame and the
//   frame is painted from whatever the guest has reached.
//
//   The keyboard is real. The sweep answers menus by reading the screen and
//   guessing; here a keypress is a keypress, and the whole answering apparatus
//   is off by default.
//
//   Nothing is a file. The caller mounts a directory's worth of bytes and the
//   shim's `fs` reads from that, which is what dos.js already wants.

const isa = require('./isa');
const { makeVm } = require('./vm');
const { setCpuLevel } = require('./decode');
const { Machine, loadExe, STUB_SEG } = require('./dos');
const { DosSession } = require('./dos-loop');
const fb = require('./framebuffer');

// A key, as the BIOS reports it: the scancode in the high byte, the ASCII in
// the low one. Only the keys a demo actually waits on -- which in this corpus
// is Escape, Enter, Space, the digits and the letters, plus the arrows for the
// handful with a menu you steer.
const SCAN = {
  Escape: 0x01, Enter: 0x1C, Backspace: 0x0E, Tab: 0x0F, ' ': 0x39,
  ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4B, ArrowRight: 0x4D,
  F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
};
const LETTERS = 'qwertyuiop[]\r\0asdfghjkl;\'`\0\\zxcvbnm,./';
const DIGITS = '1234567890-=';

// Does this engine have the wasm tail-call proposal? A two-function module
// where f0 is `return_call 1` and f1 returns a constant -- valid only if the
// engine implements it. Memoized: the answer cannot change within a page, and
// `validate` on a 30-byte module is cheap but not free.
let tailCallOk = null;
function hasTailCalls() {
  if (tailCallOk !== null) return tailCallOk;
  try {
    tailCallOk = WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,   // magic + version
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,         // type: () -> i32
      0x03, 0x03, 0x02, 0x00, 0x00,                     // two funcs of that type
      0x0a, 0x0b, 0x02,                                 // code: two bodies
      0x04, 0x00, 0x12, 0x01, 0x0b,                     //   f0: return_call 1
      0x04, 0x00, 0x41, 0x07, 0x0b,                     //   f1: i32.const 7
    ]));
  } catch { tailCallOk = false; }
  return tailCallOk;
}

function pickVariant() {
  return hasTailCalls() ? 'tailcall' : 'calls';
}

function scancodeFor(key) {
  if (SCAN[key] !== undefined) return SCAN[key];
  if (key.length !== 1) return 0;
  const c = key.toLowerCase();
  const d = DIGITS.indexOf(c);
  if (d >= 0) return 0x02 + d;
  const l = LETTERS.indexOf(c);
  return l >= 0 ? 0x10 + l : 0;
}

// One live program. `start()` mounts it and begins; `stop()` gives the thread
// back for good.
class LiveRun {
  constructor(opts) {
    const {
      canvas, exe, files = {}, cpu = 386, args = '',
      // Wall-clock milliseconds of guest work per animation frame. 8ms of a
      // 16ms frame leaves the browser its half and still gets tens of millions
      // of dispatches a second on anything modern. It is the one knob between
      // "the demo crawls" and "the tab stutters".
      msPerFrame = 8,
      // Guest dispatches per slice. Small enough that the ms budget can stop
      // between slices rather than inside one -- a 2M slice on a tight loop is
      // several milliseconds on its own and would overshoot the frame.
      slice = 2e5,
      onStatus = () => {}, onFrame = () => {},
      // The sweep's screen-reading menu answerer. Off here: there is a person.
      autoKey = false,
      // Which dispatch shell to build. Default is whatever this engine can
      // compile -- see pickVariant. Overridable so a test can exercise the
      // fallback on an engine that would never choose it, which is the only way
      // that path gets run outside an old Safari.
      variant = null,
      // How fast the emulated machine is, in millions of dispatches per guest
      // second -- a dispatch is close to an instruction, so this is MIPS. 10
      // is a fast 486, the part these demos were written for, and the number
      // the headless clock already assumes (550k dispatches to a 55ms tick).
      // Every guest clock derives from it: the tick word, the timer interrupt
      // at the PIT's reload, the 70Hz retrace, the sample rate of a transfer.
      mips = 10,
      // Whether wall time paces the guest at that speed. Unpaced, the guest
      // gets every millisecond of msPerFrame and a 7M-dispatch demo is over
      // in a second; paced, one wall second is one guest second.
      paced = true,
      // Sound out. `audioContext` is the page's, created inside the click that
      // pressed Run (browsers refuse one created anywhere else); without it
      // the machine still consumes its samples and nothing is heard. `sound`
      // is the mute: off keeps everything running and disconnects the output.
      audioContext = null, sound = true,
      // What the menu answerer picks on a sound menu -- see Machine.soundPref.
      soundPref = 'sb',
      // Extra environment lines ("ULTRASND=240,1,1,11,7") and which card the
      // machine has ('full' or 'none'): the sweep's per-program findings,
      // carried on the tile. `sound` above is the page's mute; `card` is the
      // machine's hardware, and a program that only draws without a card
      // gets none whatever the mute says.
      env = [], card = 'full',
      // Where DOS puts this program, in paragraphs -- the machine setting the
      // corpus registry carries for the one demo that needs a different one.
      // It reaches the page through programs-index.json, so the tile and the
      // CLI mount the same machine; see tools/toyvm/program-config.js.
      pspSeg = 0, loadSeg = 0,
      // The region JIT (tools/toyvm/region-live.js), off by default. On, the
      // run profiles itself, sends the profile to a Worker that picks a hot
      // loop, audits a compiled version of it against the interpreter and
      // compiles a module with it, and swaps the running program onto that
      // module. `jitUrl` is where that Worker gets its code -- the JIT bundle
      // beside the page's own -- and without one there is no Worker to run in,
      // so the JIT reports itself unavailable and the demo runs interpreted.
      // `jitBackend` overrides both, which is how a test drives the whole
      // pipeline in-process.
      jit = false, jitUrl = null, jitBackend = null, jitOptions = {},
    } = opts;
    Object.assign(this, {
      canvas, exe, files, cpu, args, msPerFrame, slice, onStatus, onFrame, autoKey,
      variant, mips, paced, audioContext, sound, soundPref, env, card,
      pspSeg, loadSeg,
      jitWanted: jit, jitUrl, jitBackend, jitOptions,
    });
    this.jit = null;
    this.running = false;
    this.session = null;
    this.raf = 0;
    this.imageData = null;
    this.font = null;
    this.frames = 0;
    // Pacing: dispatches owed to the guest by the wall clock, and when it was
    // last consulted.
    this.owed = 0;
    this.lastTick = 0;
    this.stalls = 0;              // frames the host could not keep pace
    this.budgetMs = this.msPerFrame;   // this frame's guest budget; see tick
    this.maxBudgetMs = 14;             // of a 16.7ms frame: the rest is the browser's
    // Audio: the ring the machine renders into and the node that drains it.
    this.ring = null;
    this.node = null;
  }

  // Dispatches per guest second.
  get speed() { return this.mips * 1e6; }

  // The ROM text font, if the bundle carried one. Text-mode programs are drawn
  // with it; a graphics-mode one never asks.
  loadFont() {
    if (this.font !== null) return this.font;
    try {
      const { readStrikes, pickStrike } = require('../fnt-read');
      this.font = pickStrike(readStrikes('fonts/Terminal.fon'), 12) || null;
    } catch {
      this.font = null;   // no font available: attributes still draw
    }
    return this.font;
  }

  // Which dispatch shell this engine can actually compile.
  //
  // `tailcall` is the shipped one and the fastest, but every handler in it ends
  // in `return_call_indirect` -- the WebAssembly tail-call proposal, which
  // JavaScriptCore only shipped in Safari 18.2. On anything older the whole
  // module fails to compile, and from the page that is indistinguishable from a
  // Run button that does nothing: no pixels, no dispatches, and an exception
  // raised long before any of this code could report on it. That is exactly
  // what a Safari on macOS Sonoma does, whose Safari tops out at 17.6.
  //
  // `calls` is the fallback because it is the shell with no feature
  // requirements at all -- a plain `call_indirect` in a loop, which every wasm
  // engine has had since 2017. It measured 3.8% slower than `tailcall` across
  // ten demos, which is not a difference anybody watching a demo can see.
  //
  // Probed, not sniffed. A four-byte module that uses `return_call` is the
  // ground truth; a user-agent string is a guess about a version table.
  async start() {
    setCpuLevel(this.cpu);
    const machine = new Machine(new Uint8Array(0), {
      pspSeg: this.pspSeg, loadSeg: this.loadSeg,
      autoKey: this.autoKey,
      soundPref: this.soundPref,
      env: this.env,
      sound: this.card,
      fileRoot: '.',              // the mounted map IS the directory
      log: () => {},
    });
    // Named, because a region install instantiates a SECOND module over this
    // memory and has to import the same two closures: a fresh pair built there
    // would be a machine the page's peripherals are not attached to, and the
    // failure is silent -- the demo simply stops hearing its own hardware.
    const portIn = (p, w) => machine.portIn(p, w);
    const portOut = (p, v, w) => machine.portOut(p, v, w);
    const vm = await makeVm(this.variant || pickVariant(), { portIn, portOut });
    // The decoder's CPU level and the module's FLAGS shape have to move
    // together: a build that decodes 386 encodings but reports an 8086 FLAGS
    // register fails the CPU detection every one of these demos opens with.
    vm.exports.set_cpu(this.cpu);
    machine.setMemory(vm.mem, vm.exports);
    machine.installIvt();
    machine.setTicks(0, { force: true });
    machine.syncVga();

    const raw = this.files[this.exe] || this.files[this.exe.toLowerCase()];
    if (!raw) throw new Error(`${this.exe} was not mounted`);
    // Through Buffer, always. loadExe reads the MZ header with readUInt16LE,
    // and headless it is handed the Buffer fs.readFileSync returns -- so a
    // plain Uint8Array from the page worked for every .COM (no header to
    // parse) and threw on every .EXE. In the page `Buffer` is the bundle's
    // Uint8Array subclass; here it is Node's own.
    const image = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const info = loadExe(vm.mem, image,
      { loadSeg: machine.loadSeg, pspSeg: machine.pspSeg });
    // What the program was given is what is NOT free. A .COM has no header to
    // say, so the loader leaves this undefined and the machine keeps its "owns
    // everything" default.
    if (info.allocTop !== undefined) machine.allocTop = info.allocTop;
    machine.imageTop = info.minTop;
    machine.installEnvironment(this.exe, this.args);
    // After the environment and after allocTop: the chain names both.
    machine.installArena();
    // IF set, as DOS hands it over -- see the same line in run-dos.js. The page
    // and the headless runner have to agree about this or a program that needs
    // a hardware interrupt behaves differently in the two.
    vm.setAll({ cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp, ds: info.ds, es: info.es,
      flags: isa.FLAGS_RESERVED | (1 << isa.F.IF) });
    // The stack must hold a return address: a .COM-style `ret` exit lands on
    // the PSP's INT 20h. An EXE that ends with INT 21h/4C never touches it.
    vm.set('sp', (info.sp - 2) & 0xFFFF);
    const spLin = ((info.ss << 4) + ((info.sp - 2) & 0xFFFF)) & 0xFFFFF;
    vm.mem[spLin] = 0;
    vm.mem[spLin + 1] = 0;

    this.vm = vm;
    this.machine = machine;
    // One clock for everything, at the speed asked for. 65536 PIT pulses to a
    // BIOS tick, 18.2 of those to a second.
    const dispatchesPerTick = Math.round(this.speed * 65536 / 1193182);
    this.session = new DosSession(vm, machine, {
      slice: this.slice,
      cells: fb.conCells,
      pitClock: true,
      dispatchesPerTick,
      irqEvery: dispatchesPerTick,
      // The hang detector is a sweep's tool: it decides a program is stuck so a
      // batch run can move on. Here the person watching is a better judge, and
      // a demo that idles on a "press a key" screen is exactly what it would
      // cut off.
      stuckLimit: 0,
      // The JIT's profiler, and nothing else on this path: one map insert per
      // slice while it is profiling, and an early return once it is not.
      hooks: { afterSlice: (ev) => { if (this.jit) this.jit.sample(ev); } },
    });
    // Kept so the JIT can be switched on later without restarting the program:
    // a second module instantiated over this memory has to import these exact
    // closures (see makeVm above).
    this.ports = { portIn, portOut };
    if (this.jitWanted) this.startJit({ portIn, portOut });
    this.attachAudio();
    this.running = true;
    this.owed = 0;
    this.lastTick = performance.now();
    this.onStatus({ state: 'running' });
    this.tick();
    return this;
  }

  // The machine renders into a ring at the context's rate and a script
  // processor drains it on the audio thread's schedule. A ScriptProcessorNode
  // rather than a worklet because a worklet is a module loaded by URL, and
  // from a file:// page there is no URL to load it from -- the same reason the
  // emulator arrives by <script> tag.
  attachAudio() {
    const ctx = this.audioContext;
    if (!ctx || typeof ctx.createScriptProcessor !== 'function') return;
    const rate = ctx.sampleRate;
    const ring = new AudioRing(rate, 2);
    this.ring = ring;
    this.machine.audio.rate = rate;
    this.machine.audio.sink = (buf, frames) => ring.write(buf, frames);
    // One input channel, with a silent source on it, and not zero: WebKit
    // never calls onaudioprocess on a ScriptProcessorNode that has no input
    // feeding it, so a node made with (2048, 0, 2) plays in Chrome and is
    // silent in Safari with nothing to say so.
    const node = ctx.createScriptProcessor(2048, 1, 2);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer;
      ring.pulls++;
      ring.read(out.getChannelData(0), out.getChannelData(1), out.length);
    };
    let feed = null;
    try {
      if (typeof ctx.createConstantSource === 'function') {
        feed = ctx.createConstantSource();
        feed.offset.value = 0;
      } else {
        feed = ctx.createBufferSource();
        feed.buffer = ctx.createBuffer(1, 2048, rate);
        feed.loop = true;
      }
      feed.connect(node);
      feed.start();
    } catch (e) { feed = null; }
    this.feed = feed;
    this.node = node;
    // A quarter second of lead so a frame the browser drops does not become
    // a gap in the sound.
    ring.prime(Math.round(rate / 4));
    if (this.sound) node.connect(ctx.destination);
  }

  // Start the region JIT over this run, if there is somewhere to compile.
  //
  // The backend is a WORKER or it is nothing. Preparing a region costs about
  // two and a half seconds -- an audit that builds a second emulator, then an
  // emit and a compile of the whole module -- and none of that is divisible
  // into frame-sized pieces. On the page's thread it is a two-second freeze of
  // the very demo it was meant to speed up, so where a worker cannot be built
  // (a file:// page cannot build one at all) the JIT reports itself unavailable
  // and the run stays interpreted, which is what it would have been anyway.
  startJit({ portIn, portOut } = this.ports || {}) {
    const { LiveJit, workerBackend } = require('./region-live');
    const backend = this.jitBackend || workerBackend(this.jitUrl);
    if (!backend) {
      this.jitUnavailable = 'no Worker to compile in (a file:// page cannot make one)';
      return null;
    }
    this.jit = new LiveJit({
      session: this.session, vm: this.vm, machine: this.machine, portIn, portOut,
      backend, cpu: this.cpu, log: () => {}, ...this.jitOptions,
    });
    return this.jit;
  }

  // Turn the JIT on or off while the program runs. Off with a region already
  // installed UNINSTALLS it -- the point of the switch is to be able to see the
  // interpreted picture again, and leaving the compiled loop in place would
  // make the off position a lie.
  setJit(on) {
    this.jitWanted = !!on;
    if (on && !this.jit && this.session) return this.startJit();
    if (!on && this.jit) {
      if (this.jit.phase === 'installed') this.jit.uninstall('switched off');
      this.jit.stop();
      this.jit = null;
    }
    return this.jit;
  }

  // What the JIT is doing, for the status line. `null` when it was never asked
  // for; a `phase` of 'unavailable' when it was and there was nowhere to run
  // it, which is a different answer from "found nothing worth compiling".
  jitStats() {
    if (this.jit) return this.jit.stats();
    if (this.jitWanted) return { phase: 'unavailable', declined: this.jitUnavailable };
    return null;
  }

  // What the sound path is doing, for the status line: null without a
  // context, else the context's state and rate, how many times the browser
  // has pulled a buffer, and how many of those found the ring empty.
  audioStats() {
    const ctx = this.audioContext;
    if (!ctx || !this.ring) return null;
    return {
      state: ctx.state, rate: ctx.sampleRate, pulls: this.ring.pulls,
      underruns: this.ring.underruns, rendered: this.machine.audio.rendered,
      sb: this.machine.sb.irqs, opl: this.machine.audio.opl.keyOns,
      speaker: this.machine.audio.speakerWrites,
      gus: this.machine.gus ? this.machine.gus.stats.starts : 0,
      budgetMs: this.budgetMs,
    };
  }

  // Mute or unmute. The machine keeps rendering either way, so a demo's
  // block-done interrupts do not depend on whether anyone is listening.
  setSound(on) {
    this.sound = !!on;
    if (!this.node) return;
    if (this.sound) this.node.connect(this.audioContext.destination);
    else this.node.disconnect();
  }

  // Real time or flat out; takes effect at the next frame.
  setPaced(paced) {
    this.paced = !!paced;
    this.owed = 0;
    this.lastTick = performance.now();
  }

  // One animation frame's worth: guest work up to the budget, then paint.
  //
  // Paced, the budget is dispatches, not milliseconds: the wall clock says how
  // much guest time has passed since the last frame and the guest gets that
  // many dispatches at its speed, whatever the host could manage. The ms
  // deadline is still there as the ceiling -- a host too slow to keep up
  // hands the thread back anyway, and the guest simply runs slow, which is
  // what a demo on an underpowered machine always did. The debt is capped
  // at a tenth of a second so a tab that was in the background does not come
  // back with a burst of catch-up.
  tick() {
    if (!this.running) return;
    const s = this.session;
    const now = performance.now();
    const deadline = now + this.budgetMs;
    let allow = Infinity;
    if (this.paced) {
      const elapsed = Math.min(Math.max(0, now - this.lastTick), 100);
      this.lastTick = now;
      this.owed = Math.min(this.owed + elapsed * this.speed / 1000, this.speed / 10);
      allow = this.owed;
    }
    const start = s.dispatched;
    // The time check costs a call per slice, which is why the slice is not
    // tiny: at 200k dispatches it is well under a percent.
    while (!s.done && s.dispatched - start < allow && performance.now() < deadline) s.step();
    if (this.paced) {
      const ran = s.dispatched - start;
      // Overshoot is carried: a slice is up to a few tens of thousands of
      // dispatches and the next frame owes that much less.
      this.owed -= ran;
      const stalled = ran < allow && !s.done && performance.now() >= deadline;
      if (stalled) this.stalls++;
      // The budget breathes. A CPU profile of the page running CYCLE.EXE had
      // the main thread IDLE 50% of the time while the audio ring underran
      // on 58% of its pulls: at a fixed 8ms of every 16.7ms frame the guest
      // can never use more than half the machine, so a demo that costs 9ms
      // of host time per guest frame falls behind forever with the other
      // half of the frame unused. A stalled frame raises the next frame's
      // budget, a kept one lets it sink back to msPerFrame, and the ceiling
      // still leaves the browser a few ms to composite and pull audio. A
      // demo that keeps pace never sees anything but msPerFrame.
      this.budgetMs = stalled
        ? Math.min(this.budgetMs * 1.5, this.maxBudgetMs)
        : Math.max(this.msPerFrame, this.budgetMs - 1);
    }
    // BETWEEN slices, never inside one: an install swaps the wasm instance out
    // from under the run loop. `pump` never blocks -- while the worker is
    // preparing a region it returns immediately and the guest keeps going --
    // and once one is installed all it does is compare the region's guest bytes
    // against memory, which is what catches a program that rewrites its own
    // hot loop.
    if (this.jit) this.jit.pump();
    this.paint();
    this.frames++;
    if (s.done) {
      this.running = false;
      this.onStatus({
        state: this.machine.exited ? 'exited' : 'waiting',
        dispatched: s.dispatched,
      });
      return;
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }

  // A tap on the screen from a device with no keyboard: Enter, but only when
  // the program is waiting for a key, so a tap on a running demo is not a
  // stray keystroke into it.
  tap() {
    if (!this.machine || !this.machine.blockedOnKey) return;
    this.key({ key: 'Enter' });
  }

  // Draw whatever surface the program is currently on, nearest-neighbour, to
  // fill the canvas. The canvas keeps the guest's own resolution as its backing
  // store and CSS does the scaling -- `image-rendering: pixelated` on the
  // element is what makes a 320x200 demo look like a 320x200 demo instead of a
  // blurred one.
  paint() {
    const surface = fb.screenSurface(this.machine);
    const out = surface.text
      ? fb.rgbaConsole(this.machine.con, this.loadFont())
      : fb.rgbaFrame(this.vm.mem, this.machine.palette, surface.geom);
    const cv = this.canvas;
    if (cv.width !== out.width || cv.height !== out.height) {
      cv.width = out.width;
      cv.height = out.height;
      this.imageData = null;
    }
    const ctx = cv.getContext('2d');
    if (!this.imageData) this.imageData = ctx.createImageData(out.width, out.height);
    this.imageData.data.set(out.rgba);
    ctx.putImageData(this.imageData, 0, 0);
    this.onFrame({ text: surface.text, width: out.width, height: out.height });
  }

  // A keystroke from the page. Both halves are delivered: the BIOS queue for a
  // program that calls INT 16h, and the scancode at port 60h for one that reads
  // the hardware itself. Which of those a demo uses is not knowable from here,
  // and a demo that reads the port sees nothing at all through the BIOS.
  key(ev) {
    if (!this.machine) return;
    const scan = scancodeFor(ev.key);
    const ascii = ev.key.length === 1 ? ev.key.charCodeAt(0) & 0xFF
      : (ev.key === 'Enter' ? 13 : ev.key === 'Escape' ? 27 : ev.key === 'Tab' ? 9 : 0);
    this.machine.pushKey(scan, ascii);
    // A program that stopped for a key can go again now.
    if (this.machine.blockedOnKey) {
      this.machine.blockedOnKey = false;
      if (!this.running && !this.machine.exited) {
        this.running = true;
        this.owed = 0;
        this.lastTick = performance.now();
        this.onStatus({ state: 'running' });
        this.tick();
      }
    }
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.feed) { try { this.feed.stop(); this.feed.disconnect(); } catch { /* already */ } this.feed = null; }
    if (this.node) { try { this.node.disconnect(); } catch { /* already */ } this.node = null; }
    if (this.machine) this.machine.audio.sink = null;
    // The JIT's worker is a thread of its own and does not stop with the run
    // loop: a demo stopped mid-preparation would leave one compiling a module
    // for a program nobody is watching.
    if (this.jit) { this.jit.stop(); this.jit = null; }
    this.onStatus({ state: 'stopped' });
  }
}

// Interleaved stereo frames between the machine (which writes a slice's worth
// at a time, on the main thread) and the audio callback (which reads a fixed
// block, on its own schedule). Underruns read as silence and are counted;
// a writer that gets ahead of the capacity drops what does not fit, which
// only happens unpaced.
class AudioRing {
  constructor(rate, seconds) {
    this.frames = Math.round(rate * seconds);
    this.buf = new Float32Array(this.frames * 2);
    this.w = 0;                   // frames written, ever
    this.r = 0;                   // frames read, ever
    this.underruns = 0;
    this.dropped = 0;
    this.pulls = 0;               // buffers the browser has asked for
  }

  get available() { return this.w - this.r; }

  prime(frames) { this.w += Math.min(frames, this.frames); }

  write(src, frames) {
    let n = frames;
    if (this.available + n > this.frames) { this.dropped += n; return; }
    let o = 0;
    while (n > 0) {
      const at = (this.w % this.frames) * 2;
      const run = Math.min(n, this.frames - (this.w % this.frames));
      this.buf.set(src.subarray(o, o + run * 2), at);
      o += run * 2; n -= run; this.w += run;
    }
  }

  read(left, right, frames) {
    let i = 0;
    const have = Math.min(frames, this.available);
    while (i < have) {
      const at = (this.r % this.frames) * 2;
      left[i] = this.buf[at]; right[i] = this.buf[at + 1];
      i++; this.r++;
    }
    if (i < frames) {
      this.underruns++;
      for (; i < frames; i++) { left[i] = 0; right[i] = 0; }
    }
  }
}

module.exports = { LiveRun, scancodeFor, STUB_SEG, isa, hasTailCalls, pickVariant };
