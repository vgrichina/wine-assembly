'use strict';

// The YM3812 -- the OPL2 on an AdLib or a Sound Blaster -- behind ports 388h
// and 389h: nine two-operator FM channels, four waveforms, the vibrato and
// tremolo LFOs, and the five-voice rhythm mode.
//
// This is a floating-point model at the host's sample rate, not a gate-level
// one. The chip runs at 49716 Hz and every one of its constants -- phase
// increments, envelope rates, LFO speeds -- is scaled to whatever rate the
// output is rendered at, so there is no resampler in the path. Amplitudes
// follow the chip's own units (0.1875 dB steps, 0.75 dB per TL step, a
// 96 dB envelope) through one table, the sine through another; the shapes
// that give the chip its character -- the attack that is exponential in the
// log domain, phase modulation whose full-scale index is four cycles, the
// feedback tap that averages the modulator's last two outputs, the two
// phase-bit trick that makes the hi-hat and cymbal metallic -- are kept.
// What is approximated is the envelope generator's stepped counters, which
// are replaced by continuous rates fitted to the datasheet's timing table:
// an attack rate of 1 takes 2.8 s over the full range, a decay of 1 takes
// 39 s, each step of four in the effective rate halves that.
//
// The two timers are the presence test's, not a clock: a started timer reads
// as expired at once. No program in the corpus has been seen pacing itself
// off them, and a program that did would run its tune at the speed of its
// own polling loop rather than stall.

const OPL_RATE = 49716;
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// Key-scale level, in the chip's 0.1875 dB units before the per-operator
// shift: 0 = off, 1 = 3 dB/oct, 2 = 1.5 dB/oct, 3 = 6 dB/oct. The register
// order is the one the hardware has, not the one the AdLib manual printed.
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 57, 58, 59, 60, 61, 62, 63];
const KSL_SHIFT = [31, 1, 2, 0];
const DB_STEP = 0.1875;
const ENV_MAX = 96;              // dB; the envelope's floor, silence
const SIN_LEN = 1024;
// Full-range envelope times, in seconds, at an effective rate index of 4
// (register rate 1, no key scaling). Each +4 in the index halves the time.
const ATTACK_BASE = 2.826;
const DECAY_BASE = 39.28;
const VIB_HZ = 6.07, TREM_HZ = 3.7;

// amplitude for an attenuation of i * 0.1875 dB
const AMP = new Float32Array(Math.ceil(ENV_MAX / DB_STEP) + 1);
for (let i = 0; i < AMP.length; i++) AMP[i] = Math.pow(10, -i * DB_STEP / 20);
AMP[AMP.length - 1] = 0;
// The four waveforms, one table each, over one cycle.
const WAVES = [0, 1, 2, 3].map((w) => {
  const t = new Float32Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const s = Math.sin(2 * Math.PI * (i + 0.5) / SIN_LEN);
    t[i] = w === 0 ? s : w === 1 ? Math.max(0, s) : w === 2 ? Math.abs(s)
      : ((i & (SIN_LEN / 2 - 1)) < SIN_LEN / 4 ? Math.abs(s) : 0);
  }
  return t;
});

const OFF = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

class Op {
  constructor() {
    this.am = 0; this.vib = 0; this.eg = 0; this.ksr = 0; this.mult = 1;
    this.ksl = 0; this.tl = 63; this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.wf = 0;
    this.phase = 0;               // cycles, [0, 1)
    this.inc = 0;                 // cycles per output sample, before vibrato
    this.state = OFF;
    this.env = ENV_MAX;           // dB of attenuation
    this.out = 0; this.prev = 0;  // last two outputs, for the feedback tap
    this.kslDb = 0;
    this.attackK = 0;             // per-sample multiplier on env during attack
    this.decayDb = 0;             // dB per sample during decay
    this.releaseDb = 0;
    this.keyed = 0;
  }
}

class Channel {
  constructor(op1, op2) {
    this.op1 = op1; this.op2 = op2;
    this.fnum = 0; this.block = 0; this.key = 0; this.fb = 0; this.cnt = 0;
    this.fbScale = 0;
  }
}

