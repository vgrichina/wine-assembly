'use strict';

// A Gravis Ultrasound, as far as a program can hear it: the GF1's DRAM, its
// 32 voices, their volume ramps, the two timers, the interrupt status a
// handler reads, and a DMA upload into the DRAM.
//
// This is a different kind of card from the Sound Blaster in audio.js. The
// SB is a DAC at the end of a DMA channel and the program streams every
// sample; the GF1 is a wavetable synthesizer with its own memory. A program
// pokes its samples into that memory once (or DMAs them in), then points a
// voice at a start address, an end address, a frequency and a volume and the
// chip plays it, loops it, ramps it and interrupts when it is done. What a
// module player then does per tick is a handful of register writes, and the
// tick itself is usually one of the two GF1 timers interrupting.
//
// Five programs in the corpus drive it and they share one shape (measured
// 2026-09-03 with --trace-io on the GF1 ports): reset via 0x4C, active
// voices, a per-voice stop, a DRAM peek to size the memory, a few hundred
// KB of pokes through 0x3X7, the IRQ latch through 0x2XB, MIX with the IRQ
// enable bit, then timer 2 (or 1) started through the AdLib-compatible pair
// at 0x2X8/0x2X9 -- and from then on everything happens in the timer's
// interrupt handler. DOPE runs that timer at 320us; a program that gets no
// interrupt from it plays nothing and looks exactly like a card that is
// not there.
//
// Addresses. The wave registers hold 20 bits of DRAM address with 9 bits of
// fraction below them: the high register is address bits 19..7, the low
// register's top seven bits are address bits 6..0 and its bits 8..5 the
// fraction. Held here as one integer with 9 fractional bits, so the
// frequency register -- which is 1024 per whole sample per output sample --
// adds as `fc >> 1` and the current address reads back in the same two
// halves it was written in. A 16-bit voice reads its samples through the
// GF1's word addressing: the low 17 bits of the address are doubled inside
// a 256KB bank.
//
// Volume is a 16-bit register whose top 12 bits index a 4-bit-exponent,
// 8-bit-mantissa curve; the ramp adds (rate & 0x3F) in 1/8^(rate >> 6) of a
// curve step per sample. Pan is 0 (left) to 15 (right).
//
// Time. Rendered voices step at the sink's rate scaled from the chip's own
// (617400 / active voices, 44100 at 14). Without a sink they still advance
// -- the wave-end and ramp-end interrupts exist whether or not anything
// listens -- but in one arithmetic step per slice instead of per sample.
// Timer 1 counts 80us ticks and timer 2 320us ticks up from their count
// register to 256, reload, and keep going.

const DRAM_SIZE = 1 << 20;
const VOICES = 32;
const GF1_CLOCK = 617400;                 // voices * rate: 44100Hz at 14 voices
// The IRQ and DMA selection codes of the 0x2XB latch.
const IRQ_CODE = [0, 2, 5, 3, 7, 11, 12, 15];
const DMA_CODE = [0, 1, 3, 5, 6, 7];
// Which GF1 registers are 16 bits wide (written through 0x3X4).
const WIDE = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x09, 0x0A, 0x0B, 0x42, 0x43]);
// The same level as the Sound Blaster stream. The 32 voices summed at full
// volume would be far past full scale, but the players here run four to
// eight voices at volumes around 0xB000 (-24dB), so this is where DOPE and
// CYBOMAN2 peak near where the SB demos do; the mix is clamped after it.
const GUS_LEVEL = 0.7;

// Volume curve: 16 exponents of 256 mantissa steps, the top entry 1.0.
const VOL = new Float32Array(4096);
for (let i = 0; i < 4096; i++) VOL[i] = Math.pow(2, (i >> 8) - 15) * (256 + (i & 0xFF)) / 511;
// Equal-power pan.
const PAN_L = new Float32Array(16), PAN_R = new Float32Array(16);
for (let p = 0; p < 16; p++) { PAN_L[p] = Math.sqrt((15 - p) / 15); PAN_R[p] = Math.sqrt(p / 15); }

