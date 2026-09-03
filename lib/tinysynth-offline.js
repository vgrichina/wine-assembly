'use strict';

// Deterministic offline companion to WebAudioTinySynth. The browser synth
// builds an AudioNode graph, which does not exist in the direct Node CLI. This
// renderer reuses its quality-1 GM tables and mirrors that graph's oscillator,
// FM/AM routing, parameter glides, envelopes, pan, and short ambience in PCM.

let cachedTables = null;
const compiledTables = new Map();
const TAU = Math.PI * 2;
const WAVE_BITS = 13;
const WAVE_SIZE = 1 << WAVE_BITS;
const WAVE_MASK = WAVE_SIZE - 1;
const sineTable = new Float32Array(WAVE_SIZE);
const w9999Table = new Float32Array(WAVE_SIZE);
for (let i = 0; i < WAVE_SIZE; i++) {
  const phase = i / WAVE_SIZE * TAU;
  sineTable[i] = Math.sin(phase);
  w9999Table[i] = (Math.sin(phase) + Math.sin(phase * 2)
    + Math.sin(phase * 3) + Math.sin(phase * 4)) * 0.32;
}

function tableSample(table, turn) {
  const position = turn * WAVE_SIZE;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = table[index & WAVE_MASK];
  return a + (table[(index + 1) & WAVE_MASK] - a) * fraction;
}

function tinySynthTables() {
  if (cachedTables) return cachedTables;
  const WebAudioTinySynth = require('./vendor/webaudio-tinysynth');
  const realSetInterval = global.setInterval;
  try {
    // The constructor installs a browser housekeeping interval even with no
    // AudioContext. No AudioNodes are needed to materialize its timbre tables.
    global.setInterval = () => ({ unref() {} });
    const synth = new WebAudioTinySynth({ quality: 1, internalcontext: 0, voices: 64 });
    const clone = list => list.map(entry => ({
      name: entry.name,
      p: (entry.p || []).map(op => ({ ...op })),
    }));
    cachedTables = { program: clone(synth.program), drums: clone(synth.drummap) };
  } finally {
    global.setInterval = realSetInterval;
  }
  return cachedTables;
}

function timbreKey(isDrum, number) {
  return `${isDrum ? 'd' : 'p'}${number}`;
}

function compileTimbre(definition, isDrum, number, rate) {
  const key = `${timbreKey(isDrum, number)}@${rate}`;
  if (compiledTables.has(key)) return compiledTables.get(key);
  const source = definition && definition.p && definition.p.length
    ? definition.p : tinySynthTables().program[0].p;
  const ops = source.map((raw, index) => {
    const op = {
      index, route: Number(raw.g) | 0, wave: raw.w || 'sine',
      ratio: Number(raw.t) || 0, offset: Number(raw.f) || 0,
      volume: Number.isFinite(Number(raw.v)) ? Number(raw.v) : 0.5,
      attack: Math.max(0, Number(raw.a) || 0),
      hold: Math.max(0, Number(raw.h) || 0),
      decay: Math.max(0, Number(raw.d) || 0),
      sustain: Number.isFinite(Number(raw.s)) ? Number(raw.s) : 0,
      release: Math.max(0, Number(raw.r) || 0),
      pitchTarget: Number.isFinite(Number(raw.p)) ? Number(raw.p) : 1,
      pitchTime: Math.max(0, Number(raw.q) || 0),
      keyScale: Number(raw.k) || 0,
    };
    op.decayMul = op.decay ? Math.exp(-1 / (op.decay * rate)) : 0;
    op.releaseMul = op.release ? Math.exp(-1 / (op.release * rate)) : 0;
    op.pitchMul = op.pitchTime ? Math.exp(-1 / (op.pitchTime * rate)) : 0;
    return op;
  });
  const compiled = { ops, drumLife: isDrum ? Math.max(0.005, ops[0].decay * 3.5) : 0 };
  compiledTables.set(key, compiled);
  return compiled;
}