class Opl {
  constructor(rate = OPL_RATE) {
    this.ops = [];
    for (let i = 0; i < 18; i++) this.ops.push(new Op());
    this.ch = [];
    for (let c = 0; c < 9; c++) {
      const s = ((c / 3) | 0) * 6 + c % 3;
      this.ch.push(new Channel(this.ops[s], this.ops[s + 3]));
    }
    this.regs = new Uint8Array(256);
    this.waveSel = 0;
    this.rhythm = 0; this.rhythmKeys = 0;
    this.tremDeep = 0; this.vibDeep = 0;
    this.timerStarted = 0;
    this.lfo = 0;                 // seconds, for the two LFOs
    this.noise = 1;               // 23-bit LFSR
    this.writes = 0; this.keyOns = 0;
    this.setRate(rate);
  }

  setRate(rate) {
    if (rate === this.rate) return;
    this.rate = rate;
    for (let c = 0; c < 9; c++) this.refreshChannel(c);
  }

  // The status register: bit 7 = any timer flag, 6 = timer 1, 5 = timer 2.
  status() { return this.timerStarted ? 0xC0 : 0x00; }

  active() {
    for (const op of this.ops) if (op.state !== OFF) return true;
    return false;
  }

  write(reg, v) {
    this.writes++;
    reg &= 0xFF; v &= 0xFF;
    this.regs[reg] = v;
    if (reg === 0x01) { this.waveSel = (v >> 5) & 1; return; }
    if (reg === 0x04) { this.timerStarted = (v & 0x80) ? 0 : (v & 3 ? 1 : 0); return; }
    if (reg === 0xBD) {
      this.tremDeep = (v >> 7) & 1; this.vibDeep = (v >> 6) & 1;
      const rhythm = (v >> 5) & 1;
      if (rhythm !== this.rhythm) {
        this.rhythm = rhythm;
        if (!rhythm) for (let c = 6; c < 9; c++) this.keyChannel(c, this.ch[c].key);
      }
      if (rhythm) {
        this.keyOp(this.ops[12], v & 0x10); this.keyOp(this.ops[13], v & 0x10);
        this.keyOp(this.ops[14], v & 0x01);   // hi-hat
        this.keyOp(this.ops[15], v & 0x08);   // snare
        this.keyOp(this.ops[16], v & 0x04);   // tom
        this.keyOp(this.ops[17], v & 0x02);   // cymbal
      }
      this.rhythmKeys = v & 0x1F;
      return;
    }
    const hi = reg & 0xE0, lo = reg & 0x1F;
    if (hi >= 0x20 && hi <= 0x80 || hi === 0xE0) {
      if ((lo & 7) > 5 || lo > 0x15) return;
      const s = (lo >> 3) * 6 + (lo & 7);
      const op = this.ops[s];
      const c = ((s / 6) | 0) * 3 + (s % 6) % 3;
      if (hi === 0x20) {
        op.am = (v >> 7) & 1; op.vib = (v >> 6) & 1; op.eg = (v >> 5) & 1;
        op.ksr = (v >> 4) & 1; op.mult = MULT[v & 15];
        this.refreshOp(op, this.ch[c]);
      } else if (hi === 0x40) {
        op.ksl = v >> 6; op.tl = v & 63;
        this.refreshOp(op, this.ch[c]);
      } else if (hi === 0x60) {
        op.ar = v >> 4; op.dr = v & 15;
        this.refreshOp(op, this.ch[c]);
      } else if (hi === 0x80) {
        op.sl = v >> 4; op.rr = v & 15;
        this.refreshOp(op, this.ch[c]);
      } else {
        op.wf = this.waveSel ? (v & 3) : 0;
      }
      return;
    }
    if (hi === 0xA0 && lo <= 8) {
      const ch = this.ch[lo];
      ch.fnum = (ch.fnum & 0x300) | v;
      this.refreshChannel(lo);
      return;
    }
    if (hi === 0xA0 && lo >= 0x10 && lo <= 0x18) {
      const c = lo - 0x10, ch = this.ch[c];
      ch.fnum = (ch.fnum & 0xFF) | ((v & 3) << 8);
      ch.block = (v >> 2) & 7;
      this.refreshChannel(c);
      const key = (v >> 5) & 1;
      if (key !== ch.key) { ch.key = key; if (!(this.rhythm && c >= 6)) this.keyChannel(c, key); }
      return;
    }
    if (hi === 0xC0 && lo <= 8) {
      const ch = this.ch[lo];
      ch.fb = (v >> 1) & 7; ch.cnt = v & 1;
      // (prev + out) >> (9 - fb) in the chip's 13-bit output units, into a
      // 10-bit phase: as a fraction of a cycle, that is 2^(fb - 7) per unit.
      ch.fbScale = ch.fb ? Math.pow(2, ch.fb - 7) : 0;
    }
  }

