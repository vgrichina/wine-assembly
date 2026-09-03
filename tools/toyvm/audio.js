'use strict';

// The sound hardware behind the ports, as far as a program can be HEARD
// through it: the 8237 DMA controllers a Sound Blaster driver programs, the
// stream of samples the card pulls through them, and the PC speaker on port
// 61h driven by PIT channel 2.
//
// dos.js answers the detection conversation (DSP reset, version, the probe
// transfers) and keeps the DSP's own state in `machine.sb`; this file is what
// happens to the samples once a transfer is running, and it is what changed
// the block-done interrupt from a cadence into an event. Before this the
// driver's block completed after len/rate seconds of guest time by fiat; now
// it completes when the last sample of the block has actually been fetched
// through the DMA channel, which is the same moment on a real card and the
// same number here for a driver that programmed the channel it said it would
// -- and still the same for one that never programmed the 8237 at all, whose
// block is fetched as silence so its interrupt still arrives. MIDAS finds its
// DMA channel by programming the 8237 for one byte and waiting for exactly
// that interrupt.
//
// Rendering is optional. With no `sink` the samples are consumed by guest
// time and never looked at, which is what a headless sweep wants; with one
// (the page, or run-dos --audio=) every guest slice renders its span of
// output at `rate` and hands it over as interleaved stereo floats.
//
// Time inside a slice. A slice is up to a few tens of thousands of dispatches
// -- a few milliseconds of guest time -- and a speaker driver toggles port 61h
// hundreds of times inside one. Rendering from the state at the slice's end
// would lose every edge in between, so port writes that change the speaker
// are stamped with the dispatch count they happened at (Machine.audioNow,
// which reads the VM's remaining step budget) and replayed at the right
// sample when the slice is rendered.

const { Opl } = require('./opl');

const PIT_HZ = 1193182;

// Which page register belongs to which channel.
const PAGE_PORT = { 0x87: 0, 0x83: 1, 0x81: 2, 0x82: 3, 0x8B: 5, 0x89: 6, 0x8A: 7 };

// Two 8237s: channels 0-3 move bytes, 4-7 move words (channel 4 cascades and
// is never used for data). Only the registers a sound driver touches are
// modelled, which is all of them except the request register.
class Dma {
  constructor() {
    this.base = new Uint16Array(8);       // as programmed, for auto-init reload
    this.baseCount = new Uint16Array(8);
    this.addr = new Uint16Array(8);       // current
    this.count = new Uint16Array(8);
    this.page = new Uint8Array(8);
    this.mode = new Uint8Array(8);
    this.masked = 0xFF;                   // every channel masked until asked
    this.programmed = 0;                  // channels that have had an address written
    this.tc = 0;                          // terminal-count bits, cleared by a status read
    this.flip = [0, 0];                   // the low/high byte flip-flop, per controller
    this.writes = 0;
    // The channel most recently given an address, per width. Nothing about
    // the card says which channel its jumper is on and no BLASTER= is set
    // (see installEnvironment), so a driver picks one and programs it --
    // MIDAS in BLAND.EXE takes channel 0, most take 1 -- and the card's
    // transfer has to read from the one it chose.
    this.recent8 = 1;
    this.recent16 = 5;
  }

  // Which channel and half a data-register port names, or null.
  reg(port) {
    if (port <= 0x07) return { c: port >> 1, count: (port & 1) !== 0, ctl: 0 };
    if (port >= 0xC0 && port <= 0xCE && !(port & 1)) {
      return { c: 4 + ((port - 0xC0) >> 2), count: (port & 2) !== 0, ctl: 1 };
    }
    return null;
  }