class Voice {
  constructor() {
    this.ctl = 3; this.freq = 0; this.start = 0; this.end = 0; this.cur = 0;
    this.rampRate = 0; this.rampStart = 0; this.rampEnd = 0; this.vol = 0;
    this.volCtl = 3; this.pan = 7;
    this.wavePending = 0; this.rampPending = 0;
  }
  running() { return (this.ctl & 3) === 0; }
  ramping() { return (this.volCtl & 3) === 0; }
}

class Gus {
  constructor(opts = {}) {
    this.base = opts.base || 0x220;
    this.machine = opts.machine || null;   // for the DMA controller and guest memory
    this.dram = new Uint8Array(DRAM_SIZE);
    this.voices = [];
    for (let i = 0; i < VOICES; i++) this.voices.push(new Voice());
    this.voice = 0; this.reg = 0; this.low = 0;
    this.dramAddr = 0;
    this.mixCtl = 0x0B;                    // line-in and output disabled, IRQ off
    this.irqCtl = 0; this.dmaCtl = 0;     // the two 0x2XB latches
    this.regCtl = 0;
    this.reset = 0;                       // 0x4C: bit 0 out of reset, 1 DAC, 2 IRQ enable
    this.dmaControl = 0; this.dmaAddr = 0;
    this.timerCtl = 0;                    // 0x45: bit 2 / 3 timer IRQ enable
    this.timerCount = [0, 0];
    this.adlibIdx = 0;
    this.timers = [
      { running: 0, reached: 0, masked: 0, acc: 0, unit: 80e-6 },
      { running: 0, reached: 0, masked: 0, acc: 0, unit: 320e-6 },
    ];
    this.irqStatus = 0;                   // 0x2X6
    this.irqPending = 0;                  // an event since the last delivery
    this.sampleCtl = 0;
    this.activeVoices = 14;
    this.rate = GF1_CLOCK / 14;
    this.stats = { pokes: 0, peeks: 0, writes: 0, dmaBytes: 0, irqs: 0, starts: 0, resets: 0 };
  }

  // --- the bus ---------------------------------------------------------------

  // Which IRQ line the latch selected, 0 for none.
  irqLine() { return IRQ_CODE[this.irqCtl & 7]; }
  dmaChannel() { return DMA_CODE[this.dmaCtl & 7] || 0; }

  // A byte or word written to one of the card's ports (`off` is port - base).
  out(off, v, w) {
    switch (off) {
      case 0x000: this.mixCtl = v & 0xFF; return true;
      case 0x008: this.adlibIdx = v & 0xFF; return true;
      case 0x009: if (this.adlibIdx === 4) this.timerData(v & 0xFF); return true;
      case 0x00B:
        if (this.mixCtl & 0x40) this.irqCtl = v & 0xFF; else this.dmaCtl = v & 0xFF;
        return true;
      case 0x00F: this.regCtl = v & 0xFF; return true;
      case 0x102: this.voice = v & 0x1F; return true;
      case 0x103: this.reg = v & 0xFF; return true;
      case 0x104:
        if (w === 16) this.write(this.reg, v & 0xFFFF);
        else this.low = v & 0xFF;
        return true;
      case 0x105:
        if (WIDE.has(this.reg)) this.write(this.reg, ((v & 0xFF) << 8) | this.low);
        else this.write(this.reg, v & 0xFF);
        return true;
      case 0x107:
        this.dram[this.dramAddr] = v & 0xFF;
        this.stats.pokes++;
        return true;
      default: return false;
    }
  }

