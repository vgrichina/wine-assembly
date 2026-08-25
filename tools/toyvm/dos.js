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
  // Dispatch on the signature, not on the file extension. A .COM is a flat
  // image with no header and no relocations -- it loads at PSP:0x100 with every
  // segment register equal, which is why it needs no fixups at all. The corpus
  // has both, and several .COM files are named .EXE and vice versa, so the
  // first two bytes are the only trustworthy test.
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) return loadCom(mem, buf, { pspSeg });
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

// A .COM image: no header, no relocations, one segment. It is copied straight
// to pspSeg:0x100 and entered there with CS=DS=ES=SS=pspSeg. SP starts at
// 0xFFFE with a zero word pushed, so a `ret` exit lands on the PSP's INT 20h
// exactly the way DOS arranges it.
function loadCom(mem, buf, { pspSeg = PSP_SEG } = {}) {
  const base = pspSeg << 4;
  const max = 0x10000 - 0x100 - 2;                 // segment, less PSP and the pushed word
  const image = buf.subarray(0, Math.min(buf.length, max));
  mem.set(image, base + 0x100);

  const psp = base;
  mem[psp] = 0xCD; mem[psp + 1] = 0x20;
  mem[psp + 2] = DEFAULT_ALLOC_TOP & 0xFF;
  mem[psp + 3] = (DEFAULT_ALLOC_TOP >> 8) & 0xFF;
  mem[psp + 0x80] = 0;
  mem[psp + 0x81] = 0x0D;

  const sp = 0xFFFE;
  mem[base + sp] = 0; mem[base + sp + 1] = 0;      // ret -> PSP:0000 -> INT 20h

  return {
    cs: pspSeg, ip: 0x100,
    ss: pspSeg, sp,
    ds: pspSeg, es: pspSeg,
    loadSeg: pspSeg, pspSeg, imageBytes: image.length, com: true,
  };
}

// ---------------------------------------------------------------------------
// VGA registers
// ---------------------------------------------------------------------------
// Three index/data port pairs decide what a byte written to A000 means. Mode
// 13h is the case where the answer is "one pixel", and that is the only case a
// demo gets for free -- everything else is a tweak of these registers:
//
//   3C4/3C5 sequencer   2 = map mask (which planes a write reaches)
//                       4 = memory mode, bit 3 = chain-4. Clearing it is what
//                           "unchained"/mode X means: the four planes stop
//                           being interleaved per byte and A000 addresses one
//                           byte in each of four 64K planes at once.
//   3CE/3CF graphics    4 = read map select (which plane a read returns)
//                       5 = mode, bits 0-1 write mode (1 = copy the latches)
//                       8 = bit mask
//   3D4/3D5 CRTC        9 = max scan line (bits 0-4: row doubling)
//                    C/D = start address (page flipping)
//                      13 = offset, words per scan line -> logical width
//                   12/07 = vertical display end -> scan lines
//
// Modelling them is nearly free -- the ports are already trapped -- and it is
// what lets the renderer read the real geometry instead of assuming 320x200.
const SEQ_MEMORY_MODE = 4, SEQ_MAP_MASK = 2;
const GC_READ_MAP = 4, GC_MODE = 5, GC_BIT_MASK = 8;
const CRTC_HDE = 0x01;
const CRTC_MAX_SCAN = 0x09, CRTC_START_HI = 0x0C, CRTC_START_LO = 0x0D;
const CRTC_VDE = 0x12, CRTC_OVERFLOW = 0x07, CRTC_OFFSET = 0x13;

function newVgaState() {
  const v = {
    seqIndex: 0, seq: new Uint8Array(8),
    gcIndex: 0, gc: new Uint8Array(16),
    crtcIndex: 0, crtc: new Uint8Array(32),
    misc: 0x63,
    planar: false,
    // Counters, so a sweep can tell a program that merely indexed the
    // sequencer from one that actually drove an unchained mode.
    unchainCount: 0, maskWrites: 0, masksSeen: 0,
  };
  resetVgaMode(v, 0x13);
  return v;
}