  write(port, v) {
    const r = this.reg(port);
    if (r) {
      this.writes++;
      const hi = this.flip[r.ctl];
      this.flip[r.ctl] ^= 1;
      const arr = r.count ? this.baseCount : this.base;
      arr[r.c] = hi ? (arr[r.c] & 0x00FF) | (v << 8) : (arr[r.c] & 0xFF00) | v;
      if (r.count) this.count[r.c] = this.baseCount[r.c];
      else {
        this.addr[r.c] = this.base[r.c];
        this.programmed |= 1 << r.c;
        if (r.c < 4) this.recent8 = r.c; else this.recent16 = r.c;
      }
      return true;
    }
    if (PAGE_PORT[port] !== undefined) { this.page[PAGE_PORT[port]] = v; return true; }
    const second = port >= 0xD0 && port <= 0xDE;
    const ctl = second ? 1 : 0;
    const p = second ? 0x08 + ((port - 0xD0) >> 1) : port;
    if (second && (port & 1)) return false;
    switch (p) {
      case 0x08: return true;                                   // command
      case 0x09: return true;                                   // request
      case 0x0A: {                                              // single mask
        const c = (v & 3) + ctl * 4;
        if (v & 4) this.masked |= 1 << c; else this.masked &= ~(1 << c);
        return true;
      }
      case 0x0B: this.mode[(v & 3) + ctl * 4] = v; return true; // mode
      case 0x0C: this.flip[ctl] = 0; return true;               // clear flip-flop
      case 0x0D:                                                // master clear
        this.flip[ctl] = 0;
        this.masked |= ctl ? 0xF0 : 0x0F;
        this.tc &= ctl ? 0x0F : 0xF0;
        return true;
      case 0x0E: this.masked &= ctl ? 0x0F : 0xF0; return true; // clear all masks
      case 0x0F:                                                // write all masks
        this.masked = ctl ? (this.masked & 0x0F) | ((v & 0x0F) << 4)
          : (this.masked & 0xF0) | (v & 0x0F);
        return true;
      default: return false;
    }
  }

  // -1 for a port that is not the DMA controller's.
  read(port) {
    const r = this.reg(port);
    if (r) {
      const hi = this.flip[r.ctl];
      this.flip[r.ctl] ^= 1;
      const cur = r.count ? this.count[r.c] : this.addr[r.c];
      return hi ? (cur >> 8) & 0xFF : cur & 0xFF;
    }
    if (PAGE_PORT[port] !== undefined) return this.page[PAGE_PORT[port]];
    if (port === 0x08 || port === 0xD0) {
      // Status: terminal-count reached, per channel, cleared by the read. A
      // driver polling for the end of a single-cycle block reads this.
      const ctl = port === 0xD0 ? 1 : 0;
      const bits = ctl ? this.tc >> 4 : this.tc & 0x0F;
      this.tc &= ctl ? 0x0F : 0xF0;
      return bits & 0x0F;
    }
    if (port === 0x0F) return this.masked & 0x0F;
    if (port === 0xDE) return (this.masked >> 4) & 0x0F;
    return -1;
  }

  // Fetch the next unit on channel `c` from guest memory, or -1 when the
  // channel is masked or was never programmed. A byte on channels 0-3, a
  // little-endian word on 4-7 (whose address register counts words).
  next(c, mem) {
    const bit = 1 << c;
    if (!(this.programmed & bit) || (this.masked & bit)) return -1;
    let lin, v;
    if (c < 4) {
      lin = (this.page[c] << 16) | this.addr[c];
      v = lin < mem.length ? mem[lin] : 0;
    } else {
      lin = ((this.page[c] & 0xFE) << 16) | (this.addr[c] << 1);
      v = lin + 1 < mem.length ? mem[lin] | (mem[lin + 1] << 8) : 0;
    }
    this.addr[c] = (this.addr[c] + ((this.mode[c] & 0x20) ? -1 : 1)) & 0xFFFF;
    if (this.count[c] === 0) {
      this.tc |= bit;
      if (this.mode[c] & 0x10) {              // auto-initialise: start over
        this.addr[c] = this.base[c];
        this.count[c] = this.baseCount[c];
      } else {
        this.masked |= bit;                   // single cycle: the channel is done
      }
    } else {
      this.count[c]--;
    }
    return v;
  }
}

// What the two sources are mixed at. The speaker is a square wave with no
// dynamics; 0.2 of full scale is loud enough to hear over a sample stream
// without clipping the sum.
const SPEAKER_LEVEL = 0.2;
const SB_LEVEL = 0.7;
// The FM chip's output is already normalized to its own 16-bit headroom.
const OPL_LEVEL = 1.0;
// A one-pole high-pass on the mix, so a speaker left at a DC level or a
// finished single-cycle block holding its last sample settles to silence
// instead of sitting on an offset that clicks when it changes. 20ms, at
// whatever the output rate is.
const HP_SECONDS = 0.02;