function wave(kind, phase, rate) {
  const turn = phase - Math.floor(phase);
  switch (kind) {
    case 'square': return turn < 0.5 ? 1 : -1;
    case 'sawtooth': return turn * 2 - 1;
    case 'triangle': return 1 - 4 * Math.abs(turn - 0.5);
    case 'n0':
    case 'n1': {
      // TinySynth loops one shared half-second noise buffer. Hashing its source
      // sample index gives the same deterministic sharing and playback-rate
      // behaviour without allocating or interpolating a buffer for every note.
      let x = Math.floor(phase * rate / 440) % Math.max(1, rate >> 1);
      x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
      x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
      const white = (x >>> 0) / 0x80000000 - 1;
      if (kind === 'n0') return white;
      // n1 is TinySynth's denser, resonant noise table. The stable partials
      // retain its metallic character while avoiding 64 oscillators/sample.
      return white * 0.55 + tableSample(sineTable, (turn * 7) % 1) * 0.25
        + tableSample(sineTable, (turn * 13.37) % 1) * 0.2;
    }
    case 'w9999':
      // createPeriodicWave("w9999") treats its four 9 digits as equal sine
      // harmonic coefficients; Web Audio normalizes the resulting wave.
      return tableSample(w9999Table, turn);
    default: return tableSample(sineTable, turn);
  }
}

function envelopeAt(op, age, releaseAt) {
  if (age < 0) return 0;
  if (op.attack && age < op.attack) return age / op.attack;
  if (age < op.attack + op.hold) return 1;
  const decayAge = Math.max(0, age - op.attack - op.hold);
  let level = op.decay
    ? op.sustain + (1 - op.sustain) * Math.exp(-decayAge / op.decay)
    : op.sustain;
  if (age <= releaseAt) return level;
  const releaseDecayAge = Math.max(0, releaseAt - op.attack - op.hold);
  level = op.decay
    ? op.sustain + (1 - op.sustain) * Math.exp(-releaseDecayAge / op.decay)
    : op.sustain;
  return op.release ? level * Math.exp(-(age - releaseAt) / op.release) : 0;
}

