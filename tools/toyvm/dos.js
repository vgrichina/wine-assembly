'use strict';

// A DOS/BIOS/VGA machine around the toy VM, big enough to run a real mode-13h
// intro off pouet.
//
// The VM itself knows nothing about DOS. Everything a guest reaches for that is
// not an x86 instruction arrives here by one of two routes:
//
//   * software interrupts. The IVT is real -- INT vectors through it the way
//     the hardware does -- but every vector we service points into a stub
//     segment whose first byte the decoder deliberately refuses. The trace ends
//     there, the run loop sees a guest IP inside the stub region, services the
//     call in JS and performs the IRET itself. A guest that installs its OWN
//     handler (INT 21h/25h) overwrites the vector and stops coming here at all,
//     which is exactly right.
//
//   * ports. Only the handful a demo actually touches are modelled: the VGA DAC
//     write path at 0x3C8/0x3C9, the input status register at 0x3DA (whose
//     retrace bits are what a demo spins on), and the sequencer/CRTC index
//     pairs far enough to not hang a mode set.
//
// Video memory needs no modelling at all: A000:0000 is inside the 1MB of guest
// RAM, so a demo's writes land in the same Uint8Array we screenshot from.

const fs = require('fs');
const isa = require('./isa');

const VGA_BASE = 0xA0000;
const STUB_SEG = 0xF000;      // vector v points at F000:v, one refused byte
const STUB_BYTE = 0xF1;       // ICEBP -- not decoded, so the trace stops on it
const PSP_SEG = 0x0100;
const LOAD_SEG = 0x0110;      // PSP is 0x100 bytes = 0x10 paragraphs
const DEFAULT_ALLOC_TOP = 0x9000;

// ---------------------------------------------------------------------------
// MZ loader
// ---------------------------------------------------------------------------
// Relocations are the whole reason this cannot be a flat read: an EXE's far
// pointers are stored relative to the load segment and have to be fixed up
// before anything far runs.
function loadExe(mem, buf, { loadSeg = LOAD_SEG, pspSeg = PSP_SEG } = {}) {
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) throw new Error('not an MZ executable');
  const u16 = (o) => buf.readUInt16LE(o);
  const lastPage = u16(0x02), pages = u16(0x04);
  const relocCount = u16(0x06), headerParas = u16(0x08);
  const ss = u16(0x0E), sp = u16(0x10);
  const ip = u16(0x14), cs = u16(0x16);
  const relocOff = u16(0x18);

  const headerBytes = headerParas * 16;
  let imageBytes = pages * 512 - headerBytes;
  if (lastPage) imageBytes -= (512 - lastPage);
  const image = buf.subarray(headerBytes, headerBytes + imageBytes);

  const loadLin = loadSeg << 4;
  mem.set(image, loadLin);

  for (let i = 0; i < relocCount; i++) {
    const off = u16(relocOff + i * 4);
    const seg = u16(relocOff + i * 4 + 2);
    const at = loadLin + (seg << 4) + off;
    const v = (mem[at] | (mem[at + 1] << 8)) + loadSeg;
    mem[at] = v & 0xFF;
    mem[at + 1] = (v >> 8) & 0xFF;
  }

  // A minimal PSP. INT 20h at offset 0 and the "bytes in segment" word are the
  // two fields a small intro is actually likely to read.
  const psp = pspSeg << 4;
  mem[psp] = 0xCD; mem[psp + 1] = 0x20;
  mem[psp + 2] = DEFAULT_ALLOC_TOP & 0xFF;
  mem[psp + 3] = (DEFAULT_ALLOC_TOP >> 8) & 0xFF;
  mem[psp + 0x80] = 0;              // empty command tail
  mem[psp + 0x81] = 0x0D;

  return {
    cs: (cs + loadSeg) & 0xFFFF, ip,
    ss: (ss + loadSeg) & 0xFFFF, sp,
    ds: pspSeg, es: pspSeg,
    loadSeg, pspSeg, imageBytes,
  };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------