class Sound {
  constructor(machine) {
    this.m = machine;
    this.dma = new Dma();
    // Host rendering. `rate` 0 or no `sink`: consume samples by time, render
    // nothing.
    this.rate = 0;
    this.sink = null;
    this.spk = { gate: 0, data: 0, latch: 0x10000, phase: 0 };
    this.events = [];             // {at, gate, data, latch}, at = dispatch count
    this.outAcc = 0;              // fractional output samples carried between slices
    this.sbPos = 0;               // fractional source sample within the output stream
    this.sbAcc = 0;               // unrendered consumption, in source samples
    this.sbSide = 0;              // which channel of a stereo pair comes next
    this.hpx = [0, 0]; this.hpy = [0, 0];
    this.buf = new Float32Array(0);
    this.rendered = 0;            // output frames handed to the sink
    this.speakerWrites = 0;
    this.opl = new Opl();
    this.oplEvents = [];          // {at, reg, v} register writes not yet rendered
  }

  // An OPL2 register write, stamped with when. Applied at once when nothing
  // renders; otherwise held until the slice is rendered so the note starts
  // at its own sample.
  noteOpl(at, reg, v) {
    if (!this.rate || !this.sink) { this.opl.write(reg, v); return; }
    // The timer registers land now, not when the slice is rendered: they make
    // no sound, and the status port is read back in the same instruction
    // stream that wrote them. The AdLib presence test starts timer 1 and
    // spins on the status port for its flag; with the write queued until the
    // render, the flag never came inside the spin, and BLUE.COM, brainbug,
    // daretro and DFUSE each concluded there was no FM chip -- but only when
    // audio was being rendered, so the CLI without --audio disagreed with the
    // page.
    if (reg === 0x02 || reg === 0x03 || reg === 0x04) { this.opl.write(reg, v); return; }
    this.oplEvents.push({ at, reg, v });
  }

  // A port 61h write or a PIT channel-2 reload, stamped with when it happened.
  // Only kept when something will render them.
  noteSpeaker(at, gate, data, latch) {
    this.speakerWrites++;
    if (!this.rate || !this.sink) {
      this.spk.gate = gate; this.spk.data = data; this.spk.latch = latch;
      return;
    }
    this.events.push({ at, gate, data, latch });
  }

  // One sample through the Sound Blaster's transfer, if one is running:
  // pulls the next unit off the DMA channel, converts it, and counts the
  // block down. Returns nothing; the current level is in sb.lastL/lastR.
  sbNext() {
    const sb = this.m.sb;
    if (!sb.pending || sb.paused) return;
    const v = this.dma.next(sb.chan, this.m.mem);
    let s;
    if (v < 0) s = 0;
    else if (sb.bits === 16) s = (sb.signed ? ((v << 16) >> 16) : v - 32768) / 32768;
    else s = (sb.signed ? ((v << 24) >> 24) : v - 128) / 128;
    if (sb.stereo) {
      if (this.sbSide === 0) sb.lastL = s; else sb.lastR = s;
      this.sbSide ^= 1;
    } else {
      sb.lastL = sb.lastR = s;
    }
    if (--sb.left <= 0) {
      sb.irqDue = true;
      if (sb.autoInit) sb.left = sb.len;
      else sb.pending = false;
    }
  }