function renderTinySynthNotes(smf, options = {}) {
  const notes = smf && smf.notes;
  if (!notes || !notes.length) return null;
  const tables = tinySynthTables();
  const rate = Math.max(8000, options.sampleRate | 0 || 16000);
  const firstStart = Number(options.firstStart || 0);
  const maxDuration = Math.max(0.1, Number(options.maxDuration || 15 * 60));
  const duration = Math.max(0, Math.min(maxDuration, (smf.duration || 0) - firstStart));
  if (!(duration > 0)) return null;
  const frames = Math.ceil(duration * rate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const programs = new Set();
  let renderedNotes = 0;

  for (const note of notes) {
    const relativeStart = note.start - firstStart;
    if (relativeStart >= duration || relativeStart + note.dur <= 0) continue;
    const drum = note.ch === 9 && note.note >= 35 && note.note <= 81;
    const number = drum ? note.note : Math.max(0, Math.min(127, note.program | 0));
    const definition = drum ? tables.drums[number - 35] : tables.program[number];
    const timbre = compileTimbre(definition, drum, number, rate);
    const releaseAt = drum ? timbre.drumLife : Math.max(0.03, note.dur);
    // _releaseNote prunes the whole AudioNode voice after operator zero's
    // release constant times TinySynth's releaseRatio (3.5).
    const tail = drum ? 0 : Math.min(2, timbre.ops[0].release * 3.5);
    const from = Math.max(0, Math.floor(relativeStart * rate));
    const to = Math.min(frames, Math.ceil((relativeStart + releaseAt + tail) * rate));
    if (to <= from) continue;
    const base = 440 * Math.pow(2, (note.note - 69) / 12);
    const velocity = (note.vel * note.vel) / 16384;
    const pan = Math.max(-1, Math.min(1,
      ((Number.isFinite(note.pan) ? note.pan : 64) - 64) / 64));
    const theta = (pan + 1) * Math.PI / 4;
    const gainL = Math.cos(theta), gainR = Math.sin(theta);
    const channelGain = Math.max(0,
      Number.isFinite(note.channelGain) ? note.channelGain : 1);
    const count = timbre.ops.length;
    const phases = new Float64Array(count);
    const frequencies = new Float64Array(count);
    const scales = new Float64Array(count);
    const env = new Float64Array(count);
    const decayPart = new Float64Array(count);
    const pitchPart = new Float64Array(count);
    const freqMod = new Float64Array(count);
    const gainMod = new Float64Array(count);
    const startAge = from / rate - relativeStart;

    for (let oi = 0; oi < count; oi++) {
      const op = timbre.ops[oi];
      const target = op.route ? (op.route > 10 ? op.route - 11 : op.route - 1) : -1;
      const parentFrequency = target >= 0 && target < oi ? frequencies[target] : base;
      frequencies[oi] = Math.max(0, parentFrequency * op.ratio + op.offset);
      scales[oi] = (op.route === 0 ? velocity : op.route > 10 ? 1 : parentFrequency)
        * op.volume * (op.keyScale ? Math.pow(2, (note.note - 60) / 12 * op.keyScale) : 1);
      env[oi] = envelopeAt(op, startAge, releaseAt);
      const decayAge = Math.max(0, startAge - op.attack - op.hold);
      decayPart[oi] = Math.exp(-decayAge / Math.max(op.decay, 1e-9));
      pitchPart[oi] = Math.exp(-startAge / Math.max(op.pitchTime, 1e-9));
      phases[oi] = frequencies[oi] * startAge;
    }
    programs.add(drum ? 128 + number : number);
    renderedNotes++;

    let age = startAge;
    for (let i = from; i < to; i++, age += 1 / rate) {
      freqMod.fill(0); gainMod.fill(0);
      let sample = 0;
      // Modulators always point to an earlier operator in TinySynth's tables,
      // so evaluating backwards supplies their AudioParam values first.
      for (let oi = count - 1; oi >= 0; oi--) {
        const op = timbre.ops[oi];
        if (age < op.attack) env[oi] = op.attack ? age / op.attack : 1;
        else if (age <= releaseAt) {
          if (age >= op.attack + op.hold) {
            env[oi] = op.sustain + (1 - op.sustain) * decayPart[oi];
            decayPart[oi] *= op.decayMul;
          }
        } else {
          env[oi] *= op.releaseMul;
        }
        let frequency = frequencies[oi];
        if (op.pitchTarget !== 1) {
          frequency *= op.pitchTarget + (1 - op.pitchTarget) * pitchPart[oi];
          pitchPart[oi] *= op.pitchMul;
        }
        frequency = Math.max(0, frequency + freqMod[oi]);
        const signal = wave(op.wave, phases[oi], rate)
          * Math.max(-4, Math.min(4, env[oi] * scales[oi] + gainMod[oi]));
        phases[oi] += frequency / rate;
        if (!op.route) sample += signal;
        else if (op.route > 10) {
          const target = op.route - 11;
          if (target >= 0 && target < count) gainMod[target] += signal;
        } else {
          const target = op.route - 1;
          if (target >= 0 && target < count) freqMod[target] += signal;
        }
      }
      // Browser TinySynth applies masterVol=.5 then a compressor. tanh is a
      // deterministic soft-knee approximation with similar peak containment.
      const value = sample * channelGain * 0.92;
      left[i] += value * gainL;
      right[i] += value * gainR;
    }
  }

  // TinySynth quality mode mixes a half-second stochastic convolution tail.
  // Three cross-channel combs retain comparable space at a tiny fixed cost.
  for (const [delayLeftMs, delayRightMs, amount] of [
    [29, 37, 0.24], [71, 83, 0.14], [127, 149, 0.075],
  ]) {
    const delayLeft = Math.round(rate * delayLeftMs / 1000);
    const delayRight = Math.round(rate * delayRightMs / 1000);
    const delay = Math.max(delayLeft, delayRight);
    for (let i = delay; i < frames; i++) {
      const l = left[i - delayRight], r = right[i - delayLeft];
      left[i] += r * amount;
      right[i] += l * amount;
    }
  }

  const bytes = Buffer.allocUnsafe(frames * 4);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    // The browser graph's compressor sits after the channel sum. A second soft
    // knee here handles dense arrangements while preserving quiet articulation.
    const l = Math.tanh(left[i] * 0.88);
    const r = Math.tanh(right[i] * 0.88);
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    bytes.writeInt16LE(Math.round(l * 32767), i * 4);
    bytes.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
  }
  return {
    bytes, sampleRate: rate, channels: 2, bits: 16,
    peak, renderedNotes, instruments: programs.size,
  };
}

module.exports = { renderTinySynthNotes, tinySynthTables };
