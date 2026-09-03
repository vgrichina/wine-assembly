#!/usr/bin/env node
'use strict';

// Render one MIDI through the production browser WebAudioTinySynth graph and
// through the deterministic CLI companion, then put the two PCM files and
// objective comparison metrics beside each other.  The browser reference uses
// an OfflineAudioContext: it is the same oscillator/gain/compressor/convolver
// implementation as live playback, without wall-clock capture jitter.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const puppeteer = require('puppeteer');
const WebAudioTinySynth = require('../lib/vendor/webaudio-tinysynth');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const midiPath = path.resolve(value('midi', path.join(ROOT, 'test/binaries/pinball/PINBALL.MID')));
const seconds = Math.max(1, Number(value('seconds', 20)) || 20);
const rate = Math.max(8000, Number(value('rate', 44100)) || 44100);
const outDir = path.resolve(value('out-dir', path.join(ROOT, 'recordings/tinysynth-comparison')));
const offlineOnly = args.includes('--offline-only');
const existingReference = value('reference', '');
const rendererPath = path.resolve(value('renderer', path.join(ROOT, 'lib/tinysynth-offline.js')));
const { renderTinySynthNotes } = require(rendererPath);
const chrome = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

function midiModel(bytes) {
  const realSetInterval = global.setInterval;
  let synth;
  try {
    global.setInterval = () => ({ unref() {} });
    synth = new WebAudioTinySynth({ quality: 1, internalcontext: 0, voices: 64 });
    const param = { value: 0, setValueAtTime(value) { this.value = value; } };
    synth.chmod = Array.from({ length: 16 }, () => ({ gain: { ...param } }));
    synth.chvol = Array.from({ length: 16 }, () => ({ gain: { ...param } }));
    synth.chpan = Array.from({ length: 16 }, () => ({ pan: { ...param } }));
    synth.loadMIDI(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } finally {
    global.setInterval = realSetInterval;
  }
  if (!synth.song || !synth.song.ev.length) throw new Error('MIDI parsed with no events');
  const events = synth.song.ev.map((event, order) => ({ ...event, order }))
    .sort((a, b) => a.t - b.t || a.order - b.order);
  let tempo = 120, lastTick = 0, now = 0;
  for (const event of events) {
    now += (event.t - lastTick) * 60 / (tempo * (synth.song.timebase / 4));
    lastTick = event.t;
    event.time = now;
    if (event.m[0] === 0xff51) tempo = event.m[1];
  }

  const programs = new Array(16).fill(0);
  const pans = new Array(16).fill(64);
  const volumes = new Array(16).fill(100);
  const expressions = new Array(16).fill(127);
  const open = new Map();
  const notes = [];
  for (const event of events) {
    const message = event.m;
    const op = message[0] & 0xf0;
    const ch = message[0] & 15;
    if (op === 0xc0) programs[ch] = message[1];
    else if (op === 0xb0) {
      if (message[1] === 7) volumes[ch] = message[2];
      else if (message[1] === 10) pans[ch] = message[2];
      else if (message[1] === 11) expressions[ch] = message[2];
    } else if (op === 0x90 && message[2]) {
      const key = `${ch}:${message[1]}`;
      if (!open.has(key)) open.set(key, []);
      open.get(key).push({
        start: event.time, ch, note: message[1], vel: message[2],
        program: programs[ch], pan: pans[ch],
        channelGain: Math.pow(volumes[ch] / 100, 2) * Math.pow(expressions[ch] / 127, 2),
      });
    } else if (op === 0x80 || (op === 0x90 && !message[2])) {
      const key = `${ch}:${message[1]}`;
      const stack = open.get(key);
      const start = stack && stack.shift();
      if (start && event.time > start.start) notes.push({
        ...start, dur: Math.max(0.03, event.time - start.start),
      });
    }
  }
  notes.sort((a, b) => a.start - b.start);
  return { notes, events, duration: events[events.length - 1].time };
}

function wav16(left, right, sampleRate) {
  const frames = Math.min(left.length, right.length);
  const out = Buffer.alloc(44 + frames * 4);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 4, 28);
  out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return out;
}

function splitPcm16(bytes) {
  const frames = bytes.length >> 2;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = bytes.readInt16LE(i * 4) / 32768;
    right[i] = bytes.readInt16LE(i * 4 + 2) / 32768;
  }
  return [left, right];
}