  // `dt` guest seconds passed over `spent` dispatches starting at `sliceStart`.
  advance(dt, sliceStart, spent) {
    if (!(dt > 0)) { this.events.length = 0; return; }
    const sb = this.m.sb, gus = this.m.gus;
    if (!this.rate || !this.sink) {
      if (gus) gus.advance(dt, false);
      if (sb.pending && !sb.paused) {
        this.sbAcc += dt * sb.rate;
        const n = Math.floor(this.sbAcc);
        this.sbAcc -= n;
        for (let i = 0; i < n && sb.pending; i++) this.sbNext();
      }
      this.events.length = 0;
      this.applyOpl(Infinity);
      return;
    }
    this.outAcc += dt * this.rate;
    const n = Math.floor(this.outAcc);
    this.outAcc -= n;
    if (n <= 0) { this.applyEvents(Infinity); return; }
    if (this.buf.length < n * 2) this.buf = new Float32Array(n * 2);
    const buf = this.buf;
    const events = this.events;
    if (events.length > 1) events.sort((a, b) => a.at - b.at);
    let ev = 0;
    const opl = this.opl, oplEvents = this.oplEvents;
    opl.setRate(this.rate);
    if (oplEvents.length > 1) oplEvents.sort((a, b) => a.at - b.at);
    let oe = 0;
    const spk = this.spk;
    if (gus) gus.advance(dt, true);
    const step = sb.rate / this.rate;
    const perSample = spent / n;
    const HP = 1 - 1 / (this.rate * HP_SECONDS);
    for (let i = 0; i < n; i++) {
      const at = sliceStart + perSample * i;
      while (ev < events.length && events[ev].at <= at) {
        const e = events[ev++];
        spk.gate = e.gate; spk.data = e.data; spk.latch = e.latch;
      }
      while (oe < oplEvents.length && oplEvents[oe].at <= at) {
        const e = oplEvents[oe++];
        opl.write(e.reg, e.v);
      }
      // The speaker: bit 1 of port 61h is the speaker's data line, ANDed with
      // the timer's output when bit 0 gates the counter. Gate off leaves the
      // timer output high, so the data bit alone is a level -- which is how a
      // driver plays samples through the speaker by PWM.
      let x = 0;
      if (spk.data) {
        if (spk.gate && spk.latch >= 2) {
          spk.phase += PIT_HZ / spk.latch / this.rate;
          if (spk.phase >= 1) spk.phase -= Math.floor(spk.phase);
          x = spk.phase < 0.5 ? SPEAKER_LEVEL : 0;
        } else {
          x = SPEAKER_LEVEL;
        }
      }
      // The sample stream, held between source samples (a 22kHz 8-bit stream
      // is not improved by interpolating it).
      if (sb.pending && !sb.paused) {
        this.sbPos += step;
        while (this.sbPos >= 1 && sb.pending) { this.sbPos -= 1; this.sbNext(); }
      }
      // The FM chip, mono.
      const fm = opl.next() * OPL_LEVEL;
      // The Ultrasound's 32 voices, already summed and panned.
      const g = gus ? gus.mix(this.rate) : null;
      const l = x + fm + sb.lastL * SB_LEVEL + (g ? g[0] : 0);
      const r = x + fm + sb.lastR * SB_LEVEL + (g ? g[1] : 0);
      const yl = l - this.hpx[0] + HP * this.hpy[0];
      const yr = r - this.hpx[1] + HP * this.hpy[1];
      this.hpx[0] = l; this.hpy[0] = yl; this.hpx[1] = r; this.hpy[1] = yr;
      buf[i * 2] = yl; buf[i * 2 + 1] = yr;
    }
    this.applyEvents(Infinity);
    this.rendered += n;
    this.sink(buf.subarray(0, n * 2), n);
  }

  // Events at or before `at`, folded into the state; the rest dropped.
  applyEvents(at) {
    for (const e of this.events) {
      if (e.at <= at) { this.spk.gate = e.gate; this.spk.data = e.data; this.spk.latch = e.latch; }
    }
    this.events.length = 0;
    this.applyOpl(at);
  }

  applyOpl(at) {
    const evs = this.oplEvents;
    if (evs.length > 1) evs.sort((a, b) => a.at - b.at);
    for (const e of evs) if (e.at <= at) this.opl.write(e.reg, e.v);
    evs.length = 0;
  }
}

// A 16-bit stereo WAV from the interleaved floats a sink collected, for
// run-dos --audio= and for listening to what a test rendered.
function wavBytes(chunks, rate) {
  let frames = 0;
  for (const c of chunks) frames += c.length >> 1;
  const data = new Uint8Array(44 + frames * 4);
  const dv = new DataView(data.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, frames * 4, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      dv.setInt16(o, Math.round(v * 32767), true);
      o += 2;
    }
  }
  return data;
}

module.exports = { Dma, Sound, wavBytes, PIT_HZ };