  // A read from one of the card's ports, or -1 for a port it does not answer.
  in(off, w) {
    switch (off) {
      case 0x006: return this.irqStatus;
      case 0x008: return this.adlibStatus();
      case 0x00B: return (this.mixCtl & 0x40) ? this.irqCtl : this.dmaCtl;
      case 0x00F: return 0xFF;            // a classic card: no register controls
      case 0x102: return this.voice;
      case 0x103: return this.reg;
      case 0x104: {
        const r = this.read(this.reg);
        return w === 16 ? r : r & 0xFF;
      }
      case 0x105: {
        const r = this.read(this.reg);
        return WIDE.has(this.reg & 0x7F) ? (r >> 8) & 0xFF : r & 0xFF;
      }
      case 0x107:
        this.stats.peeks++;
        return this.dram[this.dramAddr];
      default: return -1;
    }
  }

  // The AdLib-compatible timer data byte at 0x2X9 register 4: bit 7 clears
  // the flags, 6 and 5 mask the timers, 0 and 1 start them.
  timerData(v) {
    if (v & 0x80) {
      for (const t of this.timers) t.reached = 0;
      this.irqStatus &= ~0x0C;
      return;
    }
    this.timers[0].masked = (v >> 6) & 1;
    this.timers[1].masked = (v >> 5) & 1;
    for (let i = 0; i < 2; i++) {
      const on = (v >> i) & 1;
      if (on && !this.timers[i].running) this.timers[i].acc = 0;
      this.timers[i].running = on;
    }
  }

  // Bit 7 = either timer expired, 6 = timer 1, 5 = timer 2.
  adlibStatus() {
    let s = 0;
    if (this.timers[0].reached && !this.timers[0].masked) s |= 0x40;
    if (this.timers[1].reached && !this.timers[1].masked) s |= 0x20;
    return s ? s | 0x80 : 0;
  }

  // --- the GF1 register file ----------------------------------------------------

  write(reg, v) {
    this.stats.writes++;
    const vc = this.voices[this.voice];
    switch (reg) {
      case 0x00:
        vc.ctl = v & 0x7F;
        if (!(v & 1) && (vc.ctl & 2)) vc.ctl &= ~2;      // a fresh start clears "stopped"
        if (!(v & 1)) this.stats.starts++;
        if (v & 0x80) vc.wavePending = 0;
        return;
      case 0x01: vc.freq = v & 0xFFFF; return;
      case 0x02: vc.start = (vc.start & 0xFFFF) | ((v & 0x1FFF) << 16); return;
      case 0x03: vc.start = (vc.start & ~0xFFFF) | (v & 0xFFFF); return;
      case 0x04: vc.end = (vc.end & 0xFFFF) | ((v & 0x1FFF) << 16); return;
      case 0x05: vc.end = (vc.end & ~0xFFFF) | (v & 0xFFFF); return;
      case 0x06: vc.rampRate = v & 0xFF; return;
      case 0x07: vc.rampStart = v & 0xFF; return;
      case 0x08: vc.rampEnd = v & 0xFF; return;
      case 0x09: vc.vol = v & 0xFFF0; return;
      case 0x0A: vc.cur = (vc.cur & 0xFFFF) | ((v & 0x1FFF) << 16); return;
      case 0x0B: vc.cur = (vc.cur & ~0xFFFF) | (v & 0xFFFF); return;
      case 0x0C: vc.pan = v & 0x0F; return;
      case 0x0D:
        vc.volCtl = v & 0x7F;
        if (!(v & 1)) vc.volCtl &= ~2;
        if (v & 0x80) vc.rampPending = 0;
        return;
      case 0x0E: {
        const n = Math.min(VOICES, Math.max(14, (v & 0x3F) + 1));
        this.activeVoices = n;
        this.rate = GF1_CLOCK / n;
        return;
      }
      case 0x41:
        this.dmaControl = v & 0xFF;
        if (v & 1) this.dmaTransfer();
        return;
      case 0x42: this.dmaAddr = v & 0xFFFF; return;
      case 0x43: this.dramAddr = (this.dramAddr & 0xF0000) | (v & 0xFFFF); return;
      case 0x44: this.dramAddr = (this.dramAddr & 0x0FFFF) | ((v & 0x0F) << 16); return;
      case 0x45:
        this.timerCtl = v & 0xFF;
        if (!(v & 0x04)) this.irqStatus &= ~0x04;
        if (!(v & 0x08)) this.irqStatus &= ~0x08;
        return;
      case 0x46: this.timerCount[0] = v & 0xFF; return;
      case 0x47: this.timerCount[1] = v & 0xFF; return;
      case 0x48: return;                                 // sampling frequency
      case 0x49: this.sampleCtl = v & 0xFF; return;
      case 0x4B: return;                                 // joystick trim
      case 0x4C:
        if (!(v & 1)) this.masterReset();
        this.reset = v & 0x07;
        return;
      default: return;
    }
  }

