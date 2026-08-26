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
    } = opts;
    Object.assign(this, {
      canvas, exe, files, cpu, args, msPerFrame, slice, onStatus, onFrame, autoKey,
    });
    this.running = false;
    this.session = null;
    this.raf = 0;
    this.imageData = null;
    this.font = null;
    this.frames = 0;
  }

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

  async start() {
    setCpuLevel(this.cpu);
    const machine = new Machine(new Uint8Array(0), {
      autoKey: this.autoKey,
      fileRoot: '.',              // the mounted map IS the directory
      log: () => {},
    });
    const vm = await makeVm('tailcall', {
      portIn: (p, w) => machine.portIn(p, w),
      portOut: (p, v, w) => machine.portOut(p, v, w),
    });
    // The decoder's CPU level and the module's FLAGS shape have to move
    // together: a build that decodes 386 encodings but reports an 8086 FLAGS
    // register fails the CPU detection every one of these demos opens with.
    vm.exports.set_cpu(this.cpu);
    machine.setMemory(vm.mem, vm.exports);
    machine.installIvt();
    machine.setTicks(0);
    machine.syncVga();

    const raw = this.files[this.exe] || this.files[this.exe.toLowerCase()];
    if (!raw) throw new Error(`${this.exe} was not mounted`);
    // Through Buffer, always. loadExe reads the MZ header with readUInt16LE,
    // and headless it is handed the Buffer fs.readFileSync returns -- so a
    // plain Uint8Array from the page worked for every .COM (no header to
    // parse) and threw on every .EXE. In the page `Buffer` is the bundle's
    // Uint8Array subclass; here it is Node's own.
    const image = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const info = loadExe(vm.mem, image);
    // What the program was given is what is NOT free. A .COM has no header to
    // say, so the loader leaves this undefined and the machine keeps its "owns
    // everything" default.
    if (info.allocTop !== undefined) machine.allocTop = info.allocTop;
    machine.imageTop = info.minTop;
    machine.installEnvironment(this.exe, this.args);
    vm.setAll({ cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp, ds: info.ds, es: info.es });
    // The stack must hold a return address: a .COM-style `ret` exit lands on
    // the PSP's INT 20h. An EXE that ends with INT 21h/4C never touches it.
    vm.set('sp', (info.sp - 2) & 0xFFFF);
    const spLin = ((info.ss << 4) + ((info.sp - 2) & 0xFFFF)) & 0xFFFFF;
    vm.mem[spLin] = 0;
    vm.mem[spLin + 1] = 0;

    this.vm = vm;
    this.machine = machine;
    this.session = new DosSession(vm, machine, {
      slice: this.slice,
      cells: fb.conCells,
      // The hang detector is a sweep's tool: it decides a program is stuck so a
      // batch run can move on. Here the person watching is a better judge, and
      // a demo that idles on a "press a key" screen is exactly what it would
      // cut off.
      stuckLimit: 0,
    });
    this.running = true;
    this.onStatus({ state: 'running' });
    this.tick();
    return this;
  }

  // One animation frame's worth: guest work up to the budget, then paint.
  tick() {
    if (!this.running) return;
    const s = this.session;
    const deadline = performance.now() + this.msPerFrame;
    // The time check costs a call per slice, which is why the slice is not
    // tiny: at 200k dispatches it is well under a percent.
    while (!s.done && performance.now() < deadline) s.step();
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
        this.onStatus({ state: 'running' });
        this.tick();
      }
    }
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onStatus({ state: 'stopped' });
  }
}

module.exports = { LiveRun, scancodeFor, STUB_SEG, isa };