  keyChannel(c, on) {
    const ch = this.ch[c];
    this.keyOp(ch.op1, on); this.keyOp(ch.op2, on);
  }

  keyOp(op, on) {
    on = on ? 1 : 0;
    if (on === op.keyed) return;
    op.keyed = on;
    if (on) {
      this.keyOns++;
      op.phase = 0;
      op.state = ATTACK;
      if (op.attackK === 0) { op.env = 0; op.state = DECAY; }
    } else if (op.state !== OFF) {
      op.state = RELEASE;
    }
  }

  refreshChannel(c) {
    const ch = this.ch[c];
    this.refreshOp(ch.op1, ch); this.refreshOp(ch.op2, ch);
  }

  // Everything about an operator that depends on its own registers and its
  // channel's pitch: phase increment, key-scale level and the three rates.
  refreshOp(op, ch) {
    op.inc = ch.fnum * Math.pow(2, ch.block) / (1 << 20) * op.mult * (OPL_RATE / this.rate);
    const ksl = Math.max(0, (KSL_ROM[ch.fnum >> 6] << 2) - ((8 - ch.block) << 5));
    op.kslDb = (ksl >> KSL_SHIFT[op.ksl]) * DB_STEP;
    const ksrBits = (ch.block << 1) | (ch.fnum >> 9);
    const ksr = op.ksr ? ksrBits : (ksrBits >> 2);
    const index = (r) => (r ? Math.min(63, r * 4 + ksr) : 0);
    const ar = index(op.ar), dr = index(op.dr), rr = index(op.rr);
    // Attack: env decays toward 0 dB like 96 * e^(-t / tau), settling within
    // a step of the floor at the table's time.
    if (ar === 0) op.attackK = 1;
    else if (ar >= 60) op.attackK = 0;
    else {
      const secs = ATTACK_BASE * Math.pow(2, -(ar - 4) / 4);
      op.attackK = Math.exp(-Math.log(ENV_MAX / DB_STEP) / (secs * this.rate));
    }
    op.decayDb = dr === 0 ? 0 : ENV_MAX / (DECAY_BASE * Math.pow(2, -(dr - 4) / 4) * this.rate);
    op.releaseDb = rr === 0 ? 0 : ENV_MAX / (DECAY_BASE * Math.pow(2, -(rr - 4) / 4) * this.rate);
  }

  // One envelope step; returns the operator's attenuation in dB, or ENV_MAX.
  envelope(op) {
    switch (op.state) {
      case ATTACK:
        op.env *= op.attackK;
        if (op.env < DB_STEP) { op.env = 0; op.state = DECAY; }
        break;
      case DECAY: {
        const sl = op.sl === 15 ? ENV_MAX : op.sl * 3;
        op.env += op.decayDb;
        if (op.env >= sl) { op.env = sl; op.state = op.eg ? SUSTAIN : RELEASE; }
        break;
      }
      case SUSTAIN:
        break;
      case RELEASE:
        op.env += op.releaseDb;
        if (op.env >= ENV_MAX) { op.env = ENV_MAX; op.state = OFF; }
        break;
      default:
        return ENV_MAX;
    }
    return op.env;
  }