  read(reg) {
    const vc = this.voices[this.voice];
    switch (reg) {
      case 0x41: { const r = this.dmaControl; this.dmaControl &= ~0x40; this.irqStatus &= ~0x80; return r; }
      case 0x45: return this.timerCtl;
      case 0x49: return this.sampleCtl;
      case 0x4C: return this.reset;
      case 0x80: return vc.ctl | (vc.wavePending ? 0x80 : 0);
      case 0x81: return vc.freq;
      case 0x82: return (vc.start >> 16) & 0x1FFF;
      case 0x83: return vc.start & 0xFFFF;
      case 0x84: return (vc.end >> 16) & 0x1FFF;
      case 0x85: return vc.end & 0xFFFF;
      case 0x86: return vc.rampRate;
      case 0x87: return vc.rampStart;
      case 0x88: return vc.rampEnd;
      case 0x89: return vc.vol & 0xFFF0;
      case 0x8A: return (vc.cur >> 16) & 0x1FFF;
      case 0x8B: return vc.cur & 0xFFFF;
      case 0x8C: return vc.pan;
      case 0x8D: return vc.volCtl | (vc.rampPending ? 0x80 : 0);
      case 0x8E: return (this.activeVoices - 1) | 0xC0;
      case 0x8F: {
        // The interrupt source: the lowest voice with a wave or ramp
        // interrupt owed, bit 7 clear for wave, bit 6 clear for ramp; both
        // set when none. Reading it takes that voice's flag down.
        for (let i = 0; i < VOICES; i++) {
          const v = this.voices[i];
          if (v.wavePending) { v.wavePending = 0; this.refreshVoiceIrq(); return i | 0x40; }
          if (v.rampPending) { v.rampPending = 0; this.refreshVoiceIrq(); return i | 0x80; }
        }
        return 0xC0;
      }
      default: return 0xFF;
    }
  }

  masterReset() {
    this.stats.resets++;
    for (const v of this.voices) {
      v.ctl = 3; v.volCtl = 3; v.wavePending = 0; v.rampPending = 0; v.vol = 0;
    }
    for (const t of this.timers) { t.running = 0; t.reached = 0; t.masked = 0; t.acc = 0; }
    this.irqStatus = 0; this.irqPending = 0;
    this.timerCtl = 0; this.dmaControl = 0;
  }

  refreshVoiceIrq() {
    let wave = 0, ramp = 0;
    for (const v of this.voices) { if (v.wavePending) wave = 1; if (v.rampPending) ramp = 1; }
    this.irqStatus = (this.irqStatus & ~0x60) | (wave ? 0x20 : 0) | (ramp ? 0x40 : 0);
  }

  // --- interrupts -------------------------------------------------------------

  // The card's interrupt path: the mix control's latch enable and a latched
  // line. Reset bit 2 is the documented "master IRQ enable", but it gates
  // only the voice interrupts here: CYBOMAN2 programs its timer with reset
  // at 3 and waits for the interrupt, which it got on the real card.
  irqEnabled() { return (this.mixCtl & 0x08) !== 0 && this.irqLine() !== 0; }

  // Something happened that the card interrupts for.
  event(bit) {
    this.irqStatus |= bit;
    this.irqPending = 1;
  }