class Machine {
  constructor(mem, opts = {}) {
    this.mem = mem;
    this.log = opts.log || (() => {});
    this.videoMode = 3;
    this.palette = new Uint8Array(768);
    this.dacWriteIndex = 0;
    this.dacSubIndex = 0;
    this.retraceToggle = 0;
    this.ticks = 0;
    this.exited = false;
    this.exitCode = 0;
    this.keys = opts.keys ? [...opts.keys] : [];   // queued as {ah, al}
    this.autoKey = !!opts.autoKey;
    this.mouse = { x: 160, y: 100, buttons: 0, dx: 0, dy: 0 };
    this.allocTop = DEFAULT_ALLOC_TOP;
    this.unhandled = new Map();
    this.intCount = new Map();

    this.installIvt();
    // BIOS data area: video mode byte and the 55ms tick counter at 0040:006C,
    // which is where a demo reads time from when it does not hook INT 8.
    mem[0x449] = this.videoMode;
    this.setTicks(0);
  }

  installIvt() {
    for (let v = 0; v < 256; v++) {
      const at = v * 4;
      this.mem[at] = v;                     // offset = vector number
      this.mem[at + 1] = 0;
      this.mem[at + 2] = STUB_SEG & 0xFF;
      this.mem[at + 3] = STUB_SEG >> 8;
      this.mem[(STUB_SEG << 4) + v] = STUB_BYTE;
    }
  }

  setTicks(t) {
    this.ticks = t >>> 0;
    const at = 0x46C;
    this.mem[at] = this.ticks & 0xFF;
    this.mem[at + 1] = (this.ticks >> 8) & 0xFF;
    this.mem[at + 2] = (this.ticks >> 16) & 0xFF;
    this.mem[at + 3] = (this.ticks >> 24) & 0xFF;
  }

  // --- ports ---------------------------------------------------------------
  portIn(port, w) {
    if (port === 0x3DA) {
      // Bit 3 is vertical retrace, bit 0 "display disabled". A demo that waits
      // for retrace to start needs to see the bit both clear and set or it
      // spins forever, so this alternates on every read.
      this.retraceToggle ^= 1;
      return this.retraceToggle ? 0x09 : 0x00;
    }
    if (port === 0x3C9) {
      const v = this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return v;
    }
    if (port === 0x60) return 0;            // keyboard data: no key down
    if (port === 0x40 || port === 0x41 || port === 0x42) return (this.ticks * 13) & 0xFF;
    return w === 16 ? 0xFFFF : 0xFF;
  }

