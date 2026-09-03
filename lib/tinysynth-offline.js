'use strict';

// Deterministic offline companion to WebAudioTinySynth. The browser synth
// builds an AudioNode graph, which does not exist in the direct Node CLI. We
// reuse its General MIDI timbre tables and render their carriers, envelopes,
// simple FM operators, drum noise, stereo pan, and a short ambience tail into
// PCM on the frozen guest timeline.

let cachedTables = null;

function tinySynthTables() {
  if (cachedTables) return cachedTables;
  const WebAudioTinySynth = require('./vendor/webaudio-tinysynth');
  const realSetInterval = global.setInterval;
  try {
    // TinySynth's constructor installs a browser housekeeping interval even
    // with internalcontext=0. No AudioNodes are needed merely to materialize
    // the quality-1 program and drum definitions.
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

function oscillator(kind, phase, noiseKey) {
  const turn = phase - Math.floor(phase);
  switch (kind) {
    case 'square': return turn < 0.5 ? 1 : -1;
    case 'sawtooth': return turn * 2 - 1;
    case 'triangle': return 1 - 4 * Math.abs(turn - 0.5);
    case 'n0':
    case 'n1': {
      let x = (noiseKey ^ Math.imul((phase * 22050) | 0, 0x45d9f3b)) | 0;
      x ^= x >>> 16; x = Math.imul(x, 0x45d9f3b); x ^= x >>> 16;
      return (x >>> 0) / 0x80000000 - 1;
    }
    case 'w9999':
      return Math.sin(turn * Math.PI * 2) * 0.78
        + Math.sin(turn * Math.PI * 6) * 0.16
        + Math.sin(turn * Math.PI * 10) * 0.06;
    default: return Math.sin(turn * Math.PI * 2);
  }
}

function envelope(op, age, heldFor) {
  if (age < 0) return 0;
  const attack = Math.max(0, Number(op.a) || 0);
  const hold = Math.max(0, Number(op.h) || 0);
  const decay = Math.max(0.001, Number(op.d) || 0.001);
  const sustain = Math.max(0, Number.isFinite(op.s) ? op.s : 0);
  let level;
  if (attack && age < attack) level = age / attack;
  else {
    const decayingFor = Math.max(0, age - attack - hold);
    level = sustain + (1 - sustain) * Math.exp(-decayingFor / decay);
  }
  if (age <= heldFor) return level;
  const release = Math.min(1.5, Math.max(0.015, (Number(op.r) || 0.05) * 3.5));
  return level * Math.exp(-(age - heldFor) / release);
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
    const program = Math.max(0, Math.min(127, note.program | 0));
    const definition = drum ? tables.drums[note.note - 35] : tables.program[program];
    const operators = definition && definition.p && definition.p.length
      ? definition.p : tables.program[0].p;
    const carriers = operators.map((op, index) => ({ op, index })).filter(x => !x.op.g);
    if (!carriers.length) carriers.push({ op: operators[0], index: 0 });
    const heldFor = Math.max(0.03, Math.min(6, note.dur));
    // TinySynth contains a few deliberately huge release constants intended
    // for a real-time voice limiter. Rendering each of those tails per note
    // would turn a dense score into billions of samples; bound the audible
    // tail just as the 64-voice browser synth effectively does.
    const release = Math.max(...carriers.map(x =>
      Math.min(1.5, Math.max(0.015, (Number(x.op.r) || 0.05) * 3.5))));
    const from = Math.max(0, Math.floor(relativeStart * rate));
    const to = Math.min(frames, Math.ceil((relativeStart + heldFor + Math.min(2, release * 4)) * rate));
    const base = 440 * Math.pow(2, (note.note - 69) / 12);
    const velocity = (note.vel * note.vel) / 16384;
    const pan = Math.max(-1, Math.min(1, ((Number.isFinite(note.pan) ? note.pan : 64) - 64) / 64));
    const theta = (pan + 1) * Math.PI / 4;
    const gainL = Math.cos(theta);
    const gainR = Math.sin(theta);
    const channelGain = Math.max(0, Number.isFinite(note.channelGain) ? note.channelGain : 1);
    const noiseKey = Math.imul((note.note + 1) * (note.ch + 17), 0x9e3779b1);
    programs.add(drum ? 128 + note.note : program);
    renderedNotes++;

    for (let i = from; i < to; i++) {
      const age = i / rate - relativeStart;
      let sample = 0;
      for (const { op, index } of carriers) {
        const freq = Math.max(1, base * (Number(op.t) || 1) + (Number(op.f) || 0));
        let modulation = 0;
        for (const mod of operators) {
          if ((mod.g | 0) !== index + 1 || (mod.g | 0) > 10) continue;
          const modFreq = Math.max(1, freq * (Number(mod.t) || 1) + (Number(mod.f) || 0));
          modulation += oscillator(mod.w, age * modFreq, noiseKey ^ index)
            * (Number(mod.v) || 0) * 0.08;
        }
        const wave = oscillator(op.w, age * freq + modulation, noiseKey ^ index);
        const keyScale = op.k ? Math.pow(2, (note.note - 60) / 12 * op.k) : 1;
        sample += wave * envelope(op, age, heldFor) * (Number(op.v) || 0.5) * keyScale;
      }
      const value = sample * velocity * channelGain * 0.72;
      left[i] += value * gainL;
      right[i] += value * gainR;
    }
  }

  // TinySynth uses a convolver in quality mode. A deterministic pair of short
  // cross-channel delays supplies a modest equivalent sense of space without
  // requiring a real-time AudioContext.
  for (const [delayMs, amount] of [[37, 0.13], [83, 0.07]]) {
    const delay = Math.round(rate * delayMs / 1000);
    for (let i = delay; i < frames; i++) {
      const l = left[i - delay], r = right[i - delay];
      left[i] += r * amount;
      right[i] += l * amount;
    }
  }

  const bytes = Buffer.allocUnsafe(frames * 4);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    // Soft limiting controls dense MIDI arrangements without flattening the
    // dynamics of quieter instruments.
    const l = Math.tanh(left[i] * 0.82);
    const r = Math.tanh(right[i] * 0.82);
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