  // One output sample, the channel sum normalized so that eight operators at
  // full scale reach 1.0 -- the chip's own 16-bit headroom.
  next() {
    const dt = 1 / this.rate;
    this.lfo += dt;
    const vib = Math.sin(2 * Math.PI * VIB_HZ * this.lfo) * (this.vibDeep ? 14 : 7) / 1200;
    const vibMul = Math.pow(2, vib);
    const trem = (1 - Math.cos(2 * Math.PI * TREM_HZ * this.lfo)) / 2 * (this.tremDeep ? 4.8 : 1);
    // 23-bit LFSR, one step per sample, as the chip's noise source.
    const n = this.noise;
    this.noise = ((n >> 1) | (((n ^ (n >> 14) ^ (n >> 15) ^ (n >> 22)) & 1) << 22)) >>> 0;
    const noiseBit = n & 1;

    let mix = 0;
    const melodic = this.rhythm ? 6 : 9;
    for (let c = 0; c < melodic; c++) {
      const ch = this.ch[c];
      const o1 = ch.op1, o2 = ch.op2;
      if (o1.state === OFF && o2.state === OFF) continue;
      const a1 = this.opOut(o1, (o1.prev + o1.out) * ch.fbScale, trem, vibMul);
      const a2 = this.opOut(o2, ch.cnt ? 0 : a1 * 4, trem, vibMul);
      mix += ch.cnt ? a1 + a2 : a2;
    }
    if (this.rhythm) {
      const bd = this.ch[6], hh = this.ops[14], sd = this.ops[15], tom = this.ops[16], tc = this.ops[17];
      if (bd.op1.state !== OFF || bd.op2.state !== OFF) {
        const a1 = this.opOut(bd.op1, (bd.op1.prev + bd.op1.out) * bd.fbScale, trem, vibMul);
        const a2 = this.opOut(bd.op2, bd.cnt ? 0 : a1 * 4, trem, vibMul);
        mix += (bd.cnt ? a1 + a2 : a2) * 2;
      }
      // The hi-hat, snare and cymbal take their phase from bits of the
      // hi-hat's and cymbal's own phase counters and the noise bit.
      const p14 = (hh.phase * SIN_LEN) & (SIN_LEN - 1), p17 = (tc.phase * SIN_LEN) & (SIN_LEN - 1);
      const phasebit = ((p14 & 0x08) | (((p14 >> 5) ^ p14) & 0x04) | (((p17 >> 2) ^ p17) & 0x08)) ? 1 : 0;
      if (hh.state !== OFF) {
        const ph = (phasebit << 9) | (0x34 << ((phasebit ^ noiseBit) << 1));
        mix += this.opAt(hh, ph / SIN_LEN, trem, vibMul) * 2;
      }
      if (sd.state !== OFF) {
        const ph = (0x100 << ((p14 >> 8) & 1)) ^ (noiseBit << 8);
        mix += this.opAt(sd, ph / SIN_LEN, trem, vibMul) * 2;
      }
      if (tom.state !== OFF) mix += this.opOut(tom, 0, trem, vibMul) * 2;
      if (tc.state !== OFF) {
        const ph = (phasebit << 9) | 0x100;
        mix += this.opAt(tc, ph / SIN_LEN, trem, vibMul) * 2;
      }
    }
    return mix / 8;
  }

  // An operator's next output with `mod` cycles of phase modulation added.
  opOut(op, mod, trem, vibMul) {
    const env = this.envelope(op);
    op.phase += op.inc * (op.vib ? vibMul : 1);
    if (op.phase >= 1) op.phase -= Math.floor(op.phase);
    const atten = env + op.tl * 0.75 + op.kslDb + (op.am ? trem : 0);
    const v = this.sample(op, op.phase + mod, atten);
    op.prev = op.out; op.out = v;
    return v;
  }

  // The rhythm operators: their own phase counter still runs (the hi-hat's
  // and cymbal's are read by the phase-bit trick), but the sample is taken
  // at the phase the trick produced.
  opAt(op, phase, trem, vibMul) {
    const env = this.envelope(op);
    op.phase += op.inc * (op.vib ? vibMul : 1);
    if (op.phase >= 1) op.phase -= Math.floor(op.phase);
    const atten = env + op.tl * 0.75 + op.kslDb + (op.am ? trem : 0);
    const v = this.sample(op, phase, atten);
    op.prev = op.out; op.out = v;
    return v;
  }

  sample(op, phase, atten) {
    if (atten >= ENV_MAX) return 0;
    const i = Math.round(atten / DB_STEP);
    const idx = Math.floor(phase * SIN_LEN) & (SIN_LEN - 1);
    return WAVES[op.wf][idx] * AMP[i];
  }
}

module.exports = { Opl, OPL_RATE };