  portOut(port, value, w) {
    if (w === 16) { this.portOut(port, value & 0xFF, 8); this.portOut(port + 1, (value >> 8) & 0xFF, 8); return; }
    value &= 0xFF;
    if (port === 0x3C8) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C7) { this.dacWriteIndex = value; this.dacSubIndex = 0; return; }
    if (port === 0x3C9) {
      this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] = value & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return;
    }
    // Everything else is accepted and dropped. A mode-13h demo writes the
    // sequencer and CRTC only when it is building a tweaked mode, which is a
    // different feature entirely (unchained "mode X") and would need real
    // planar addressing to be worth modelling.
  }

  // --- interrupts ----------------------------------------------------------
  // Returns true if the interrupt was serviced, false if it is one we do not
  // know -- an unknown one is counted and IRETed, which is what a bare machine
  // with no handler installed effectively does.
  service(vec, r) {
    this.intCount.set(vec, (this.intCount.get(vec) || 0) + 1);
    const ah = (r.get('ax') >> 8) & 0xFF, al = r.get('ax') & 0xFF;

    switch (vec) {
      case 0x10: return this.int10(ah, al, r);
      case 0x16: return this.int16(ah, r);
      case 0x1A:
        if (ah === 0x00) {
          r.set('cx', (this.ticks >> 16) & 0xFFFF);
          r.set('dx', this.ticks & 0xFFFF);
          r.set('ax', 0);
          return true;
        }
        return false;
      case 0x20: this.exited = true; this.exitCode = 0; return true;
      case 0x21: return this.int21(ah, al, r);
      case 0x33: return this.int33(r);
      default: {
        const n = this.unhandled.get(vec) || 0;
        this.unhandled.set(vec, n + 1);
        return false;
      }
    }
  }

  int10(ah, al, r) {
    if (ah === 0x00) {
      this.videoMode = al & 0x7F;
      this.mem[0x449] = this.videoMode;
      // Setting a mode clears the display. Mode 13h is 320x200 linear at A000.
      if (this.videoMode === 0x13) this.mem.fill(0, VGA_BASE, VGA_BASE + 320 * 200);
      this.log(`int10 set mode ${this.videoMode.toString(16)}h`);
      return true;
    }
    if (ah === 0x0F) {                      // get current mode
      r.set('ax', (this.videoMode & 0xFF) | (80 << 8));
      r.set('bx', (r.get('bx') & 0x00FF));
      return true;
    }
    if (ah === 0x10 && al === 0x12) {       // set block of DAC registers
      const first = r.get('bx') & 0xFFFF, count = r.get('cx') & 0xFFFF;
      const src = ((r.get('es') << 4) + r.get('dx')) & 0xFFFFF;
      for (let i = 0; i < count * 3; i++) this.palette[(first * 3 + i) % 768] = this.mem[(src + i) & 0xFFFFF] & 0x3F;
      return true;
    }
    if (ah === 0x0B || ah === 0x02 || ah === 0x06 || ah === 0x09 || ah === 0x0E) return true;
    if (ah === 0x08) { r.set('ax', 0x0720); return true; }   // read char+attr: a blank
    if (ah === 0x03) { r.set('cx', 0x0607); r.set('dx', 0); return true; }  // cursor at 0,0
    if (ah === 0x12 || ah === 0x1A) { r.set('ax', 0); return true; }
    return false;
  }

  int16(ah, r) {
    if (ah === 0x00 || ah === 0x10) {
      const k = this.keys.shift()
        // A blocking read with an empty queue is where a "press any key" title
        // screen parks forever. autoKey answers it with Enter so a headless run
        // gets past the prompt; a demo that treats any key as "quit" will quit,
        // which is itself the answer to whether it can be benchmarked.
        || (this.autoKey ? { ah: 0x1C, al: 0x0D } : null);
      if (!k) { r.set('ax', 0); return true; }   // no key: report nothing
      r.set('ax', ((k.ah & 0xFF) << 8) | (k.al & 0xFF));
      return true;
    }
    if (ah === 0x01 || ah === 0x11) {
      const k = this.keys[0];
      // ZF set means "no key waiting". The caller reads it out of the flags the
      // IRET restores, so this has to land in the SAVED flags, not the live
      // ones -- runDos handles that via r.setResultZf.
      r.setResultZf(!k);
      if (k) r.set('ax', ((k.ah & 0xFF) << 8) | (k.al & 0xFF));
      return true;
    }
    if (ah === 0x02) { r.set('ax', (r.get('ax') & 0xFF00)); return true; }  // no shift keys
    return false;
  }

  int21(ah, al, r) {
    switch (ah) {
      case 0x4C: this.exited = true; this.exitCode = al; return true;
      case 0x00: this.exited = true; this.exitCode = 0; return true;
      case 0x30: r.set('ax', 0x0006); r.set('bx', 0); r.set('cx', 0); return true;  // "DOS 6.0"
      case 0x25: {                              // set interrupt vector
        const v = al * 4;
        const off = r.get('dx'), seg = r.get('ds');
        this.mem[v] = off & 0xFF; this.mem[v + 1] = off >> 8;
        this.mem[v + 2] = seg & 0xFF; this.mem[v + 3] = seg >> 8;
        return true;
      }
      case 0x35: {                              // get interrupt vector
        const v = al * 4;
        r.set('bx', this.mem[v] | (this.mem[v + 1] << 8));
        r.set('es', this.mem[v + 2] | (this.mem[v + 3] << 8));
        return true;
      }
      case 0x09: {                              // print $-terminated string
        let p = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF, s = '';
        while (this.mem[p] !== 0x24 && s.length < 4096) s += String.fromCharCode(this.mem[p++]);
        this.log(`dos print: ${s}`);
        return true;
      }
      case 0x02: this.log(`dos putc: ${String.fromCharCode(r.get('dx') & 0xFF)}`); return true;
      // Console input, the DOS-side twins of INT 16h AH=00. AH=06 with DL!=0xFF
      // is output, not input; only 0xFF asks for a character and it must report
      // "nothing waiting" through ZF rather than blocking.
      case 0x01: case 0x07: case 0x08: {
        const k = this.keys.shift() || (this.autoKey ? { ah: 0x1C, al: 0x0D } : null);
        r.set('ax', (r.get('ax') & 0xFF00) | (k ? k.al & 0xFF : 0));
        return true;
      }
      case 0x06: {
        const dl = r.get('dx') & 0xFF;
        if (dl !== 0xFF) { this.log(`dos putc: ${String.fromCharCode(dl)}`); return true; }
        const k = this.keys.shift() || (this.autoKey ? { ah: 0x1C, al: 0x0D } : null);
        r.setResultZf(!k);
        r.set('ax', (r.get('ax') & 0xFF00) | (k ? k.al & 0xFF : 0));
        return true;
      }
      case 0x0B: {                              // check standard input status
        r.set('ax', (r.get('ax') & 0xFF00) | (this.keys.length ? 0xFF : 0x00));
        return true;
      }
      case 0x0C: {                              // flush buffer, then one of the above
        this.keys.length = 0;
        return al === 0x01 || al === 0x06 || al === 0x07 || al === 0x08 || al === 0x0A
          ? this.int21(al, 0xFF, r) : true;
      }
      case 0x44: {
        // IOCTL. Only AL=00, "get device information", is asked often enough to
        // matter: a demo uses it to find out whether stdout is a file or the
        // console. DX bit 7 set means character device.
        if (al === 0x00) { r.set('dx', 0x80D3); r.setResultCf(false); return true; }
        r.setResultCf(true); r.set('ax', 1);    // "invalid function"
        return true;
      }
      case 0x48: {                              // allocate paragraphs
        const want = r.get('bx') & 0xFFFF;
        if (this.allocTop + want > 0x9FFF) { r.setResultCf(true); r.set('ax', 8); r.set('bx', 0x9FFF - this.allocTop); return true; }
        r.set('ax', this.allocTop);
        this.allocTop += want;
        r.setResultCf(false);
        return true;
      }
      case 0x49: r.setResultCf(false); return true;   // free
      case 0x4A: r.setResultCf(false); return true;   // resize
      case 0x1A: this.dta = ((r.get('ds') << 4) + r.get('dx')) & 0xFFFFF; return true;
      case 0x2C: {                              // get time
        const t = this.ticks * 55;
        r.set('cx', (Math.floor(t / 3600000) << 8) | (Math.floor(t / 60000) % 60));
        r.set('dx', ((Math.floor(t / 1000) % 60) << 8) | (Math.floor(t / 10) % 100));
        return true;
      }
      default: return false;
    }
  }

  // Microsoft mouse driver. mars is driven entirely by this.
  int33(r) {
    const fn = r.get('ax') & 0xFFFF;
    switch (fn) {
      case 0x00: r.set('ax', 0xFFFF); r.set('bx', 2); return true;   // present, 2 buttons
      case 0x01: case 0x02: return true;                             // show/hide cursor
      case 0x03:
        r.set('bx', this.mouse.buttons);
        r.set('cx', this.mouse.x); r.set('dx', this.mouse.y);
        return true;
      case 0x04: this.mouse.x = r.get('cx'); this.mouse.y = r.get('dx'); return true;
      case 0x0B:
        // Read motion counters. These are DELTAS and are cleared by the read,
        // which is what makes a "move the mouse to fly" demo work at all.
        r.set('cx', this.mouse.dx & 0xFFFF); r.set('dx', this.mouse.dy & 0xFFFF);
        this.mouse.dx = 0; this.mouse.dy = 0;
        return true;
      case 0x07: case 0x08: case 0x0F: case 0x10: return true;       // ranges, mickeys
      default: return false;
    }
  }
}

module.exports = { Machine, loadExe, VGA_BASE, STUB_SEG, STUB_BYTE, LOAD_SEG, PSP_SEG };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/toyvm/dos.js <file.exe>   # MZ header summary'); process.exit(2); }
  const mem = new Uint8Array(1 << 20);
  const info = loadExe(mem, fs.readFileSync(file));
  console.log(info);
}