// The register state mode 13h leaves behind, which is what every mode-X tweak
// starts from. Only the fields the renderer reads are worth setting exactly.
function resetVgaMode(v, mode) {
  v.seq.fill(0);
  v.seq[SEQ_MAP_MASK] = 0x0F;
  v.seq[SEQ_MEMORY_MODE] = mode === 0x13 ? 0x0E : 0x06;   // chain-4 on for 13h
  v.gc.fill(0);
  v.gc[GC_BIT_MASK] = 0xFF;
  v.gc[GC_MODE] = mode === 0x13 ? 0x40 : 0x00;            // bit 6 = 256-colour
  v.crtc.fill(0);
  v.crtc[CRTC_HDE] = 0x4F;             // 80 character clocks -> 320 pixels
  v.crtc[CRTC_MAX_SCAN] = 0x41;        // max scan line 1: each row drawn twice
  v.crtc[CRTC_VDE] = 0x8F;
  v.crtc[CRTC_OVERFLOW] = 0x1F;        // VDE bit 8 -> 400 scan lines
  v.crtc[CRTC_OFFSET] = 40;            // 40 words per line -> 320 pixels
  v.planar = false;
}

// Geometry, derived the way the CRTC actually derives it rather than assumed.
// 320x200 and 320x240 both fall out of this: mode 13h leaves 400 scan lines
// with every row doubled, and the classic 320x240 tweak sets 480 with the
// doubling left in place.
function vgaGeometry(v) {
  const vde = v.crtc[CRTC_VDE]
    | ((v.crtc[CRTC_OVERFLOW] & 0x02) << 7)
    | ((v.crtc[CRTC_OVERFLOW] & 0x40) << 3);
  const rows = Math.floor((vde + 1) / ((v.crtc[CRTC_MAX_SCAN] & 0x1F) + 1));
  // Horizontal display end counts character clocks. A 256-colour mode runs at
  // half the dot clock, so each of those eight dots is four pixels wide -- and
  // that is separate from the offset register, which gives the LOGICAL row and
  // can be wider than the screen when a demo scrolls a big page.
  const width = (v.crtc[CRTC_HDE] + 1) * 4;
  const stride = v.crtc[CRTC_OFFSET] * 8;
  const start = (v.crtc[CRTC_START_HI] << 8) | v.crtc[CRTC_START_LO];
  return {
    width: width > 0 && width <= 800 ? width : 320,
    height: rows > 0 && rows <= 600 ? rows : 200,
    stride: stride > 0 ? stride : 320,
    start,
    planar: v.planar,
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
    this.vga = newVgaState();
    this.ticks = 0;
    this.exited = false;
    this.exitCode = 0;
    this.keys = opts.keys ? [...opts.keys] : [];   // queued as {ah, al}
    this.autoKey = !!opts.autoKey;
    this.forceChained = !!opts.forceChained;
    this.mouse = { x: 160, y: 100, buttons: 0, dx: 0, dy: 0 };
    this.allocTop = DEFAULT_ALLOC_TOP;
    this.unhandled = new Map();
    this.intCount = new Map();
    // Which clock, if any, a program is pacing itself off. A demo that never
    // touches any of these cannot be waiting for time and is compute-bound by
    // construction; one that hammers retrace is frame-paced. Does NOT see a
    // program polling the BIOS tick word in memory directly -- that one is
    // only visible by changing tickScale and watching the frame move. The
    // interrupt-driven clocks (INT 1Ah, 15h, 16h) are already in `intCount`.
    this.clock = { retrace: 0, pit: 0 };

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
      this.clock.retrace++;
      this.retraceToggle ^= 1;
      return this.retraceToggle ? 0x09 : 0x00;
    }
    if (port === 0x3C9) {
      const v = this.palette[this.dacWriteIndex * 3 + this.dacSubIndex] & 0x3F;
      if (++this.dacSubIndex === 3) { this.dacSubIndex = 0; this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF; }
      return v;
    }
    // Read-back of the register files. Code that tweaks one bit of the memory
    // mode does IN/OR/OUT, so returning 0xFF here would set every other bit
    // as a side effect -- including chain-4, which would undo a mode X set.
    if (port === 0x3C5) return this.vga.seq[this.vga.seqIndex];
    if (port === 0x3CF) return this.vga.gc[this.vga.gcIndex];
    if (port === 0x3D5 || port === 0x3B5) return this.vga.crtc[this.vga.crtcIndex];
    if (port === 0x3C4) return this.vga.seqIndex;
    if (port === 0x3CE) return this.vga.gcIndex;
    if (port === 0x3D4 || port === 0x3B4) return this.vga.crtcIndex;
    if (port === 0x3CC) return this.vga.misc;
    if (port === 0x60) return 0;            // keyboard data: no key down
    if (port === 0x40 || port === 0x41 || port === 0x42) { this.clock.pit++; return (this.ticks * 13) & 0xFF; }
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
    const v = this.vga;
    // Index/data pairs. A write to the index port with a 16-bit OUT carries
    // the data in AH, and the recursion at the top of this function has
    // already split that into two 8-bit writes, so both spellings land here.
    switch (port) {
      case 0x3C4: v.seqIndex = value & 0x07; return;
      case 0x3C5: this.vgaSeqWrite(v.seqIndex, value); return;
      case 0x3CE: v.gcIndex = value & 0x0F; return;
      case 0x3CF:
        v.gc[v.gcIndex] = value;
        if (v.gcIndex === GC_READ_MAP || v.gcIndex === GC_MODE) this.syncVga();
        return;
      case 0x3D4: case 0x3B4: v.crtcIndex = value & 0x1F; return;
      case 0x3D5: case 0x3B5: v.crtc[v.crtcIndex] = value; return;
      case 0x3C2: v.misc = value; return;
      default: return;                       // everything else is dropped
    }
  }

  vgaSeqWrite(index, value) {
    const v = this.vga;
    v.seq[index] = value;
    if (index === SEQ_MAP_MASK) {
      v.maskWrites++;
      v.masksSeen |= 1 << (value & 0x0F);
      if (v.planar) this.syncVga();
      return;
    }
    if (index !== SEQ_MEMORY_MODE) return;
    // Chain-4 off in a 256-colour mode is the whole definition of mode X. It
    // changes what a byte at A000 means, so the plane store has to be told.
    //
    // `forceChained` (--chain4) pins the old behaviour -- every A000 byte is one
    // pixel in guest RAM -- so a program whose behaviour changes when it
    // unchains can be A/B'd without a rebuild. It is a lie about the hardware
    // and purely a debugging aid.
    const planar = !this.forceChained && this.videoMode === 0x13 && !(value & 0x08);
    if (planar === v.planar) return;
    v.planar = planar;
    if (planar) v.unchainCount++;
    this.log(`vga ${planar ? 'unchained (mode X)' : 'chained'}`);
    this.vgaRechain(planar);
    this.syncVga();
  }

  // --- the plane store -----------------------------------------------------
  // The VM reads its four control words straight out of shared memory, so
  // keeping the hardware model in step is four stores and no import. Call it
  // after anything that moves the map mask, the read map, the write mode or
  // the chain-4 bit -- and after run-dos.js swaps in the VM's own buffer.
  syncVga() {
    const v = this.vga, m = this.mem;
    if (m.length <= isa.VGA_CTL_KEY) return;      // a bare Machine, no VM yet
    const st = (at, val) => {
      m[at] = val & 0xFF; m[at + 1] = (val >> 8) & 0xFF;
      m[at + 2] = (val >> 16) & 0xFF; m[at + 3] = (val >>> 24) & 0xFF;
    };
    st(isa.VGA_CTL_KEY, v.planar ? isa.VGA_KEY_ON : isa.VGA_KEY_OFF);
    st(isa.VGA_CTL_MASK, v.seq[SEQ_MAP_MASK] & 0x0F);
    st(isa.VGA_CTL_READ, v.gc[GC_READ_MAP] & 3);
    st(isa.VGA_CTL_MODE, v.gc[GC_MODE] & 3);
  }

  // Carry the picture across a chain-4 change instead of dropping it.
  //
  // Chain-4 is not a different memory, it is a different *addressing* of the
  // same four planes: byte `off` of the A000 window is plane `off & 3` at plane
  // offset `off >> 2`. The chained path writes the interleaved form straight
  // into guest RAM, so switching modes is a de-interleave one way and a
  // re-interleave the other. Demos routinely clear the screen in plain 13h and
  // only then unchain, and without this that clear -- or a whole loaded image
  // -- would vanish at the mode switch.
  vgaRechain(toPlanar) {
    const m = this.mem;
    if (m.length <= isa.VGA_PLANES) return;
    for (let i = 0; i < 0x10000; i++) {
      const p = isa.VGA_PLANES + ((i & 3) << 16) + (i >> 2);
      if (toPlanar) m[p] = m[VGA_BASE + i];
      else m[VGA_BASE + i] = m[p];
    }
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
      // Setting a mode clears the display and re-chains the planes -- a demo
      // that unchains does it AFTER asking the BIOS for mode 13h.
      resetVgaMode(this.vga, this.videoMode);
      this.syncVga();
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

module.exports = {
  Machine, loadExe, vgaGeometry,
  VGA_BASE, STUB_SEG, STUB_BYTE, LOAD_SEG, PSP_SEG,
};

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/toyvm/dos.js <file.exe>   # MZ header summary'); process.exit(2); }
  const mem = new Uint8Array(1 << 20);
  const info = loadExe(mem, fs.readFileSync(file));
  console.log(info);
}