  // Whether an interrupt is owed: an event since the last one was taken,
  // with the card's interrupt path enabled. Taking it clears the "new event"
  // note; the status bits stay until the handler clears them.
  takeIrq() {
    if (!this.irqPending || !this.irqEnabled()) return false;
    const live = (this.irqStatus & 0x8C) | ((this.reset & 0x04) ? (this.irqStatus & 0x60) : 0);
    if (!live) { this.irqPending = 0; return false; }
    this.irqPending = 0;
    this.stats.irqs++;
    return true;
  }

  // --- DMA ----------------------------------------------------------------------

  // A whole transfer at once, the moment the program enables it: the 8237
  // channel the program picked (the latch, or whichever it programmed) is
  // drained into DRAM at the address register. Bit 6 = 16-bit data, bit 2 =
  // a 16-bit DMA channel, bit 7 = invert the sign bit on the way in, bit 5 =
  // interrupt on terminal count, bit 1 = the other direction (not done).
  dmaTransfer() {
    const m = this.machine;
    const dma = m && m.audio && m.audio.dma, mem = m && m.mem;
    if (!dma || !mem) return;
    const ctl = this.dmaControl;
    if (ctl & 0x02) return;
    let ch = this.dmaChannel();
    if (!ch || !(dma.programmed & (1 << ch))) ch = (ctl & 0x04) ? dma.recent16 : dma.recent8;
    let addr = this.dmaAddr << 4;
    if (ctl & 0x04) addr = (addr & 0xC0000) | ((addr & 0x1FFFF) << 1);
    const wide = ch >= 4;
    let n = 0;
    while (n < DRAM_SIZE) {
      let v = dma.next(ch, mem);
      if (v < 0) break;
      if (wide) {
        if (ctl & 0x80) v ^= 0x8000;
        this.dram[addr & (DRAM_SIZE - 1)] = v & 0xFF;
        this.dram[(addr + 1) & (DRAM_SIZE - 1)] = (v >> 8) & 0xFF;
        addr += 2; n += 2;
      } else {
        if (ctl & 0x80) v ^= 0x80;
        this.dram[addr & (DRAM_SIZE - 1)] = v;
        addr++; n++;
      }
    }
    this.stats.dmaBytes += n;
    this.dmaControl = (ctl & ~0x01) | 0x40;
    if (ctl & 0x20) this.event(0x80);
  }

  // --- time ---------------------------------------------------------------------

  // `dt` guest seconds went by. Timers count; voices are stepped by the
  // renderer when there is one (`mix` below), or in one go here when not.
  advance(dt, rendered) {
    for (let i = 0; i < 2; i++) {
      const t = this.timers[i];
      if (!t.running) continue;
      const period = (256 - this.timerCount[i]) * t.unit;
      t.acc += dt;
      if (t.acc >= period) {
        t.acc %= period;
        t.reached = 1;
        if (this.timerCtl & (0x04 << i)) this.event(0x04 << i);
      }
    }
    if (rendered) return;
    const samples = dt * this.rate;
    for (let i = 0; i < this.activeVoices; i++) {
      const v = this.voices[i];
      if (v.running()) this.stepWave(v, (v.freq >> 1) * samples);
      if (v.ramping()) this.stepRamp(v, this.rampDelta(v) * samples);
    }
  }