function metrics(a, b) {
  const frames = Math.min(a[0].length, b[0].length);
  let aa = 0, bb = 0, ab = 0, err = 0, peakA = 0, peakB = 0;
  let diffA = 0, diffB = 0, midA = 0, sideA = 0, midB = 0, sideB = 0;
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < frames; i++) {
    const x = a[ch][i], y = b[ch][i], d = x - y;
    aa += x * x; bb += y * y; ab += x * y; err += d * d;
    if (i) {
      const dx = x - a[ch][i - 1], dy = y - b[ch][i - 1];
      diffA += dx * dx; diffB += dy * dy;
    }
    peakA = Math.max(peakA, Math.abs(x)); peakB = Math.max(peakB, Math.abs(y));
  }
  for (let i = 0; i < frames; i++) {
    const am = (a[0][i] + a[1][i]) * 0.5, as = (a[0][i] - a[1][i]) * 0.5;
    const bm = (b[0][i] + b[1][i]) * 0.5, bs = (b[0][i] - b[1][i]) * 0.5;
    midA += am * am; sideA += as * as; midB += bm * bm; sideB += bs * bs;
  }
  const block = Math.max(1, Math.round(rate * 0.02));
  const envA = [], envB = [];
  for (let from = 0; from < frames; from += block) {
    let ea = 0, eb = 0, n = 0;
    for (let i = from; i < Math.min(frames, from + block); i++, n++) {
      ea += a[0][i] * a[0][i] + a[1][i] * a[1][i];
      eb += b[0][i] * b[0][i] + b[1][i] * b[1][i];
    }
    envA.push(Math.sqrt(ea / Math.max(1, n * 2)));
    envB.push(Math.sqrt(eb / Math.max(1, n * 2)));
  }
  const meanA = envA.reduce((sum, x) => sum + x, 0) / envA.length;
  const meanB = envB.reduce((sum, x) => sum + x, 0) / envB.length;
  let envAA = 0, envBB = 0, envAB = 0;
  for (let i = 0; i < envA.length; i++) {
    const x = envA[i] - meanA, y = envB[i] - meanB;
    envAA += x * x; envBB += y * y; envAB += x * y;
  }
  const count = frames * 2;
  const rmsA = Math.sqrt(aa / count), rmsB = Math.sqrt(bb / count);
  return {
    frames,
    referenceRmsDb: 20 * Math.log10(rmsA || 1e-12),
    offlineRmsDb: 20 * Math.log10(rmsB || 1e-12),
    levelDeltaDb: 20 * Math.log10((rmsB || 1e-12) / (rmsA || 1e-12)),
    referencePeakDb: 20 * Math.log10(peakA || 1e-12),
    offlinePeakDb: 20 * Math.log10(peakB || 1e-12),
    correlation: ab / Math.sqrt(aa * bb || 1),
    envelopeCorrelation20ms: envAB / Math.sqrt(envAA * envBB || 1),
    referenceBrightnessDb: 10 * Math.log10(diffA / (aa || 1)),
    offlineBrightnessDb: 10 * Math.log10(diffB / (bb || 1)),
    referenceStereoSideDb: 10 * Math.log10(sideA / (midA || 1)),
    offlineStereoSideDb: 10 * Math.log10(sideB / (midB || 1)),
    errorRmsDb: 20 * Math.log10(Math.sqrt(err / count) || 1e-12),
  };
}

async function browserRender(midi, duration) {
  const browser = await puppeteer.launch({
    headless: true, executablePath: chrome,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset=utf-8>');
    await page.addScriptTag({ path: path.join(ROOT, 'lib/vendor/webaudio-tinysynth.js') });
    const base64 = midi.toString('base64');
    return Buffer.from(await page.evaluate(async ({ base64, duration, rate }) => {
      let seed = 0x12345678;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
      const raw = atob(base64);
      const data = Uint8Array.from(raw, c => c.charCodeAt(0));
      const frames = Math.ceil(duration * rate);
      const context = new OfflineAudioContext(2, frames, rate);
      const synth = new WebAudioTinySynth({ quality: 1, internalcontext: 0, voices: 64 });
      synth.setAudioContext(context);
      synth.loadMIDI(data.buffer);
      let tempo = 120, tick = 0, time = 0;
      for (const event of synth.song.ev) {
        time += (event.t - tick) * 60 / (tempo * (synth.song.timebase / 4));
        tick = event.t;
        if (event.m[0] === 0xff51) tempo = event.m[1];
        else if (time < duration) synth.send(event.m, time);
      }
      const rendered = await context.startRendering();
      const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
      const pcm = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        pcm[i * 2] = Math.round(Math.max(-1, Math.min(1, left[i])) * 32767);
        pcm[i * 2 + 1] = Math.round(Math.max(-1, Math.min(1, right[i])) * 32767);
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      const stride = 0x8000;
      for (let i = 0; i < bytes.length; i += stride) {
        binary += String.fromCharCode(...bytes.subarray(i, i + stride));
      }
      return btoa(binary);
    }, { base64, duration, rate }), 'base64');
  } finally {
    await browser.close();
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const midi = fs.readFileSync(midiPath);
  const model = midiModel(midi);
  const duration = Math.min(seconds, model.duration);
  const clipped = { ...model, duration };

  let browserMs = null, reference = null;
  if (existingReference) {
    const wav = fs.readFileSync(path.resolve(existingReference));
    reference = splitPcm16(wav.subarray(44));
  } else if (!offlineOnly) {
    const t0 = performance.now();
    const referencePcm = await browserRender(midi, duration);
    browserMs = performance.now() - t0;
    reference = splitPcm16(referencePcm);
  }

  const t1 = performance.now();
  const offlineResult = renderTinySynthNotes(clipped, { sampleRate: rate, maxDuration: duration });
  const offlineMs = performance.now() - t1;
  const offline = splitPcm16(offlineResult.bytes);

  const referencePath = path.join(outDir, 'browser-webaudio-tinysynth.wav');
  const offlinePath = path.join(outDir, 'headless-offline-tinysynth.wav');
  if (reference) fs.writeFileSync(referencePath, wav16(reference[0], reference[1], rate));
  fs.writeFileSync(offlinePath, wav16(offline[0], offline[1], rate));
  const report = {
    midi: path.relative(ROOT, midiPath), duration, sampleRate: rate,
    renderer: path.relative(ROOT, rendererPath),
    notesInScore: model.notes.length,
    browserRenderMs: browserMs,
    offlineRenderMs: offlineMs,
    offlineRealtimeFactor: duration / (offlineMs / 1000),
    offline: {
      renderedNotes: offlineResult.renderedNotes,
      instruments: offlineResult.instruments,
      peak: offlineResult.peak,
    },
    audio: reference ? metrics(reference, offline) : null,
    artifacts: { referencePath: reference ? referencePath : null, offlinePath },
  };
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