  // Add `n` address units to a voice, folding loops and stopping at ends.
  stepWave(v, n) {
    const dec = (v.ctl & 0x40) !== 0;
    let cur = dec ? v.cur - n : v.cur + n;
    const lo = v.start, hi = v.end;
    if (dec ? cur >= lo : cur <= hi) { v.cur = cur; return; }
    if (v.ctl & 0x08) {
      const len = hi - lo;
      if (len <= 0) { v.cur = lo; return; }
      if (v.ctl & 0x10) {
        // Bidirectional: unfold the path from `lo` over a double-length
        // period. Going down past `lo` is the mirror image of going up from
        // it, so it starts flipped; each further length flips again.
        let p = dec ? lo - cur : cur - lo, flip = dec ? 1 : 0;
        p = ((p % (2 * len)) + 2 * len) % (2 * len);
        if (p > len) { p = 2 * len - p; flip ^= 1; }
        v.cur = lo + p;
        if (flip) v.ctl ^= 0x40;
      } else {
        const o = (((dec ? lo - cur : cur - lo) % len) + len) % len;
        v.cur = dec ? hi - o : lo + o;
      }
    } else {
      v.cur = dec ? lo : hi;
      v.ctl |= 0x03;
    }
    if (v.ctl & 0x20) { v.wavePending = 1; this.event(0x20); }
  }

  // The 16-bit volume change per output sample of a running ramp.
  rampDelta(v) {
    const r = v.rampRate;
    return ((r & 0x3F) * 16) / Math.pow(8, r >> 6);
  }

  stepRamp(v, d) {
    const dec = (v.volCtl & 0x40) !== 0;
    const lo = v.rampStart << 8, hi = v.rampEnd << 8;
    let vol = dec ? v.vol - d : v.vol + d;
    if (dec ? vol > lo : vol < hi) { v.vol = vol; return; }
    if (v.volCtl & 0x08) {
      if (v.volCtl & 0x10) { v.volCtl ^= 0x40; v.vol = dec ? lo : hi; }
      else v.vol = dec ? hi : lo;
    } else {
      v.vol = dec ? lo : hi;
      v.volCtl |= 0x03;
    }
    if (v.volCtl & 0x20) { v.rampPending = 1; this.event(0x40); }
  }

  // One output frame at `rate`: the sum of every running voice into (l, r),
  // returned as a two-element array reused across calls.
  mix(rate) {
    const out = this.frame || (this.frame = [0, 0]);
    let l = 0, r = 0;
    if (!(this.reset & 0x02)) { out[0] = 0; out[1] = 0; return out; }
    const scale = this.rate / rate;
    const dram = this.dram;
    for (let i = 0; i < this.activeVoices; i++) {
      const v = this.voices[i];
      const running = v.running();
      if (!running && !v.ramping()) continue;
      if (v.ramping()) this.stepRamp(v, this.rampDelta(v) * scale);
      if (!running) continue;
      const addr = v.cur >> 9, frac = (v.cur & 0x1FF) / 512;
      let s0, s1;
      if (v.ctl & 0x04) {
        const a = ((addr & 0xC0000) | ((addr & 0x1FFFF) << 1)) & (DRAM_SIZE - 1);
        s0 = ((dram[a] | (dram[(a + 1) & (DRAM_SIZE - 1)] << 8)) << 16) >> 16;
        const b = (a + 2) & (DRAM_SIZE - 1);
        s1 = ((dram[b] | (dram[(b + 1) & (DRAM_SIZE - 1)] << 8)) << 16) >> 16;
        s0 /= 32768; s1 /= 32768;
      } else {
        const a = addr & (DRAM_SIZE - 1);
        s0 = ((dram[a] << 24) >> 24) / 128;
        s1 = ((dram[(a + 1) & (DRAM_SIZE - 1)] << 24) >> 24) / 128;
      }
      const s = (s0 + (s1 - s0) * frac) * VOL[(v.vol >> 4) & 0xFFF];
      l += s * PAN_L[v.pan]; r += s * PAN_R[v.pan];
      this.stepWave(v, (v.freq >> 1) * scale);
    }
    out[0] = Math.max(-1, Math.min(1, l * GUS_LEVEL));
    out[1] = Math.max(-1, Math.min(1, r * GUS_LEVEL));
    return out;
  }

  // Whether any voice is running: the report's "is it playing" bit.
  active() {
    for (let i = 0; i < this.activeVoices; i++) if (this.voices[i].running()) return true;
    return false;
  }
}

module.exports = { Gus, IRQ_CODE, DMA_CODE, DRAM_SIZE };
